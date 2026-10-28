-- Payments. Starting or passing a break never touches the card. When a break fails, the saved
-- card gets two separate PaymentIntents: a $43.00 hold that is never captured, and a $2.25 fee
-- charged right away. The hold is voided before Stripe's capture_before. Excused breaks are
-- never charged.
--
-- Stripe only takes form-encoded requests and pg_net only sends JSON, so the database can't call
-- Stripe itself the way it calls Telegram. Instead pg_cron checks every minute whether anything
-- is due and, if so, pokes /api/billing, which makes the Stripe calls. The poke carries no
-- secret: the endpoint only does work that is already due, and the claim below plus Stripe
-- idempotency keys keep a second caller from charging twice.
--
-- If the bank refuses (no money, expired card, wants the cardholder present), nothing is charged
-- this time and nothing is owed afterwards (Eric, 2026-10-28: charging an empty account could
-- set off overdraft). A saved card is required before a break can start.

-- The saved card, one per user per Stripe mode: test mode customers don't exist in live mode.
create table public.cards (
  user_id uuid not null references auth.users (id) on delete cascade,
  livemode boolean not null,
  customer_id text not null,
  payment_method_id text,
  brand text,
  last4 text,
  funding text,
  exp_month integer,
  exp_year integer,
  updated_at timestamptz not null default now(),
  primary key (user_id, livemode)
);

-- One row per PaymentIntent of a failed break: its hold and its fee.
create table public.charges (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('hold', 'fee')),
  livemode boolean not null,
  amount integer not null,
  currency text not null,
  payment_intent_id text unique,
  -- held: the hold is on the card, waiting to be voided. paid: the fee went through.
  status text not null check (status in ('held', 'paid', 'declined', 'voided')),
  decline_code text,
  -- Stripe's deadline for capturing the hold, and when we void it (an hour before, at most 120 hours in).
  capture_before timestamptz,
  void_due_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (session_id, kind),
  check (status <> 'paid' or kind = 'fee'),
  check (status <> 'held' or (kind = 'hold' and void_due_at is not null))
);

create index charges_held on public.charges (void_due_at) where status = 'held';

-- 'test' or 'live': the Stripe mode a break started under, so its failure is charged in the same
-- mode. Empty on breaks from before payments, which are never charged.
alter table public.sessions add column billing_mode text check (billing_mode in ('test', 'live'));
-- due: failed and waiting for /api/billing. charged: hold and fee went through.
-- declined: the bank said no, nothing charged. error: no answer from Stripe after many tries, nothing charged.
alter table public.sessions add column billing_status text check (billing_status in ('due', 'charged', 'declined', 'error'));
-- Why nothing was charged, shown in the app.
alter table public.sessions add column billing_note text;
alter table public.sessions add column billing_tries integer not null default 0;
alter table public.sessions add column billing_claimed_until timestamptz;
alter table public.sessions add column billed_at timestamptz;
create index sessions_billing_due on public.sessions (finalized_at) where billing_status = 'due';

alter table public.cards enable row level security;
alter table public.charges enable row level security;
create policy "read own cards" on public.cards
  for select to authenticated using (user_id = (select auth.uid()));
create policy "read own charges" on public.charges
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.cards, public.charges from anon, authenticated;
grant select on public.cards, public.charges to authenticated;
grant all on public.cards, public.charges to service_role;

-- Same as before, plus: a failed break that started with a card is due to be charged.
create or replace function public.be_finalize_sessions()
returns integer
language sql
set search_path = ''
as $$
  with due as (
    select
      s.id,
      s.first_photo_at,
      (
        select a.verdict from public.photo_attempts a
        where a.session_id = s.id
        order by a.submitted_at desc, a.id desc
        limit 1
      ) as last_verdict
    from public.sessions s
    where s.status = 'active'
      and (
        (s.first_photo_at is null and now() > s.deadline_at)
        -- 2 minutes of slack so an AI call that started inside the retake window can still land.
        or (s.first_photo_at is not null and now() > s.retake_until + interval '2 minutes')
      )
  ),
  closed as (
    update public.sessions s
    set status = case when d.last_verdict in ('error', 'pending') then 'excused' else 'failed' end,
        finalized_at = now(),
        fail_reason = case
          when d.first_photo_at is null then 'no_photo'
          when d.last_verdict in ('error', 'pending') then null
          else 'no_pass'
        end,
        billing_status = case
          when d.last_verdict in ('error', 'pending') then null
          when s.billing_mode is not null then 'due'
        end
    from due d
    where s.id = d.id and s.status = 'active'
    returning 1
  )
  select count(*)::integer from closed;
$$;

-- Starting a break now needs a saved card in the server's Stripe mode, and the break remembers
-- that mode. The three-argument version stays only until the deployed API has moved over to
-- this one (it starts breaks that are never charged); drop it in the next migration.
create function public.be_start_session(p_user_id uuid, p_relax_seconds integer, p_buffer_seconds integer, p_billing_mode text)
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
    insert into public.sessions (user_id, relax_ends_at, deadline_at, billing_mode)
    values (
      p_user_id,
      now() + make_interval(secs => p_relax_seconds),
      now() + make_interval(secs => p_relax_seconds + p_buffer_seconds),
      p_billing_mode
    )
    returning * into s;
  exception when unique_violation then
    raise exception 'already_active';
  end;
  return s;
end;
$$;

-- The user's Stripe customer, made the first time they add a card. If two taps raced, the one
-- stored first wins and is returned.
create function public.be_save_customer(p_user_id uuid, p_livemode boolean, p_customer_id text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  cid text;
begin
  insert into public.cards (user_id, livemode, customer_id)
  values (p_user_id, p_livemode, p_customer_id)
  on conflict (user_id, livemode) do nothing;
  select customer_id into cid from public.cards where user_id = p_user_id and livemode = p_livemode;
  return cid;
end;
$$;

-- Saves the card the user just set up. Locked while a break runs or a failed one waits to be
-- charged: otherwise swapping in an empty card at 50:00 would dodge the charge.
-- Returns the card it replaced, so the server can detach it from the customer.
create function public.be_save_card(
  p_user_id uuid, p_livemode boolean, p_customer_id text, p_payment_method_id text,
  p_brand text, p_last4 text, p_funding text, p_exp_month integer, p_exp_year integer
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  c public.cards;
begin
  perform public.be_finalize_sessions();
  if exists (
    select 1 from public.sessions
    where user_id = p_user_id and (status = 'active' or billing_status = 'due')
  ) then
    raise exception 'card_locked';
  end if;
  select * into c from public.cards
  where user_id = p_user_id and livemode = p_livemode and customer_id = p_customer_id
  for update;
  if not found then
    raise exception 'card_not_found';
  end if;
  update public.cards
  set payment_method_id = p_payment_method_id, brand = p_brand, last4 = p_last4, funding = p_funding,
      exp_month = p_exp_month, exp_year = p_exp_year, updated_at = now()
  where user_id = p_user_id and livemode = p_livemode;
  return c.payment_method_id;
end;
$$;

-- Hands /api/billing the failed breaks waiting to be charged, at most 10 at a time, each with its
-- card. A claimed break is left alone for 2 minutes so a second caller can't work on it at the
-- same time; if the first one died or Stripe didn't answer, a later run picks it up again.
create function public.be_claim_billing()
returns table (session_id uuid, user_id uuid, billing_mode text, billing_tries integer, customer_id text, payment_method_id text)
language sql
set search_path = ''
as $$
  with picked as (
    update public.sessions s
    set billing_claimed_until = now() + interval '2 minutes', billing_tries = s.billing_tries + 1
    where s.id in (
      select x.id from public.sessions x
      where x.billing_status = 'due' and (x.billing_claimed_until is null or x.billing_claimed_until < now())
      order by x.finalized_at
      limit 10
      for update skip locked
    )
    returning s.id, s.user_id, s.billing_mode, s.billing_tries
  )
  select p.id, p.user_id, p.billing_mode, p.billing_tries, c.customer_id, c.payment_method_id
  from picked p
  left join public.cards c on c.user_id = p.user_id and c.livemode = (p.billing_mode = 'live');
$$;

-- Stores what Stripe said about one of a break's PaymentIntents. Called again for the same break
-- and kind (a retry, or the hold voided after the fee was declined), it updates that row.
create function public.be_record_charge(
  p_session_id uuid, p_kind text, p_amount integer, p_currency text, p_payment_intent_id text,
  p_status text, p_decline_code text, p_capture_before timestamptz, p_void_due_at timestamptz
)
returns public.charges
language plpgsql
set search_path = ''
as $$
declare
  s public.sessions;
  c public.charges;
begin
  select * into s from public.sessions where id = p_session_id;
  if not found or s.billing_mode is null then
    raise exception 'session_not_billable';
  end if;
  insert into public.charges as ch (
    session_id, user_id, kind, livemode, amount, currency, payment_intent_id, status,
    decline_code, capture_before, void_due_at, voided_at
  )
  values (
    s.id, s.user_id, p_kind, s.billing_mode = 'live', p_amount, p_currency, p_payment_intent_id, p_status,
    p_decline_code, p_capture_before, p_void_due_at, case when p_status = 'voided' then now() end
  )
  on conflict (session_id, kind) do update set
    payment_intent_id = coalesce(excluded.payment_intent_id, ch.payment_intent_id),
    status = excluded.status,
    decline_code = excluded.decline_code,
    capture_before = coalesce(excluded.capture_before, ch.capture_before),
    void_due_at = coalesce(excluded.void_due_at, ch.void_due_at),
    voided_at = case when excluded.status = 'voided' then coalesce(ch.voided_at, now()) end
  returning * into c;
  return c;
end;
$$;

-- Ends billing for a break, with the line the app shows when nothing was charged.
create function public.be_finish_billing(p_session_id uuid, p_status text, p_note text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_status not in ('charged', 'declined', 'error') then
    raise exception 'bad_billing_status';
  end if;
  update public.sessions
  set billing_status = p_status, billing_note = p_note, billed_at = now(), billing_claimed_until = null
  where id = p_session_id and billing_status = 'due';
end;
$$;

-- Holds whose void time has come.
create function public.be_due_voids()
returns table (charge_id uuid, payment_intent_id text, livemode boolean)
language sql
stable
set search_path = ''
as $$
  select c.id, c.payment_intent_id, c.livemode from public.charges c
  where c.status = 'held' and c.void_due_at <= now()
  order by c.void_due_at
  limit 20;
$$;

create function public.be_mark_voided(p_charge_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.charges set status = 'voided', voided_at = now() where id = p_charge_id and status = 'held';
$$;

-- Run by pg_cron every minute: closes overdue breaks, then pokes /api/billing if a failed break
-- waits to be charged or a hold is due to be voided. Returns whether it poked.
create function public.be_kick_billing()
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  perform public.be_finalize_sessions();
  if exists (
    select 1 from public.sessions
    where billing_status = 'due' and (billing_claimed_until is null or billing_claimed_until < now())
  ) or exists (
    select 1 from public.charges where status = 'held' and void_due_at <= now()
  ) then
    perform net.http_post(
      url := 'https://break-enforcer.vercel.app/api/billing',
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
    return true;
  end if;
  return false;
end;
$$;

-- Server only, like the other be_* functions.
revoke execute on function
  public.be_start_session(uuid, integer, integer, text),
  public.be_save_customer(uuid, boolean, text),
  public.be_save_card(uuid, boolean, text, text, text, text, text, integer, integer),
  public.be_claim_billing(),
  public.be_record_charge(uuid, text, integer, text, text, text, text, timestamptz, timestamptz),
  public.be_finish_billing(uuid, text, text),
  public.be_due_voids(),
  public.be_mark_voided(uuid),
  public.be_kick_billing()
from public, anon, authenticated;
grant execute on function
  public.be_start_session(uuid, integer, integer, text),
  public.be_save_customer(uuid, boolean, text),
  public.be_save_card(uuid, boolean, text, text, text, text, text, integer, integer),
  public.be_claim_billing(),
  public.be_record_charge(uuid, text, integer, text, text, text, text, timestamptz, timestamptz),
  public.be_finish_billing(uuid, text, text),
  public.be_due_voids(),
  public.be_mark_voided(uuid),
  public.be_kick_billing()
to service_role;

select cron.schedule('be-billing', '* * * * *', 'select public.be_kick_billing()');
