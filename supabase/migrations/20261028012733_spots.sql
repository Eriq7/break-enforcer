-- Check-in spots. One person can have several places to walk to, say a study room at each of
-- two homes. Each spot keeps its own reference photos. At check-in the user picks the spot they
-- are at, and the AI compares the new photo with that spot's photos only.

create table public.spots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now()
);

create index spots_user on public.spots (user_id, created_at);

alter table public.spots enable row level security;
create policy "read own spots" on public.spots
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.spots from anon, authenticated;
grant select on public.spots to authenticated;
grant all on public.spots to service_role;

-- Photos saved before spots existed go into one spot per person.
alter table public.reference_photos add column spot_id uuid references public.spots (id) on delete cascade;
insert into public.spots (user_id, name)
select distinct user_id, 'Check-in spot' from public.reference_photos;
update public.reference_photos r set spot_id = s.id from public.spots s where s.user_id = r.user_id;
alter table public.reference_photos alter column spot_id set not null;
create index reference_photos_spot on public.reference_photos (spot_id, created_at);

-- Which spot a check-in photo was compared with. Empty for photos from before spots.
alter table public.photo_attempts add column spot_id uuid references public.spots (id) on delete set null;

-- Spots are locked during a session, like their photos: otherwise a new spot holding a photo
-- of the couch would pass at 50:00.
create function public.be_add_spot(p_user_id uuid, p_name text)
returns public.spots
language plpgsql
set search_path = ''
as $$
declare
  s public.spots;
begin
  perform public.be_finalize_sessions();
  if exists (select 1 from public.sessions where user_id = p_user_id and status = 'active') then
    raise exception 'locked_during_session';
  end if;
  insert into public.spots (user_id, name)
  values (p_user_id, btrim(p_name))
  returning * into s;
  return s;
end;
$$;

-- Deletes the spot and its photos. Returns the photos' storage paths so the server can delete the files too.
create function public.be_delete_spot(p_user_id uuid, p_spot_id uuid)
returns text[]
language plpgsql
set search_path = ''
as $$
declare
  paths text[];
begin
  perform public.be_finalize_sessions();
  if exists (select 1 from public.sessions where user_id = p_user_id and status = 'active') then
    raise exception 'locked_during_session';
  end if;
  select coalesce(array_agg(r.storage_path), '{}') into paths
  from public.reference_photos r where r.spot_id = p_spot_id and r.user_id = p_user_id;
  delete from public.spots where id = p_spot_id and user_id = p_user_id;
  if not found then
    raise exception 'spot_not_found';
  end if;
  return paths;
end;
$$;

-- The photo limit is per spot now: each check-in sends all of one spot's photos to the AI.
drop function public.be_add_reference(uuid, text);
create function public.be_add_reference(p_user_id uuid, p_spot_id uuid, p_storage_path text)
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
  if not exists (select 1 from public.spots where id = p_spot_id and user_id = p_user_id) then
    raise exception 'spot_not_found';
  end if;
  if (select count(*) from public.reference_photos where spot_id = p_spot_id) >= 6 then
    raise exception 'too_many_references';
  end if;
  insert into public.reference_photos (user_id, spot_id, storage_path)
  values (p_user_id, p_spot_id, p_storage_path)
  returning * into r;
  return r;
end;
$$;

-- Same rules as before, plus the spot: it must be the user's own and have at least one photo,
-- checked before the clock stops so a bad pick can't count as the first photo.
drop function public.be_record_photo(uuid, uuid, text, integer);
create function public.be_record_photo(p_user_id uuid, p_session_id uuid, p_spot_id uuid, p_storage_path text, p_retake_seconds integer)
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
  if not exists (
    select 1 from public.reference_photos r
    join public.spots p on p.id = r.spot_id
    where p.id = p_spot_id and p.user_id = p_user_id
  ) then
    raise exception 'spot_empty';
  end if;
  if s.first_photo_at is null then
    update public.sessions
    set first_photo_at = now(), retake_until = now() + make_interval(secs => p_retake_seconds)
    where id = s.id;
  end if;
  insert into public.photo_attempts (session_id, user_id, spot_id, storage_path)
  values (s.id, p_user_id, p_spot_id, p_storage_path)
  returning * into a;
  return a;
end;
$$;

-- Server only, like the other be_* functions.
revoke execute on function
  public.be_add_spot(uuid, text),
  public.be_delete_spot(uuid, uuid),
  public.be_add_reference(uuid, uuid, text),
  public.be_record_photo(uuid, uuid, uuid, text, integer)
from public, anon, authenticated;
grant execute on function
  public.be_add_spot(uuid, text),
  public.be_delete_spot(uuid, uuid),
  public.be_add_reference(uuid, uuid, text),
  public.be_record_photo(uuid, uuid, uuid, text, integer)
to service_role;
