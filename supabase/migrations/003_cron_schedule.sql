-- pg_cron schedule for the follow-up digest Edge Function.
-- Runs 7am UTC Mon–Fri (= 8am BST in summer, 7am GMT in winter).
--
-- Replace <anon_key> with the Supabase project anon key before running.
-- The anon key is visible in both HTML files inside createClient().
--
-- Run this in the Supabase SQL editor (not psql — requires pg_cron + pg_net
-- extensions, which are pre-enabled on Supabase projects).
--
-- To check existing schedules: SELECT * FROM cron.job;
-- To remove this schedule:     SELECT cron.unschedule('send-followup-digest');

SELECT cron.schedule(
  'send-followup-digest',
  '0 7 * * 1-5',
  $$
  SELECT net.http_post(
    url     := 'https://teezsldwkpwzgvfizial.supabase.co/functions/v1/send-followup-digest',
    headers := '{"Authorization": "Bearer <anon_key>"}'::jsonb
  )
  $$
);
