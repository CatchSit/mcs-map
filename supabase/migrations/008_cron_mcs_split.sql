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
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlZXpzbGR3a3B3emd2Zml6aWFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5NzUxMjAsImV4cCI6MjA5NDU1MTEyMH0.8rRoiHuS98HZp4jHSYbL31J3O9fn36tKEy9ooosPoGU>"}'::jsonb,
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
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlZXpzbGR3a3B3emd2Zml6aWFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5NzUxMjAsImV4cCI6MjA5NDU1MTEyMH0.8rRoiHuS98HZp4jHSYbL31J3O9fn36tKEy9ooosPoGU>"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);
