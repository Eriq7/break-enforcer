-- Run: supabase db query --linked -f supabase/checks/logic.sql
-- Expect the error "LOGIC CHECK PASSED (rolled back)".
-- Walks the judging rules through the be_* functions as the server (service_role):
-- 50:25 deadline, first photo stops the clock, retakes, reference lock, overdue sessions failing,
-- check-in spots (each has its own photos, a check-in names the spot it is compared with),
-- and Telegram: link codes, and the reminder at 40:00 going out once to the right breaks.
-- now() is frozen inside one transaction, so the time-based cases use back-dated rows.
do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  sp public.spots;
  empty_spot public.spots;
  other_spot public.spots;
  paths text[];
  r record;
  msg text;
  s public.sessions;
  att public.photo_attempts;
  ref public.reference_photos;
  n int;
  failed text := '';
begin
  select count(*) into n from cron.job where jobname = 'be-finalize-sessions' and schedule = '* * * * *';
  if n <> 1 then failed := failed || ' cron job missing;'; end if;

  insert into auth.users (id, email, aud, role) values
    (a, 'logic-a@example.invalid', 'authenticated', 'authenticated'),
    (b, 'logic-b@example.invalid', 'authenticated', 'authenticated');
  execute 'set local role service_role';

  -- No reference photo yet: cannot start.
  begin
    perform public.be_start_session(a, 2725, 300);
    failed := failed || ' started without reference;';
  exception when others then
    if sqlerrm <> 'no_reference' then failed := failed || ' no_reference? ' || sqlerrm || ';'; end if;
  end;

  -- Spots: photos go into one of your own spots, at most 6 each.
  sp := public.be_add_spot(a, '  7th floor room  ');
  if sp.name <> '7th floor room' then failed := failed || ' spot name not trimmed;'; end if;
  empty_spot := public.be_add_spot(a, 'Other home');
  other_spot := public.be_add_spot(b, 'B room');
  perform public.be_add_reference(b, other_spot.id, b || '/refs/b.jpg');
  begin
    perform public.be_add_reference(a, other_spot.id, a || '/refs/x.jpg');
    failed := failed || ' photo added to someone else''s spot;';
  exception when others then
    if sqlerrm <> 'spot_not_found' then failed := failed || ' spot_not_found(add)? ' || sqlerrm || ';'; end if;
  end;

  -- An empty spot is not enough to start.
  begin
    perform public.be_start_session(a, 2725, 300);
    failed := failed || ' started with only an empty spot;';
  exception when others then
    if sqlerrm <> 'no_reference' then failed := failed || ' no_reference(empty spot)? ' || sqlerrm || ';'; end if;
  end;

  ref := public.be_add_reference(a, sp.id, a || '/refs/1.jpg');
  if ref.spot_id <> sp.id then failed := failed || ' photo not in its spot;'; end if;
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

  -- References and spots are locked while a session runs.
  begin
    perform public.be_add_reference(a, sp.id, a || '/refs/2.jpg');
    failed := failed || ' reference added during session;';
  exception when others then
    if sqlerrm <> 'locked_during_session' then failed := failed || ' lock(add)? ' || sqlerrm || ';'; end if;
  end;
  begin
    perform public.be_add_spot(a, 'Couch');
    failed := failed || ' spot added during session;';
  exception when others then
    if sqlerrm <> 'locked_during_session' then failed := failed || ' lock(add spot)? ' || sqlerrm || ';'; end if;
  end;
  begin
    perform public.be_delete_spot(a, empty_spot.id);
    failed := failed || ' spot deleted during session;';
  exception when others then
    if sqlerrm <> 'locked_during_session' then failed := failed || ' lock(delete spot)? ' || sqlerrm || ';'; end if;
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

  -- A spot with no photos, or someone else's, is refused before the clock stops.
  begin
    perform public.be_record_photo(a, s.id, empty_spot.id, a || '/attempts/e.jpg', 300);
    failed := failed || ' check-in at an empty spot;';
  exception when others then
    if sqlerrm <> 'spot_empty' then failed := failed || ' spot_empty? ' || sqlerrm || ';'; end if;
  end;
  begin
    perform public.be_record_photo(a, s.id, other_spot.id, a || '/attempts/o.jpg', 300);
    failed := failed || ' check-in at someone else''s spot;';
  exception when others then
    if sqlerrm <> 'spot_empty' then failed := failed || ' spot_empty(other)? ' || sqlerrm || ';'; end if;
  end;
  select * into s from public.sessions where id = s.id;
  if s.first_photo_at is not null then failed := failed || ' refused spot stopped the clock;'; end if;

  -- First photo stops the clock. A failed verdict keeps the session open, a retake can pass.
  att := public.be_record_photo(a, s.id, sp.id, a || '/attempts/1.jpg', 300);
  if att.spot_id <> sp.id then failed := failed || ' attempt does not name its spot;'; end if;
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
  att := public.be_record_photo(a, s.id, sp.id, a || '/attempts/2.jpg', 300);
  s := public.be_record_verdict(att.id, 'pass', 'ok', 'm', null);
  if s.status <> 'passed' or s.passed_at is null then failed := failed || ' pass verdict did not pass;'; end if;

  begin
    perform public.be_record_photo(a, s.id, sp.id, a || '/attempts/3.jpg', 300);
    failed := failed || ' photo accepted after pass;';
  exception when others then
    if sqlerrm <> 'session_closed' then failed := failed || ' session_closed? ' || sqlerrm || ';'; end if;
  end;

  -- Unlocked again once nothing is running.
  perform public.be_add_reference(a, sp.id, a || '/refs/2.jpg');
  if public.be_delete_reference(a, ref.id) <> a || '/refs/1.jpg' then failed := failed || ' delete returned wrong path;'; end if;

  -- The 6 photo limit is per spot.
  for i in 3..7 loop
    perform public.be_add_reference(a, sp.id, a || '/refs/' || i || '.jpg');
  end loop;
  begin
    perform public.be_add_reference(a, sp.id, a || '/refs/8.jpg');
    failed := failed || ' 7th photo in one spot;';
  exception when others then
    if sqlerrm <> 'too_many_references' then failed := failed || ' too_many_references? ' || sqlerrm || ';'; end if;
  end;
  perform public.be_add_reference(a, empty_spot.id, a || '/refs/e1.jpg');

  -- Deleting a spot deletes its photos and returns their paths. Not someone else's spot.
  paths := public.be_delete_spot(a, empty_spot.id);
  if paths <> array[a || '/refs/e1.jpg'] then failed := failed || ' delete spot returned wrong paths;'; end if;
  select count(*) into n from public.reference_photos where spot_id = empty_spot.id;
  if n <> 0 then failed := failed || ' spot photos left after delete;'; end if;
  begin
    perform public.be_delete_spot(a, other_spot.id);
    failed := failed || ' deleted someone else''s spot;';
  exception when others then
    if sqlerrm <> 'spot_not_found' then failed := failed || ' spot_not_found(delete)? ' || sqlerrm || ';'; end if;
  end;

  -- Missed 50:25 without any photo: refused, and finalize fails it as no_photo.
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at)
  values (a, now() - interval '51 minutes', now() - interval '6 minutes', now() - interval '1 minute')
  returning * into s;
  begin
    perform public.be_record_photo(a, s.id, sp.id, a || '/attempts/4.jpg', 300);
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
    perform public.be_record_photo(a, s.id, sp.id, a || '/attempts/5.jpg', 300);
    failed := failed || ' retake accepted after window;';
  exception when others then
    if sqlerrm <> 'retake_over' then failed := failed || ' retake_over? ' || sqlerrm || ';'; end if;
  end;

  -- Past the slack with no pass: fails as no_pass.
  update public.sessions set retake_until = now() - interval '3 minutes' where id = s.id;
  perform public.be_finalize_sessions();
  select * into s from public.sessions where id = s.id;
  if s.status <> 'failed' or s.fail_reason is distinct from 'no_pass' then failed := failed || ' no pass not failed as no_pass;'; end if;

  -- Telegram link codes: a new code replaces the old one, works once, and not after it expires.
  -- The bot set here is fake and rolled back with everything else.
  perform public.be_set_telegram_bot('123:check-token', 'check_bot');
  if public.be_telegram_code(a, 'code-a-1') <> 'check_bot' then failed := failed || ' code did not return the bot;'; end if;
  perform public.be_telegram_code(a, 'code-a-2');
  if public.be_telegram_link('code-a-1', 111) is not null then failed := failed || ' replaced code still works;'; end if;
  if public.be_telegram_link('code-a-2', 111) is distinct from a then failed := failed || ' code did not link;'; end if;
  if public.be_telegram_link('code-a-2', 222) is not null then failed := failed || ' code worked twice;'; end if;
  insert into public.telegram_codes (code, user_id, expires_at) values ('code-old', a, now() - interval '1 second');
  if public.be_telegram_link('code-old', 222) is not null then failed := failed || ' expired code worked;'; end if;
  select count(*) into n from public.telegram_links where user_id = a and chat_id = 111;
  if n <> 1 then failed := failed || ' link not saved;'; end if;

  -- Reminder: inside the last 5:25 of a running break with no photo, once.
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at)
  values (a, now() - interval '41 minutes', now() + interval '4 minutes 25 seconds', now() + interval '9 minutes 25 seconds')
  returning * into s;
  n := 0;
  for r in select * from public.be_due_reminders() loop
    if r.chat_id = 111 then n := n + 1; msg := r.message; end if;
  end loop;
  if n <> 1 then failed := failed || ' due reminder not sent once;'; end if;
  if msg is distinct from 'Your break ends in 4 minutes. Then you have 5 minutes to take your check-in photo. Head to your check-in spot.' then
    failed := failed || ' reminder text: ' || coalesce(msg, 'none') || ';';
  end if;
  select count(*) into n from public.be_due_reminders() where chat_id = 111;
  if n <> 0 then failed := failed || ' reminded twice;'; end if;

  -- Not yet due, photo already in, break already over: no reminder.
  update public.sessions set status = 'passed' where id = s.id;
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at)
  values (a, now() - interval '39 minutes', now() + interval '6 minutes', now() + interval '11 minutes') returning * into s;
  select count(*) into n from public.be_due_reminders() where chat_id = 111;
  if n <> 0 then failed := failed || ' reminded too early;'; end if;
  update public.sessions set status = 'passed' where id = s.id;
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at, first_photo_at, retake_until)
  values (a, now() - interval '42 minutes', now() + interval '3 minutes', now() + interval '8 minutes', now(), now() + interval '5 minutes') returning * into s;
  select count(*) into n from public.be_due_reminders() where chat_id = 111;
  if n <> 0 then failed := failed || ' reminded after a photo;'; end if;
  update public.sessions set status = 'passed' where id = s.id;
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at)
  values (a, now() - interval '46 minutes', now() - interval '1 minute', now() + interval '4 minutes') returning * into s;
  select count(*) into n from public.be_due_reminders() where chat_id = 111;
  if n <> 0 then failed := failed || ' reminded after the break;'; end if;
  update public.sessions set status = 'passed' where id = s.id;

  -- No Telegram linked: nothing to send, and the break stays unmarked.
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at)
  values (b, now() - interval '41 minutes', now() + interval '4 minutes', now() + interval '9 minutes') returning * into s;
  perform public.be_due_reminders();
  select * into s from public.sessions where id = s.id;
  if s.warned_at is not null then failed := failed || ' marked a break with no Telegram;'; end if;
  update public.sessions set status = 'passed' where id = s.id;

  -- The sender queues one Telegram request per due break (never sent: all of this rolls back).
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at)
  values (a, now() - interval '41 minutes', now() + interval '4 minutes', now() + interval '9 minutes') returning * into s;
  if public.be_send_reminders() < 1 then failed := failed || ' sender sent nothing;'; end if;
  select * into s from public.sessions where id = s.id;
  if s.warned_at is null then failed := failed || ' sender did not mark the break;'; end if;

  execute 'reset role';
  if failed = '' then
    raise exception 'LOGIC CHECK PASSED (rolled back)';
  else
    raise exception 'LOGIC CHECK FAILED:%', failed;
  end if;
end $$;
