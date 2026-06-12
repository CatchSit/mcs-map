-- pg_cron schedule: run mcs-monitor edge function Mon–Fri at 08:00 UTC.
-- (09:00 BST in summer, 08:00 GMT in winter)
--
-- Replace <anon_key> with the actual anon key from Supabase project settings > API.
-- To check existing schedules: SELECT * FROM cron.job;
-- To remove: SELECT cron.unschedule('mcs-monitor');

SELECT cron.schedule(
  'mcs-monitor',
  '0 8 * * 1-5',  -- 08:00 UTC Mon–Fri
  $$
  SELECT net.http_post(
    url     := 'https://teezsldwkpwzgvfizial.supabase.co/functions/v1/mcs-monitor',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlZXpzbGR3a3B3emd2Zml6aWFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5NzUxMjAsImV4cCI6MjA5NDU1MTEyMH0.8rRoiHuS98HZp4jHSYbL31J3O9fn36tKEy9ooosPoGU
>"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);
