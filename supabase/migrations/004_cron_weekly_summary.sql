-- pg_cron schedule: run send-weekly-summary every Monday at 8:00 AM UK time (UTC, GMT offset).
-- In BST (summer) this fires at 07:00 UK; in GMT (winter) it fires at 08:00 UK.
-- Adjust to '0 7 * * 1' if you prefer 7am year-round in BST.
--
-- Replace <anon_key> with the actual anon key from Supabase project settings > API.
-- To check existing schedules: SELECT * FROM cron.job;
-- To remove: SELECT cron.unschedule('send-weekly-summary');

SELECT cron.schedule(
  'send-weekly-summary',
  '0 8 * * 1',  -- 08:00 UTC every Monday
  $$
  SELECT net.http_post(
    url    := 'https://teezsldwkpwzgvfizial.supabase.co/functions/v1/send-weekly-summary',
    body   := '{}'::jsonb,
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <anon_key>"}'::jsonb
  )
  $$
);
