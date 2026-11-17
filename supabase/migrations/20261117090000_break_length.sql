-- The break length is now picked in the app (Eric, 2026-11-17), from 1 minute to 5:59:59, so a
-- break can be shorter than the first Telegram countdown marks (20, 15, 10 and 5 minutes before
-- the end). A mark that is already behind a break when it starts is counted as sent: a 12 minute
-- break gets its messages at 10 and 5 minutes left, not an "ends in 10 minutes" the moment it
-- starts. Same signature as before, so the deployed API keeps working through the switch.

create or replace function public.be_start_session(p_user_id uuid, p_relax_seconds integer, p_buffer_seconds integer, p_billing_mode text)
returns public.sessions
language plpgsql
set search_path = ''
as $$
declare
  s public.sessions;
begin
  if p_billing_mode is null or p_billing_mode not in ('test', 'live') then
    raise exception 'bad_billing_mode';
  end if;
  perform public.be_finalize_sessions();
  if not exists (select 1 from public.reference_photos where user_id = p_user_id) then
    raise exception 'no_reference';
  end if;
  if not exists (
    select 1 from public.cards
    where user_id = p_user_id and livemode = (p_billing_mode = 'live') and payment_method_id is not null
  ) then
    raise exception 'no_card';
  end if;
  begin
    insert into public.sessions (user_id, relax_ends_at, deadline_at, billing_mode, countdown_sent)
    values (
      p_user_id,
      now() + make_interval(secs => p_relax_seconds),
      now() + make_interval(secs => p_relax_seconds + p_buffer_seconds),
      p_billing_mode,
      (select count(*) from unnest(public.be_countdown_leads()) lead where make_interval(secs => p_relax_seconds) <= lead)::smallint
    )
    returning * into s;
  exception when unique_violation then
    raise exception 'already_active';
  end;
  return s;
end;
$$;
