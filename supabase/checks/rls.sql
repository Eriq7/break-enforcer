-- Run: supabase db query --linked -f supabase/checks/rls.sql
-- Expect the error "RLS CHECK PASSED (rolled back)". Anything else is a broken rule.
-- Checks access as two made-up users, A and B, and as anon. The browser may only read its own
-- rows; every write and every be_* function belongs to the server. Everything is rolled back.
do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  sa uuid;
  spa uuid;
  n int;
  failed text := '';
  as_user text := 'select set_config(''request.jwt.claims'', json_build_object(''sub'', %L, ''role'', ''authenticated'')::text, true)';
begin
  insert into auth.users (id, email, aud, role) values
    (a, 'rls-a@example.invalid', 'authenticated', 'authenticated'),
    (b, 'rls-b@example.invalid', 'authenticated', 'authenticated');

  -- A's rows, written the way the server writes them.
  insert into public.spots (user_id, name) values (a, 'A spot') returning id into spa;
  insert into public.reference_photos (user_id, spot_id, storage_path) values (a, spa, a || '/refs/x.jpg');
  insert into public.sessions (user_id, relax_ends_at, deadline_at)
    values (a, now() + interval '45 minutes', now() + interval '50 minutes') returning id into sa;
  insert into public.photo_attempts (session_id, user_id, storage_path) values (sa, a, a || '/attempts/x.jpg');
  insert into public.telegram_links (user_id, chat_id) values (a, 111);
  insert into public.telegram_codes (code, user_id, expires_at) values ('rls-code', a, now() + interval '1 minute');

  -- The photos bucket has no storage policies at all, so only the server reaches it.
  select count(*) into n from pg_policies where schemaname = 'storage' and tablename = 'objects';
  if n <> 0 then failed := failed || ' storage.objects has policies;'; end if;

  -- A reads its own rows and cannot write anything.
  execute format(as_user, a);
  execute 'set local role authenticated';
  select count(*) into n from public.reference_photos;
  if n <> 1 then failed := failed || ' A cannot read own refs;'; end if;
  select count(*) into n from public.spots;
  if n <> 1 then failed := failed || ' A cannot read own spots;'; end if;
  select count(*) into n from public.telegram_links;
  if n <> 1 then failed := failed || ' A cannot read own telegram link;'; end if;
  begin
    select count(*) into n from public.telegram_codes;
    failed := failed || ' A reads telegram codes;';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.telegram_links set chat_id = 999;
    failed := failed || ' A changes telegram link;';
  exception when insufficient_privilege then null;
  end;
  select count(*) into n from public.sessions;
  if n <> 1 then failed := failed || ' A cannot read own sessions;'; end if;
  select count(*) into n from public.photo_attempts;
  if n <> 1 then failed := failed || ' A cannot read own attempts;'; end if;

  begin
    insert into public.sessions (relax_ends_at, deadline_at) values (now() + interval '1 minute', now() + interval '2 minutes');
    failed := failed || ' A inserts session;';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.sessions set status = 'passed';
    failed := failed || ' A updates session;';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.sessions;
    failed := failed || ' A deletes session;';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.reference_photos (spot_id, storage_path) values (spa, 'x');
    failed := failed || ' A inserts reference;';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.spots (name) values ('x');
    failed := failed || ' A inserts spot;';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.spots;
    failed := failed || ' A deletes spot;';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.reference_photos;
    failed := failed || ' A deletes reference;';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.photo_attempts set verdict = 'pass';
    failed := failed || ' A rewrites a verdict;';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.photo_attempts (session_id, storage_path) values (sa, 'y');
    failed := failed || ' A inserts attempt;';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('photos', a || '/sneaky.jpg', a);
    failed := failed || ' A writes to photos bucket;';
  exception when insufficient_privilege then null;
  end;

  -- Server functions are off limits to a logged-in browser.
  begin
    perform public.be_finalize_sessions();
    failed := failed || ' A runs be_finalize_sessions;';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.be_start_session(a, 1, 1);
    failed := failed || ' A runs be_start_session;';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.be_record_photo(a, sa, spa, 'z', 60);
    failed := failed || ' A runs be_record_photo;';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.be_record_verdict(gen_random_uuid(), 'pass', '', '', null);
    failed := failed || ' A runs be_record_verdict;';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.be_add_reference(a, spa, 'w');
    failed := failed || ' A runs be_add_reference;';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.be_delete_reference(a, gen_random_uuid());
    failed := failed || ' A runs be_delete_reference;';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.be_add_spot(a, 'x');
    failed := failed || ' A runs be_add_spot;';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.be_delete_spot(a, spa);
    failed := failed || ' A runs be_delete_spot;';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.be_telegram_link('rls-code', 999);
    failed := failed || ' A runs be_telegram_link;';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.be_telegram_code(a, 'x');
    failed := failed || ' A runs be_telegram_code;';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.be_set_telegram_bot('x', 'x');
    failed := failed || ' A runs be_set_telegram_bot;';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.be_send_reminders();
    failed := failed || ' A runs be_send_reminders;';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.be_due_reminders();
    failed := failed || ' A runs be_due_reminders;';
  exception when insufficient_privilege then null;
  end;

  -- B sees none of A's rows.
  execute 'reset role';
  execute format(as_user, b);
  execute 'set local role authenticated';
  select count(*) into n from public.reference_photos;
  if n <> 0 then failed := failed || ' B reads A refs;'; end if;
  select count(*) into n from public.sessions;
  if n <> 0 then failed := failed || ' B reads A sessions;'; end if;
  select count(*) into n from public.photo_attempts;
  if n <> 0 then failed := failed || ' B reads A attempts;'; end if;
  select count(*) into n from public.spots;
  if n <> 0 then failed := failed || ' B reads A spots;'; end if;
  select count(*) into n from public.telegram_links;
  if n <> 0 then failed := failed || ' B reads A telegram link;'; end if;

  -- Not logged in: no access at all.
  execute 'reset role';
  execute 'set local role anon';
  begin
    select count(*) into n from public.sessions;
    failed := failed || ' anon reads sessions;';
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into n from public.reference_photos;
    failed := failed || ' anon reads refs;';
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into n from public.spots;
    failed := failed || ' anon reads spots;';
  exception when insufficient_privilege then null;
  end;

  execute 'reset role';
  if failed = '' then
    raise exception 'RLS CHECK PASSED (rolled back)';
  else
    raise exception 'RLS CHECK FAILED:%', failed;
  end if;
end $$;
