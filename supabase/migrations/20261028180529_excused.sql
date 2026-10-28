-- A break the AI couldn't judge doesn't count against the user (Eric, 2026-10-28: the service
-- going down is not his fault). When the retake window closes with no pass and the last photo
-- never got an answer (the AI call errored, or never came back), the break ends as 'excused'
-- instead of 'failed'. Excused breaks will never be charged.
--
-- The last photo decides, not "every photo": if the AI said no to an earlier photo and then
-- broke while the user retook it, they never got the chance to fix it.

alter table public.sessions drop constraint sessions_status_check;
alter table public.sessions add constraint sessions_status_check
  check (status in ('active', 'passed', 'failed', 'excused'));

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
        end
    from due d
    where s.id = d.id and s.status = 'active'
    returning 1
  )
  select count(*)::integer from closed;
$$;
