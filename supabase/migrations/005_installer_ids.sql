-- Tracks all installer IDs ever seen from the MCS website.
-- Used by the mcs-monitor edge function to detect new installers on each run.
-- Cumulative: rows are only added or updated, never removed.

CREATE TABLE IF NOT EXISTS installer_ids (
  installer_id   text        PRIMARY KEY,
  installer_name text,
  first_seen_at  timestamptz DEFAULT now()
);
