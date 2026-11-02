-- A phone shows nothing of a running break unless the app is open, so Telegram counts it down:
-- 20, 15, 10 and 5 minutes before the break ends (25:00, 30:00, 35:00 and 40:00 into a 45:25
-- break), then the 45:25 "break is over" message as before. Each message goes out once, only
-- while no photo is in.
--
-- countdown_sent is how many of the four have gone out. A break that is already past several of
-- them (a shortened local test, or Telegram connected halfway through) gets only the latest one,
-- not a burst.

alter table public.sessions add column countdown_sent smallint not null default 0
  check (countdown_sent between 0 and 4);

-- Breaks that already got the old single reminder have had their last countdown message.
update public.sessions set countdown_sent = 4 where warned_at is not null;

-- How long before the end of the break each countdown message goes out. The extra 25 seconds
-- puts them on the marks into the break (25:00, 30:00, 35:00, 40:00), same as the old 40:00.
create function public.be_countdown_leads()
returns interval[]
language sql
immutable
set search_path = ''
as $$
  select array[
    interval '20 minutes 25 seconds',
    interval '15 minutes 25 seconds',
    interval '10 minutes 25 seconds',
    interval '5 minutes 25 seconds'
  ]
$$;

-- "20 minutes". The reminder goes out up to a minute after its mark, so the exact time left would
-- read 19 about half the time; the nearest 5 minutes says what the message is for. Under 2.5
-- minutes (only a shortened test break) it falls back to the exact minutes.
create function public.be_minutes_left(p interval)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when extract(epoch from p) >= 150 then (5 * round(extract(epoch from p) / 300))::integer::text || ' minutes'
    else public.be_minutes(p)
  end
$$;

create or replace function public.be_due_reminders()
returns table (chat_id bigint, message text)
language sql
set search_path = ''
as $$
  with step as (
    -- How many of the four marks this break has passed.
    select
      s.id,
      s.user_id,
      (select count(*) from unnest(public.be_countdown_leads()) lead where now() >= s.relax_ends_at - lead)::smallint as passed
    from public.sessions s
    where s.status = 'active'
      and s.first_photo_at is null
      and now() < s.relax_ends_at
  ),
  soon as (
    update public.sessions s
    set countdown_sent = step.passed
    from step
    join public.telegram_links t on t.user_id = step.user_id
    where s.id = step.id
      and step.passed > s.countdown_sent
    returning t.chat_id, s.relax_ends_at, s.deadline_at, step.passed
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
    case
      when soon.passed = 4 then format(
        'Your break ends in %s. Then you have %s to take your check-in photo. Head to your check-in spot.',
        public.be_minutes_left(soon.relax_ends_at - now()),
        public.be_minutes(soon.deadline_at - soon.relax_ends_at)
      )
      else format('Your break ends in %s.', public.be_minutes_left(soon.relax_ends_at - now()))
    end
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

alter table public.sessions drop column warned_at;
drop function public.be_reminder_lead();

-- Server only, like the other be_* functions.
revoke execute on function public.be_countdown_leads(), public.be_minutes_left(interval)
from public, anon, authenticated;
grant execute on function public.be_countdown_leads(), public.be_minutes_left(interval)
to service_role;
