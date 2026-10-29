-- Run: supabase db query --linked -f supabase/checks/logic.sql
-- Expect the error "LOGIC CHECK PASSED (rolled back)".
-- Walks the judging rules through the be_* functions as the server (service_role):
-- 50:25 deadline, first photo stops the clock, retakes, reference lock, overdue sessions failing,
-- check-in spots (each has its own photos, a check-in names the spot it is compared with),
-- reference photos with descriptions (a check-in names the one photo it is compared with),
-- Telegram: link codes, and the reminders at 40:00 and 45:25 going out once to the right breaks,
-- and payments: a card is needed to start, the card is locked while a break runs or waits to be
-- charged, failed breaks (only those) become due, claims, charge rows, and holds coming due.
-- now() is frozen inside one transaction, so the time-based cases use back-dated rows.
do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  d uuid := gen_random_uuid();
  sp public.spots;
  csp public.spots;
  empty_spot public.spots;
  other_spot public.spots;
  paths text[];
  r record;
  msg text;
  s public.sessions;
  s2 public.sessions;
  ch public.charges;
  att public.photo_attempts;
  ref public.reference_photos;
  dref public.reference_photos;
  n int;
  failed text := '';
begin
  select count(*) into n from cron.job where jobname = 'be-finalize-sessions' and schedule = '* * * * *';
  if n <> 1 then failed := failed || ' cron job missing;'; end if;
  select count(*) into n from cron.job where jobname = 'be-billing' and schedule = '* * * * *';
  if n <> 1 then failed := failed || ' billing cron job missing;'; end if;

  insert into auth.users (id, email, aud, role) values
    (a, 'logic-a@example.invalid', 'authenticated', 'authenticated'),
    (b, 'logic-b@example.invalid', 'authenticated', 'authenticated'),
    (c, 'logic-c@example.invalid', 'authenticated', 'authenticated'),
    (d, 'logic-d@example.invalid', 'authenticated', 'authenticated');
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

  -- The AI never answered the last photo: excused, not failed. A real "no" last is still a fail.
  for i in 1..4 loop
    insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at, first_photo_at, retake_until)
    values (a, now() - interval '55 minutes', now() - interval '10 minutes', now() - interval '5 minutes',
            now() - interval '6 minutes', now() - interval '3 minutes')
    returning * into s;
    insert into public.photo_attempts (session_id, user_id, storage_path, submitted_at, verdict)
    values (s.id, a, a || '/attempts/x' || i || 'a.jpg', now() - interval '6 minutes',
            (array['error', 'error', 'fail', 'error'])[i]);
    insert into public.photo_attempts (session_id, user_id, storage_path, submitted_at, verdict)
    values (s.id, a, a || '/attempts/x' || i || 'b.jpg', now() - interval '4 minutes',
            (array['error', 'pending', 'error', 'fail'])[i]);
    perform public.be_finalize_sessions();
    select * into s from public.sessions where id = s.id;
    if i < 4 and (s.status <> 'excused' or s.fail_reason is not null) then
      failed := failed || ' last photo unanswered (case ' || i || ') not excused: ' || s.status || ';';
    end if;
    if i = 4 and (s.status <> 'failed' or s.fail_reason is distinct from 'no_pass') then
      failed := failed || ' AI said no last, but not failed;';
    end if;
  end loop;

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

  -- Break over, photo not in yet: the second message, once, with the minutes rounded down.
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at, warned_at)
  values (a, now() - interval '46 minutes', now() - interval '25 seconds', now() + interval '4 minutes 35 seconds', now() - interval '6 minutes') returning * into s;
  n := 0;
  msg := null;
  for r in select * from public.be_due_reminders() loop
    if r.chat_id = 111 then n := n + 1; msg := r.message; end if;
  end loop;
  if n <> 1 then failed := failed || ' break-over message not sent once;'; end if;
  if msg is distinct from 'Your break is over. Take your check-in photo in the next 4 minutes.' then
    failed := failed || ' break-over text: ' || coalesce(msg, 'none') || ';';
  end if;
  select count(*) into n from public.be_due_reminders() where chat_id = 111;
  if n <> 0 then failed := failed || ' break-over message sent twice;'; end if;
  update public.sessions set status = 'passed' where id = s.id;

  -- Past 50:25, or the photo already in: no break-over message.
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at)
  values (a, now() - interval '51 minutes', now() - interval '6 minutes', now() - interval '1 minute') returning * into s;
  select count(*) into n from public.be_due_reminders() where chat_id = 111;
  if n <> 0 then failed := failed || ' break-over message after the deadline;'; end if;
  update public.sessions set status = 'passed' where id = s.id;
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at, first_photo_at, retake_until)
  values (a, now() - interval '47 minutes', now() - interval '2 minutes', now() + interval '3 minutes', now(), now() + interval '150 seconds') returning * into s;
  select count(*) into n from public.be_due_reminders() where chat_id = 111;
  if n <> 0 then failed := failed || ' break-over message after a photo;'; end if;
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

  -- Reference photos with descriptions. The description is trimmed and required.
  dref := public.be_add_reference_photo(d, d || '/refs/p1.jpg', '  7th floor room  ');
  if dref.description <> '7th floor room' or dref.spot_id is not null then failed := failed || ' photo description not saved;'; end if;
  begin
    perform public.be_add_reference_photo(d, d || '/refs/p0.jpg', '   ');
    failed := failed || ' photo saved with no description;';
  exception when others then
    if sqlerrm <> 'bad_description' then failed := failed || ' bad_description? ' || sqlerrm || ';'; end if;
  end;
  begin
    perform public.be_describe_reference(d, dref.id, repeat('x', 61));
    failed := failed || ' 61 character description;';
  exception when others then
    if sqlerrm <> 'bad_description' then failed := failed || ' bad_description(long)? ' || sqlerrm || ';'; end if;
  end;
  select * into ref from public.reference_photos where user_id = b limit 1;
  begin
    perform public.be_describe_reference(d, ref.id, 'mine now');
    failed := failed || ' described someone else''s photo;';
  exception when others then
    if sqlerrm <> 'reference_not_found' then failed := failed || ' reference_not_found(describe)? ' || sqlerrm || ';'; end if;
  end;

  -- During a break: no new photos, but the description can change.
  s := public.be_start_session(d, 2725, 300);
  begin
    perform public.be_add_reference_photo(d, d || '/refs/couch.jpg', 'Couch');
    failed := failed || ' photo added during session;';
  exception when others then
    if sqlerrm <> 'locked_during_session' then failed := failed || ' lock(add photo)? ' || sqlerrm || ';'; end if;
  end;
  dref := public.be_describe_reference(d, dref.id, 'Amenity room');
  if dref.description <> 'Amenity room' then failed := failed || ' description not changed during session;'; end if;

  -- A check-in names one of your own photos. Someone else's is refused before the clock stops.
  begin
    perform public.be_record_checkin(d, s.id, ref.id, d || '/attempts/x.jpg', 150);
    failed := failed || ' check-in against someone else''s photo;';
  exception when others then
    if sqlerrm <> 'reference_not_found' then failed := failed || ' reference_not_found(checkin)? ' || sqlerrm || ';'; end if;
  end;
  select * into s from public.sessions where id = s.id;
  if s.first_photo_at is not null then failed := failed || ' refused photo stopped the clock;'; end if;
  att := public.be_record_checkin(d, s.id, dref.id, d || '/attempts/1.jpg', 150);
  if att.reference_id is distinct from dref.id then failed := failed || ' attempt does not name its photo;'; end if;
  select * into s from public.sessions where id = s.id;
  if s.first_photo_at is null or s.retake_until - s.first_photo_at <> interval '150 seconds' then
    failed := failed || ' check-in did not stop the clock;';
  end if;
  update public.sessions set status = 'passed' where id = s.id;

  -- At most 12 photos per person.
  for i in 2..12 loop
    perform public.be_add_reference_photo(d, d || '/refs/p' || i || '.jpg', 'Spot ' || i);
  end loop;
  begin
    perform public.be_add_reference_photo(d, d || '/refs/p13.jpg', 'One too many');
    failed := failed || ' 13th photo;';
  exception when others then
    if sqlerrm <> 'too_many_references' then failed := failed || ' too_many_references(photos)? ' || sqlerrm || ';'; end if;
  end;

  -- Payments. Starting needs a saved card in the server's Stripe mode; a customer alone isn't one.
  csp := public.be_add_spot(c, 'C room');
  perform public.be_add_reference(c, csp.id, c || '/refs/c.jpg');
  begin
    perform public.be_start_session(c, 2725, 300, 'test');
    failed := failed || ' started without a card;';
  exception when others then
    if sqlerrm <> 'no_card' then failed := failed || ' no_card? ' || sqlerrm || ';'; end if;
  end;
  if public.be_save_customer(c, false, 'cus_first') <> 'cus_first' then failed := failed || ' customer not saved;'; end if;
  if public.be_save_customer(c, false, 'cus_second') <> 'cus_first' then failed := failed || ' second customer replaced the first;'; end if;
  begin
    perform public.be_start_session(c, 2725, 300, 'test');
    failed := failed || ' started with a customer but no card;';
  exception when others then
    if sqlerrm <> 'no_card' then failed := failed || ' no_card(customer only)? ' || sqlerrm || ';'; end if;
  end;
  begin
    perform public.be_save_card(c, false, 'cus_other', 'pm_x', 'visa', '4242', 'debit', 12, 2030);
    failed := failed || ' card saved under another customer;';
  exception when others then
    if sqlerrm <> 'card_not_found' then failed := failed || ' card_not_found? ' || sqlerrm || ';'; end if;
  end;
  if public.be_save_card(c, false, 'cus_first', 'pm_1', 'visa', '4242', 'debit', 12, 2030) is not null then
    failed := failed || ' first card returned an old one;';
  end if;

  -- A test mode card doesn't start a live break, and a break must have a mode.
  begin
    perform public.be_start_session(c, 2725, 300, 'live');
    failed := failed || ' live break on a test card;';
  exception when others then
    if sqlerrm <> 'no_card' then failed := failed || ' no_card(live)? ' || sqlerrm || ';'; end if;
  end;
  begin
    perform public.be_start_session(c, 2725, 300, null);
    failed := failed || ' break with no billing mode;';
  exception when others then
    if sqlerrm <> 'bad_billing_mode' then failed := failed || ' bad_billing_mode? ' || sqlerrm || ';'; end if;
  end;
  s := public.be_start_session(c, 2725, 300, 'test');
  if s.billing_mode is distinct from 'test' then failed := failed || ' break did not keep its mode;'; end if;

  -- The card is locked during a break.
  begin
    perform public.be_save_card(c, false, 'cus_first', 'pm_2', 'visa', '0341', 'debit', 12, 2030);
    failed := failed || ' card changed during a break;';
  exception when others then
    if sqlerrm <> 'card_locked' then failed := failed || ' card_locked? ' || sqlerrm || ';'; end if;
  end;

  -- It fails: due to be charged, and the card stays locked until that's done.
  update public.sessions
  set started_at = now() - interval '51 minutes', relax_ends_at = now() - interval '6 minutes', deadline_at = now() - interval '1 minute'
  where id = s.id;
  perform public.be_finalize_sessions();
  select * into s from public.sessions where id = s.id;
  if s.status <> 'failed' or s.billing_status is distinct from 'due' then failed := failed || ' failed break not due for billing;'; end if;
  begin
    perform public.be_save_card(c, false, 'cus_first', 'pm_2', 'visa', '0341', 'debit', 12, 2030);
    failed := failed || ' card changed while a charge was due;';
  exception when others then
    if sqlerrm <> 'card_locked' then failed := failed || ' card_locked(due)? ' || sqlerrm || ';'; end if;
  end;

  -- Excused breaks, and breaks from before payments, are never due.
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at, first_photo_at, retake_until, billing_mode)
  values (b, now() - interval '55 minutes', now() - interval '10 minutes', now() - interval '5 minutes',
          now() - interval '6 minutes', now() - interval '3 minutes', 'test')
  returning * into s2;
  insert into public.photo_attempts (session_id, user_id, storage_path, verdict) values (s2.id, b, b || '/attempts/ex.jpg', 'error');
  perform public.be_finalize_sessions();
  select * into s2 from public.sessions where id = s2.id;
  if s2.status <> 'excused' or s2.billing_status is not null then failed := failed || ' excused break due for billing;'; end if;
  insert into public.sessions (user_id, started_at, relax_ends_at, deadline_at)
  values (b, now() - interval '51 minutes', now() - interval '6 minutes', now() - interval '1 minute')
  returning * into s2;
  perform public.be_finalize_sessions();
  select * into s2 from public.sessions where id = s2.id;
  if s2.status <> 'failed' or s2.billing_status is not null then failed := failed || ' break from before payments due for billing;'; end if;

  -- With a break due, the minute job pokes /api/billing (queued in pg_net, then rolled back).
  if not public.be_kick_billing() then failed := failed || ' kick did not poke with a break due;'; end if;

  -- A claim hands out the break once, with its card.
  n := 0;
  for r in select * from public.be_claim_billing() loop
    if r.session_id = s.id then
      n := n + 1;
      if r.customer_id <> 'cus_first' or r.payment_method_id <> 'pm_1' or r.billing_mode <> 'test' or r.billing_tries <> 1 then
        failed := failed || ' claim returned the wrong card;';
      end if;
    end if;
  end loop;
  if n <> 1 then failed := failed || ' due break not claimed once;'; end if;
  select count(*) into n from public.be_claim_billing() where session_id = s.id;
  if n <> 0 then failed := failed || ' claimed twice at once;'; end if;

  -- What Stripe said: a hold and a paid fee, then billing is done and stays done.
  ch := public.be_record_charge(s.id, 'hold', 4300, 'cad', 'pi_hold', 'held', null,
                                now() + interval '4 days 18 hours', now() + interval '4 days 17 hours');
  if ch.livemode or ch.user_id <> c then failed := failed || ' charge has the wrong owner or mode;'; end if;
  perform public.be_record_charge(s.id, 'fee', 225, 'cad', 'pi_fee', 'paid', null, null, null);
  begin
    perform public.be_finish_billing(s.id, 'due', null);
    failed := failed || ' billing finished as due;';
  exception when others then
    if sqlerrm <> 'bad_billing_status' then failed := failed || ' bad_billing_status? ' || sqlerrm || ';'; end if;
  end;
  perform public.be_finish_billing(s.id, 'charged', null);
  select * into s from public.sessions where id = s.id;
  if s.billing_status <> 'charged' or s.billed_at is null or s.billing_claimed_until is not null then
    failed := failed || ' billing not finished;';
  end if;
  perform public.be_finish_billing(s.id, 'error', 'x');
  select * into s from public.sessions where id = s.id;
  if s.billing_status <> 'charged' then failed := failed || ' finished billing changed again;'; end if;
  if public.be_save_card(c, false, 'cus_first', 'pm_2', 'visa', '0341', 'debit', 12, 2030) is distinct from 'pm_1' then
    failed := failed || ' card did not unlock, or did not return the old card;';
  end if;

  -- The hold is voided when its time comes, not before, and only once.
  select count(*) into n from public.be_due_voids() where charge_id = ch.id;
  if n <> 0 then failed := failed || ' hold due early;'; end if;
  update public.charges set void_due_at = now() - interval '1 second' where id = ch.id;
  select count(*) into n from public.be_due_voids() where charge_id = ch.id;
  if n <> 1 then failed := failed || ' due hold not listed;'; end if;
  perform public.be_mark_voided(ch.id);
  select * into ch from public.charges where id = ch.id;
  if ch.status <> 'voided' or ch.voided_at is null then failed := failed || ' hold not marked voided;'; end if;
  select count(*) into n from public.be_due_voids() where charge_id = ch.id;
  if n <> 0 then failed := failed || ' voided hold still due;'; end if;

  -- Recording a kind again updates its row and keeps what the new call doesn't know.
  perform public.be_record_charge(s.id, 'hold', 4300, 'cad', null, 'voided', null, null, null);
  select * into ch from public.charges where id = ch.id;
  if ch.payment_intent_id is distinct from 'pi_hold' or ch.void_due_at is null then failed := failed || ' update lost the hold details;'; end if;
  select count(*) into n from public.charges where session_id = s.id;
  if n <> 2 then failed := failed || ' charge rows: ' || n || ';'; end if;
  begin
    perform public.be_record_charge(s2.id, 'fee', 225, 'cad', 'pi_old', 'paid', null, null, null);
    failed := failed || ' charged a break from before payments;';
  exception when others then
    if sqlerrm <> 'session_not_billable' then failed := failed || ' session_not_billable? ' || sqlerrm || ';'; end if;
  end;

  -- Nothing due: the minute job stays quiet.
  if not exists (select 1 from public.sessions where billing_status = 'due')
     and not exists (select 1 from public.charges where status = 'held' and void_due_at <= now())
     and public.be_kick_billing() then
    failed := failed || ' kick poked with nothing due;';
  end if;

  execute 'reset role';
  if failed = '' then
    raise exception 'LOGIC CHECK PASSED (rolled back)';
  else
    raise exception 'LOGIC CHECK FAILED:%', failed;
  end if;
end $$;
