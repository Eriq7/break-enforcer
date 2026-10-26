-- Run: supabase db query --linked -f supabase/checks/logic.sql
-- Expect the error "LOGIC CHECK PASSED (rolled back)".
-- Walks the judging rules through the be_* functions as the server (service_role):
-- 50:25 deadline, first photo stops the clock, retakes, reference lock, overdue sessions failing.
-- now() is frozen inside one transaction, so the time-based cases use back-dated rows.
do $$
declare
  a uuid := gen_random_uuid();
  s public.sessions;
  att public.photo_attempts;
  ref public.reference_photos;
  n int;
  failed text := '';
begin
  select count(*) into n from cron.job where jobname = 'be-finalize-sessions' and schedule = '* * * * *';
  if n <> 1 then failed := failed || ' cron job missing;'; end if;

  insert into auth.users (id, email, aud, role) values (a, 'logic-a@example.invalid', 'authenticated', 'authenticated');
  execute 'set local role service_role';

  -- No reference photo yet: cannot start.
  begin
    perform public.be_start_session(a, 2725, 300);
    failed := failed || ' started without reference;';
  exception when others then
    if sqlerrm <> 'no_reference' then failed := failed || ' no_reference? ' || sqlerrm || ';'; end if;
  end;

  ref := public.be_add_reference(a, a || '/refs/1.jpg');
  s := public.be_start_session(a, 2725, 300);
  if s.relax_ends_at - s.started_at <> interval '45 minutes 25 seconds' then failed := failed || ' relax not 45:25;'; end if;
  if s.deadline_at - s.started_at <> interval '50 minutes 25 seconds' then failed := failed || ' deadline not 50:25;'; end if;
  if s.status <> 'active' then failed := failed || ' new session not active;'; end if;

  begin
    perform public.be_start_session(a, 2725, 300);
    failed := failed || ' second session started;';
  exception when others then
    if sqlerrm <> 'already_active' then failed := failed || ' already_active? ' || sqlerrm || ';'; end if;
  end;

  -- References are locked while a session runs.
  begin
    perform public.be_add_reference(a, a || '/refs/2.jpg');
    failed := failed || ' reference added during session;';
  exception when others then
    if sqlerrm <> 'locked_during_session' then failed := failed || ' lock(add)? ' || sqlerrm || ';'; end if;
  end;
  begin
    perform public.be_delete_reference(a, ref.id);
    failed := failed || ' reference deleted during session;';
  exception when others then
    if sqlerrm <> 'locked_during_session' then failed := failed || ' lock(delete)? ' || sqlerrm || ';'; end if;
  end;

  -- Finalize leaves a session that is still inside its time alone.
  perform public.be_finalize_sessions();
  select * into s from public.sessions where id = s.id;
  if s.status <> 'active' then failed := failed || ' finalize closed a running session;'; end if;

  -- First photo stops the clock. A failed verdict keeps the session open, a retake can pass.
  att := public.be_record_photo(a, s.id, a || '/attempts/1.jpg', 300);
  select * into s from public.sessions where id = s.id;
  if s.first_photo_at is null or s.retake_until - s.first_photo_at <> interval '5 minutes' then
    failed := failed || ' first photo did not stop the clock;';
  end if;
  s := public.be_record_verdict(att.id, 'fail', 'x', 'm', null);
  if s.status <> 'active' then failed := failed || ' fail verdict closed the session;'; end if;
  begin
    perform public.be_record_verdict(att.id, 'pass', 'x', 'm', null);
    failed := failed || ' verdict changed after the fact;';
  exception when others then
    if sqlerrm <> 'attempt_not_pending' then failed := failed || ' attempt_not_pending? ' || sqlerrm || ';'; end if;
  end;
  att := public.be_record_photo(a, s.id, a || '/attempts/2.jpg', 300);
  s := public.be_record_verdict(att.id, 'pass', 'ok', 'm', null);
  if s.status <> 'passed' or s.passed_at is null then failed := failed || ' pass verdict did not pass;'; end if;

  begin
    perform public.be_record_photo(a, s.id, a || '/attempts/3.jpg', 300);
    failed := failed || ' photo accepted after pass;';
  exception when others then
    if sqlerrm <> 'session_closed' then failed := failed || ' session_closed? ' || sqlerrm || ';'; end if;
  end;

  -- Unlocked again once nothing is running.
  perform public.be_add_reference(a, a || '/refs/2.jpg');
  if public.be_delete_reference(a, ref.id) <> a || '/refs/1.jpg' then failed := failed || ' delete returned wrong path;'; end if;

  -- Missed 50:25 without any photo: refused, and finalize fails it as no_photo.
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at)
  values (a, now() - interval '51 minutes', now() - interval '6 minutes', now() - interval '1 minute')
  returning * into s;
  begin
    perform public.be_record_photo(a, s.id, a || '/attempts/4.jpg', 300);
    failed := failed || ' photo after deadline accepted;';
  exception when others then
    if sqlerrm not in ('session_closed', 'too_late') then failed := failed || ' late photo? ' || sqlerrm || ';'; end if;
  end;
  perform public.be_finalize_sessions();
  select * into s from public.sessions where id = s.id;
  if s.status <> 'failed' or s.fail_reason is distinct from 'no_photo' then failed := failed || ' overdue session not failed as no_photo;'; end if;

  -- Retake window just closed, still inside the 2 minute slack: stays open, retakes refused.
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at, first_photo_at, retake_until)
  values (a, now() - interval '55 minutes', now() - interval '10 minutes', now() - interval '5 minutes',
          now() - interval '6 minutes', now() - interval '1 minute')
  returning * into s;
  perform public.be_finalize_sessions();
  select * into s from public.sessions where id = s.id;
  if s.status <> 'active' then failed := failed || ' closed inside the slack;'; end if;
  begin
    perform public.be_record_photo(a, s.id, a || '/attempts/5.jpg', 300);
    failed := failed || ' retake accepted after window;';
  exception when others then
    if sqlerrm <> 'retake_over' then failed := failed || ' retake_over? ' || sqlerrm || ';'; end if;
  end;

  -- Past the slack with no pass: fails as no_pass.
  update public.sessions set retake_until = now() - interval '3 minutes' where id = s.id;
  perform public.be_finalize_sessions();
  select * into s from public.sessions where id = s.id;
  if s.status <> 'failed' or s.fail_reason is distinct from 'no_pass' then failed := failed || ' no pass not failed as no_pass;'; end if;

  execute 'reset role';
  if failed = '' then
    raise exception 'LOGIC CHECK PASSED (rolled back)';
  else
    raise exception 'LOGIC CHECK FAILED:%', failed;
  end if;
end $$;
