-- contacts table
-- This file is documentation of the live schema. Verify against Supabase
-- dashboard before re-running; the table already exists in production.
--
-- To apply to a fresh project: run this file first, then 002, then 003.

CREATE TABLE IF NOT EXISTS contacts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  installer_id     text        NOT NULL,
  installer_name   text        NOT NULL,
  employee         text        NOT NULL,
  employee_email   text,
  outcome          text        NOT NULL,
  notes            text,
  next_action      text,
  follow_up_date   date,
  contacted_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz,
  updated_by       text,
  deleted_at       timestamptz,
  deleted_by       text
);

-- outcome must be one of the 7 values defined in shared/status-config.js
-- (no DB-level CHECK constraint exists — enforced by the UI only)
