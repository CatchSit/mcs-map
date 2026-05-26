-- RLS policies for the contacts table.
-- This file is documentation of the live policies. Verify each policy
-- against Supabase dashboard (Authentication > Policies) before re-running.
--
-- IMPORTANT: the contacts_update_policy hardcodes the admin email.
-- If you add a new admin, update BOTH this file AND ADMIN_EMAILS in dashboard.html.

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read all non-deleted records.
-- (Deleted records are filtered in JS with .is('deleted_at', null) — RLS
--  does not hide them so that admins can toggle "Show deleted" in the UI.)
CREATE POLICY "Authenticated read"
  ON contacts FOR SELECT
  TO authenticated
  USING (true);

-- Any authenticated user can log a new contact.
CREATE POLICY "Authenticated insert"
  ON contacts FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Safety net only — app code never hard-deletes records (soft delete pattern).
CREATE POLICY "Authenticated delete"
  ON contacts FOR DELETE
  TO authenticated
  USING (true);

-- Update: admin can update any record.
-- Regular users can only update their own records that are not soft-deleted.
--
-- The employee name match uses the same COALESCE priority as getUserName() in JS:
--   full_name > name > email prefix
-- If you change getUserName() in either HTML file, update this policy too.
CREATE POLICY "contacts_update_policy"
  ON contacts FOR UPDATE
  TO authenticated
  USING (
    auth.jwt() ->> 'email' = 'greg@amcorenewables.co.uk'
    OR (
      employee = COALESCE(
        NULLIF(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
        NULLIF(auth.jwt() -> 'user_metadata' ->> 'name', ''),
        split_part(auth.jwt() ->> 'email', '@', 1)
      )
      AND deleted_at IS NULL
    )
  );
