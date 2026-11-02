-- The clock stops when the shutter is pressed, not when the photo has finished uploading.
-- The app calls this the moment the user shoots; be_record_checkin then accepts the upload
-- inside the retake window, however long the upload and the AI check take.
-- Only the first call does anything. It records no attempt, so a shutter press with no upload
-- ends as a plain failed break (no_pass) once the retake window is over.
create function public.be_stop_clock(p_user_id uuid, p_session_id uuid, p_retake_seconds integer)
returns public.sessions
language plpgsql
set search_path = ''
as $$
declare
  s public.sessions;
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
    where id = s.id
    returning * into s;
  end if;
  return s;
end;
$$;

-- Server only, like the other be_* functions.
revoke execute on function public.be_stop_clock(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.be_stop_clock(uuid, uuid, integer) to service_role;
