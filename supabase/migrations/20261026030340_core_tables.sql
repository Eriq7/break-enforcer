-- Break Enforcer core data: reference photos, relax sessions, check-in photo attempts.
--
-- Judging happens on the server, never on the phone. The browser can only read its own rows;
-- every write goes through the API (api/, lib/), which calls the be_* functions below with the
-- secret key. The functions use the database clock, so the phone's clock can't move a deadline.

-- Photos of the fixed scene on the 7th floor. Picking one from the album is fine here:
-- the cheating risk is at check-in, not when registering the scene.
create table public.reference_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  storage_path text not null unique,
  created_at timestamptz not null default now()
);

create index reference_photos_user on public.reference_photos (user_id, created_at);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  started_at timestamptz not null default now(),
  -- 45:25 after the start. Then the 5:00 buffer runs: time to get down to the 7th floor.
  relax_ends_at timestamptz not null,
  -- 50:25 after the start. The first photo has to be submitted before this.
  deadline_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'passed', 'failed')),
  -- The first submitted photo stops the clock, whatever the AI says about it.
  first_photo_at timestamptz,
  -- Retakes are allowed until this, so a wrong AI rejection can still be fixed.
  retake_until timestamptz,
  passed_at timestamptz,
  finalized_at timestamptz,
  fail_reason text check (fail_reason in ('no_photo', 'no_pass')),
  check (relax_ends_at > started_at and deadline_at > relax_ends_at)
);

-- At most one running session per person.
create unique index sessions_one_active on public.sessions (user_id) where status = 'active';
create index sessions_user_started on public.sessions (user_id, started_at desc);

create table public.photo_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  storage_path text not null unique,
  submitted_at timestamptz not null default now(),
  verdict text not null default 'pending' check (verdict in ('pending', 'pass', 'fail', 'error')),
  -- Shown to the user, in Chinese.
  reason text,
  model text,
  ai_result jsonb,
  decided_at timestamptz
);

create index photo_attempts_session on public.photo_attempts (session_id, submitted_at);

alter table public.reference_photos enable row level security;
alter table public.sessions enable row level security;
alter table public.photo_attempts enable row level security;

create policy "read own reference photos" on public.reference_photos
  for select to authenticated using (user_id = (select auth.uid()));
create policy "read own sessions" on public.sessions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "read own photo attempts" on public.photo_attempts
  for select to authenticated using (user_id = (select auth.uid()));

-- Spell out table privileges instead of relying on the project's defaults.
-- Read only for the browser; the server's secret key acts as service_role.
revoke all on public.reference_photos, public.sessions, public.photo_attempts from anon, authenticated;
grant select on public.reference_photos, public.sessions, public.photo_attempts to authenticated;
grant all on public.reference_photos, public.sessions, public.photo_attempts to service_role;

-- Private bucket with no storage policies: only the server can read or write.
-- The app shows photos through short-lived signed URLs from the API.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg']);

-- Closes every overdue session. The API calls it before reading or writing,
-- and pg_cron calls it every minute so a session fails on time even if nobody opens the app.
create function public.be_finalize_sessions()
returns integer
language sql
set search_path = ''
as $$
  with closed as (
    update public.sessions s
    set status = 'failed',
        finalized_at = now(),
        fail_reason = case when s.first_photo_at is null then 'no_photo' else 'no_pass' end
    where s.status = 'active'
      and (
        (s.first_photo_at is null and now() > s.deadline_at)
        -- 2 minutes of slack so an AI call that started inside the retake window can still land.
        or (s.first_photo_at is not null and now() > s.retake_until + interval '2 minutes')
      )
    returning 1
  )
  select count(*)::integer from closed;
$$;

create function public.be_start_session(p_user_id uuid, p_relax_seconds integer, p_buffer_seconds integer)
returns public.sessions
language plpgsql
set search_path = ''
as $$
declare
  s public.sessions;
begin
  perform public.be_finalize_sessions();
  if not exists (select 1 from public.reference_photos where user_id = p_user_id) then
    raise exception 'no_reference';
  end if;
  begin
    insert into public.sessions (user_id, relax_ends_at, deadline_at)
    values (
      p_user_id,
      now() + make_interval(secs => p_relax_seconds),
      now() + make_interval(secs => p_relax_seconds + p_buffer_seconds)
    )
    returning * into s;
  exception when unique_violation then
    raise exception 'already_active';
  end;
  return s;
end;
$$;

-- Records a check-in photo before it is uploaded or judged. The first one stops the clock.
create function public.be_record_photo(p_user_id uuid, p_session_id uuid, p_storage_path text, p_retake_seconds integer)
returns public.photo_attempts
language plpgsql
set search_path = ''
as $$
declare
  s public.sessions;
  a public.photo_attempts;
begin
  perform public.be_finalize_sessions();
  select * into s from public.sessions
  where id = p_session_id and user_id = p_user_id
  for update;
  if not found then
    raise exception 'session_not_found';
  end if;
  if s.status <> 'active' then
    raise exception 'session_closed';
  end if;
  if s.first_photo_at is null then
    if now() > s.deadline_at then
      raise exception 'too_late';
    end if;
    update public.sessions
    set first_photo_at = now(), retake_until = now() + make_interval(secs => p_retake_seconds)
    where id = s.id;
  elsif now() > s.retake_until then
    raise exception 'retake_over';
  end if;
  insert into public.photo_attempts (session_id, user_id, storage_path)
  values (s.id, p_user_id, p_storage_path)
  returning * into a;
  return a;
end;
$$;

-- Stores the AI's answer. A pass ends the session as passed.
create function public.be_record_verdict(p_attempt_id uuid, p_verdict text, p_reason text, p_model text, p_result jsonb)
returns public.sessions
language plpgsql
set search_path = ''
as $$
declare
  a public.photo_attempts;
  s public.sessions;
begin
  update public.photo_attempts
  set verdict = p_verdict, reason = p_reason, model = p_model, ai_result = p_result, decided_at = now()
  where id = p_attempt_id and verdict = 'pending'
  returning * into a;
  if not found then
    raise exception 'attempt_not_pending';
  end if;
  if p_verdict = 'pass' then
    update public.sessions
    set status = 'passed', passed_at = now(), finalized_at = now()
    where id = a.session_id and status = 'active';
  end if;
  select * into s from public.sessions where id = a.session_id;
  return s;
end;
$$;

-- Reference photos are locked while a session runs. Otherwise swapping the reference for
-- a photo of the couch at 50:00 would be cheaper than walking down three floors.
create function public.be_add_reference(p_user_id uuid, p_storage_path text)
returns public.reference_photos
language plpgsql
set search_path = ''
as $$
declare
  r public.reference_photos;
begin
  perform public.be_finalize_sessions();
  if exists (select 1 from public.sessions where user_id = p_user_id and status = 'active') then
    raise exception 'locked_during_session';
  end if;
  if (select count(*) from public.reference_photos where user_id = p_user_id) >= 6 then
    raise exception 'too_many_references';
  end if;
  insert into public.reference_photos (user_id, storage_path)
  values (p_user_id, p_storage_path)
  returning * into r;
  return r;
end;
$$;

-- Returns the storage path so the server can delete the file too.
create function public.be_delete_reference(p_user_id uuid, p_reference_id uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  path text;
begin
  perform public.be_finalize_sessions();
  if exists (select 1 from public.sessions where user_id = p_user_id and status = 'active') then
    raise exception 'locked_during_session';
  end if;
  delete from public.reference_photos
  where id = p_reference_id and user_id = p_user_id
  returning storage_path into path;
  if not found then
    raise exception 'reference_not_found';
  end if;
  return path;
end;
$$;

-- Server only. Without this the browser could call them through the API with its own login.
revoke execute on function
  public.be_finalize_sessions(),
  public.be_start_session(uuid, integer, integer),
  public.be_record_photo(uuid, uuid, text, integer),
  public.be_record_verdict(uuid, text, text, text, jsonb),
  public.be_add_reference(uuid, text),
  public.be_delete_reference(uuid, uuid)
from public, anon, authenticated;
grant execute on function
  public.be_finalize_sessions(),
  public.be_start_session(uuid, integer, integer),
  public.be_record_photo(uuid, uuid, text, integer),
  public.be_record_verdict(uuid, text, text, text, jsonb),
  public.be_add_reference(uuid, text),
  public.be_delete_reference(uuid, uuid)
to service_role;

create extension if not exists pg_cron;
select cron.schedule('be-finalize-sessions', '* * * * *', 'select public.be_finalize_sessions()');
