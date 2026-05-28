-- Replace the single mcs-monitor cron job with two focused jobs:
--   mcs-scraper  — 08:00 UTC Mon-Fri — fetch MCS, diff, store new installers
--   mcs-notifier — 08:05 UTC Mon-Fri — read staging table, send email
--
-- Replace <anon_key> with the Supabase project anon key before running.
-- To check: SELECT * FROM cron.job;
-- To remove: SELECT cron.unschedule('mcs-scraper'); SELECT cron.unschedule('mcs-notifier');

SELECT cron.unschedule('mcs-monitor');

SELECT cron.schedule(
  'mcs-scraper',
  '0 8 * * 1-5',
  $$
  SELECT net.http_post(
    url     := 'https://teezsldwkpwzgvfizial.supabase.co/functions/v1/mcs-scraper',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <anon_key>"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);

SELECT cron.schedule(
  'mcs-notifier',
  '5 8 * * 1-5',
  $$
  SELECT net.http_post(
    url     := 'https://teezsldwkpwzgvfizial.supabase.co/functions/v1/mcs-notifier',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <anon_key>"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);
