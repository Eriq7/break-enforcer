-- Telegram reminder at 40:00, about 5 minutes before a break ends. A web app on iPhone only
-- runs while it is open, so the reminder comes from the database: pg_cron checks every minute
-- and pg_net sends the message straight to Telegram. That works with the app closed.
--
-- The bot token lives in Vault and only the database uses it. Linking a chat goes through the
-- bot's webhook (api/telegram-hook.js), which answers inside the webhook response and so never
-- needs the token.

create extension if not exists pg_net with schema extensions;

-- The Telegram chat each user gets reminders in.
create table public.telegram_links (
  user_id uuid primary key references auth.users (id) on delete cascade,
  chat_id bigint not null,
  linked_at timestamptz not null default now()
);

-- One-time codes for the t.me/<bot>?start=<code> link the app opens. The code is what proves
-- the chat belongs to that user, so it is long, random, single use and short lived.
create table public.telegram_codes (
  code text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null
);

alter table public.telegram_links enable row level security;
alter table public.telegram_codes enable row level security;
create policy "read own telegram link" on public.telegram_links
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.telegram_links, public.telegram_codes from anon, authenticated;
grant select on public.telegram_links to authenticated;
grant all on public.telegram_links, public.telegram_codes to service_role;

-- When the reminder went out, so each break gets it once.
alter table public.sessions add column warned_at timestamptz;

-- How long before the end of the break the reminder goes out: 40:00 into a 45:25 break.
-- Measured back from the end so a shortened local test session still gets one.
create function public.be_reminder_lead()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '5 minutes 25 seconds' $$;

-- Stores the bot token and the bot's username (not secret, but it changes with the token).
-- Security definer because Vault belongs to postgres; only the server may call it.
create function public.be_set_telegram_bot(p_token text, p_username text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  id uuid;
begin
  select s.id into id from vault.secrets s where s.name = 'telegram_bot_token';
  if id is null then
    perform vault.create_secret(p_token, 'telegram_bot_token', 'Break Enforcer Telegram bot token');
  else
    perform vault.update_secret(id, p_token);
  end if;
  select s.id into id from vault.secrets s where s.name = 'telegram_bot_username';
  if id is null then
    perform vault.create_secret(p_username, 'telegram_bot_username', 'Break Enforcer Telegram bot username');
  else
    perform vault.update_secret(id, p_username);
  end if;
end;
$$;

-- Saves a new link code for the user and returns the bot's username for the link.
create function public.be_telegram_code(p_user_id uuid, p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  bot text;
begin
  select decrypted_secret into bot from vault.decrypted_secrets where name = 'telegram_bot_username';
  if bot is null then
    raise exception 'telegram_not_set_up';
  end if;
  delete from public.telegram_codes where user_id = p_user_id or expires_at < now();
  insert into public.telegram_codes (code, user_id, expires_at)
  values (p_code, p_user_id, now() + interval '15 minutes');
  return bot;
end;
$$;

-- The bot got "/start <code>": ties that chat to the code's user. Returns the user, or null
-- when the code is unknown, used or expired.
create function public.be_telegram_link(p_code text, p_chat_id bigint)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  uid uuid;
begin
  delete from public.telegram_codes
  where code = p_code and expires_at > now()
  returning user_id into uid;
  if uid is null then
    return null;
  end if;
  insert into public.telegram_links (user_id, chat_id)
  values (uid, p_chat_id)
  on conflict (user_id) do update set chat_id = excluded.chat_id, linked_at = now();
  return uid;
end;
$$;

-- "5 minutes", "1 minute". Rounded, since the cron can run up to a minute late.
create function public.be_minutes(p interval)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when m = 1 then '1 minute' else m || ' minutes' end
  from (select greatest(1, round(extract(epoch from p) / 60))::integer as m) x
$$;

-- Marks the breaks that are due a reminder and returns who to message and what to say.
-- Only breaks still running with no photo yet; once the break is over the reminder is stale.
create function public.be_due_reminders()
returns table (chat_id bigint, message text)
language sql
set search_path = ''
as $$
  with due as (
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
  )
  select
    due.chat_id,
    format(
      'Your break ends in %s. Then you have %s to take your check-in photo. Head to your check-in spot.',
      public.be_minutes(due.relax_ends_at - now()),
      public.be_minutes(due.deadline_at - due.relax_ends_at)
    )
  from due;
$$;

-- Run by pg_cron every minute. Does nothing until the bot is set up.
create function public.be_send_reminders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  token text;
  r record;
  n integer := 0;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name = 'telegram_bot_token';
  if token is null then
    return 0;
  end if;
  for r in select * from public.be_due_reminders() loop
    perform net.http_post(
      url := 'https://api.telegram.org/bot' || token || '/sendMessage',
      body := jsonb_build_object('chat_id', r.chat_id, 'text', r.message)
    );
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke execute on function
  public.be_set_telegram_bot(text, text),
  public.be_telegram_code(uuid, text),
  public.be_telegram_link(text, bigint),
  public.be_due_reminders(),
  public.be_send_reminders()
from public, anon, authenticated;
grant execute on function
  public.be_set_telegram_bot(text, text),
  public.be_telegram_code(uuid, text),
  public.be_telegram_link(text, bigint),
  public.be_due_reminders(),
  public.be_send_reminders()
to service_role;

select cron.schedule('be-telegram-reminders', '* * * * *', 'select public.be_send_reminders()');
