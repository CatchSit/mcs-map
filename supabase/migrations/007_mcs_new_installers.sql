-- Staging table: new MCS installers detected by mcs-scraper, awaiting email from mcs-notifier.
-- Rows are inserted by mcs-scraper when new installers are found, then marked notified_at by mcs-notifier.

CREATE TABLE IF NOT EXISTS mcs_new_installers (
  id             bigserial   PRIMARY KEY,
  installer_id   text        NOT NULL,
  installer_name text,
  installer_data jsonb,                          -- raw MCS record for building email cards
  detected_at    timestamptz DEFAULT now(),
  notified_at    timestamptz                     -- null = pending notification
);
