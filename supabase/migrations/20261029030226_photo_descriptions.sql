-- Check-in spots are gone from the app (Eric, 2026-10-28): each reference photo stands for its own
-- place and carries a short description of where it is. At check-in the user picks the photo they
-- are standing at, and the AI compares the new photo with that one photo only.
-- Also a second Telegram message at 45:25, when the break part ends.
--
-- The spot functions and the spots table stay until the next migration, so the app version still
-- deployed while this migration goes out keeps working. Drop them then.

alter table public.reference_photos
  add column description text check (description is null or char_length(description) between 1 and 60);
update public.reference_photos r set description = s.name from public.spots s where s.id = r.spot_id;
alter table public.reference_photos alter column spot_id drop not null;

-- Which reference photo a check-in was compared with.
alter table public.photo_attempts add column reference_id uuid references public.reference_photos (id) on delete set null;

-- When the "break is over" message went out.
alter table public.sessions add column ended_warned_at timestamptz;

-- Most photos one person can keep. Only the picked one goes to the AI, so this just keeps the
-- picker short.
create function public.be_max_references()
returns integer
language sql
immutable
set search_path = ''
as $$ select 12 $$;

-- Locked during a session like before: otherwise a photo of the couch added at 50:00 would pass.
create function public.be_add_reference_photo(p_user_id uuid, p_storage_path text, p_description text)
returns public.reference_photos
language plpgsql
set search_path = ''
as $$
declare
  d text := btrim(coalesce(p_description, ''));
  r public.reference_photos;
begin
  perform public.be_finalize_sessions();
  if exists (select 1 from public.sessions where user_id = p_user_id and status = 'active') then
    raise exception 'locked_during_session';
  end if;
  if char_length(d) not between 1 and 60 then
    raise exception 'bad_description';
  end if;
  if (select count(*) from public.reference_photos where user_id = p_user_id) >= public.be_max_references() then
    raise exception 'too_many_references';
  end if;
  insert into public.reference_photos (user_id, storage_path, description)
  values (p_user_id, p_storage_path, d)
  returning * into r;
  return r;
end;
$$;

-- Allowed during a session: the description is only a label for the user, the AI never sees it.
create function public.be_describe_reference(p_user_id uuid, p_reference_id uuid, p_description text)
returns public.reference_photos
language plpgsql
set search_path = ''
as $$
declare
  d text := btrim(coalesce(p_description, ''));
  r public.reference_photos;
begin
  if char_length(d) not between 1 and 60 then
    raise exception 'bad_description';
  end if;
  update public.reference_photos set description = d
  where id = p_reference_id and user_id = p_user_id
  returning * into r;
  if not found then
    raise exception 'reference_not_found';
  end if;
  return r;
end;
$$;

-- be_record_photo with a reference photo instead of a spot. The photo must be the user's own,
-- checked before the clock stops so a bad pick can't count as the first photo.
create function public.be_record_checkin(p_user_id uuid, p_session_id uuid, p_reference_id uuid, p_storage_path text, p_retake_seconds integer)
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
  if s.first_photo_at is null and now() > s.deadline_at then
    raise exception 'too_late';
  end if;
  if s.first_photo_at is not null and now() > s.retake_until then
    raise exception 'retake_over';
  end if;
  if not exists (select 1 from public.reference_photos where id = p_reference_id and user_id = p_user_id) then
    raise exception 'reference_not_found';
  end if;
  if s.first_photo_at is null then
    update public.sessions
    set first_photo_at = now(), retake_until = now() + make_interval(secs => p_retake_seconds)
    where id = s.id;
  end if;
  insert into public.photo_attempts (session_id, user_id, reference_id, storage_path)
  values (s.id, p_user_id, p_reference_id, p_storage_path)
  returning * into a;
  return a;
end;
$$;

-- Two messages per break now, each sent once, only while no photo is in:
--   40:00  the break ends in about 5 minutes
--   45:25  the break is over, photo due by 50:25
-- The minutes left in the second one are rounded down, so it never promises more time than there is.
create or replace function public.be_due_reminders()
returns table (chat_id bigint, message text)
language sql
set search_path = ''
as $$
  with soon as (
    update public.sessions s
    set warned_at = now()
    from public.telegram_links t
    where t.user_id = s.user_id
      and s.status = 'active'
      and s.warned_at is null
      and s.first_photo_at is null
      and now() >= s.relax_ends_at - public.be_reminder_lead()
      and now() < s.relax_ends_at
    returning t.chat_id, s.relax_ends_at, s.deadline_at
  ),
  ended as (
    update public.sessions s
    set ended_warned_at = now()
    from public.telegram_links t
    where t.user_id = s.user_id
      and s.status = 'active'
      and s.ended_warned_at is null
      and s.first_photo_at is null
      and now() >= s.relax_ends_at
      and now() < s.deadline_at
    returning t.chat_id, s.deadline_at
  )
  select
    soon.chat_id,
    format(
      'Your break ends in %s. Then you have %s to take your check-in photo. Head to your check-in spot.',
      public.be_minutes(soon.relax_ends_at - now()),
      public.be_minutes(soon.deadline_at - soon.relax_ends_at)
    )
  from soon
  union all
  select
    ended.chat_id,
    format(
      'Your break is over. Take your check-in photo in the next %s.',
      public.be_minutes(make_interval(mins => floor(extract(epoch from ended.deadline_at - now()) / 60)::integer))
    )
  from ended;
$$;

-- Server only, like the other be_* functions.
revoke execute on function
  public.be_max_references(),
  public.be_add_reference_photo(uuid, text, text),
  public.be_describe_reference(uuid, uuid, text),
  public.be_record_checkin(uuid, uuid, uuid, text, integer)
from public, anon, authenticated;
grant execute on function
  public.be_max_references(),
  public.be_add_reference_photo(uuid, text, text),
  public.be_describe_reference(uuid, uuid, text),
  public.be_record_checkin(uuid, uuid, uuid, text, integer)
to service_role;
