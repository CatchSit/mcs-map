# MCS Installer Map — Project Handover

## 1. Project Overview

**MCS Installer Map** is an internal sales/business-development tool for **Amcore Renewables**. It visualises all MCS (Microgeneration Certification Scheme) certified installers across the UK on an interactive map, and provides a lightweight CRM layer on top so the sales team can log outreach calls, track contact status, and manage a pipeline of potential installer partners.

**Target audience:** Internal staff at Amcore Renewables (sales/BD team + one manager).

**Core value:** The MCS public database lists thousands of certified installers but gives no way to track who has been contacted, what was said, or what the next step is. This tool overlays that data onto a map with filtering, colour-coded status markers, and a contact log so the team can work through the installer base systematically without duplicating effort or losing context.

---

## 2. Tech Stack & Architecture

### Languages & Libraries
| Library | Version | Purpose |
|---|---|---|
| Leaflet.js | 1.9.4 | Interactive map rendering |
| Leaflet.MarkerCluster | 1.5.3 | Clustering map markers |
| Supabase JS SDK | 2.x (UMD) | Database + authentication client |
| Chart.js | 4.x (UMD) | Charts on the dashboard |
| Plain HTML/CSS/JS | — | No framework, no build toolchain |

### Architecture
This is a **static HTML project** — no Node.js, no bundler, no build step. All dependencies are loaded from CDN. The two HTML files are standalone pages that talk directly to Supabase from the browser.

```
mcs-map/
├── index.html        # Main map interface
├── dashboard.html    # CRM/manager dashboard
├── installers.json   # Installer data (refreshed daily)
└── HANDOVER.md       # This file
```

### External Services
- **Supabase** — Postgres database + Azure AD OAuth. Project URL: `https://teezsldwkpwzgvfizial.supabase.co`. The anon key is embedded in both HTML files (visible in source — this is intentional for a browser-only app; security is enforced via RLS).
- **OpenStreetMap** via Leaflet tile layer — map tiles.
- **Microsoft Azure AD** — authentication provider, configured via Supabase's OAuth integration. All users sign in with their company Microsoft account.
- **mcscertified.com** — data source for `installers.json`, refreshed each weekday at 9am via an external process (not part of this repo).

---

## 3. Key Files & Their Roles

### `index.html`
The main page. Contains everything in a single file: HTML structure, all CSS, and all JavaScript. Key sections:

- **Login screen** (`#login-screen`) — shown before auth, hidden after. Microsoft OAuth via Supabase Azure provider.
- **Sidebar** (`#sidebar`) — filters, search, technology checkboxes, toggle switches, pipeline stats, colour key.
- **Map** (`#map`) — Leaflet map with a desaturated OSM tile layer and a `MarkerClusterGroup`.
- **Log Contact Modal** (`#modal-overlay`) — form to record a call outcome against an installer.

Key JavaScript globals:
- `allMarkers` — array of all `L.circleMarker` instances. Each marker has `marker._d` set to the installer's data object from `installers.json`.
- `contactMap` — object keyed by `installer_id`, value is array of contact records from Supabase. Rebuilt on every `loadContacts()` call.
- `activeTechs` — `Set` of technology names currently active in the filter.
- `TECHS` — object mapping technology name → hex colour. Controls both marker fill colour and tech filter dots.
- `STATUS` — object mapping contact outcome → stroke colour/weight. Controls marker border colour when a contact has been logged.
- `WAREHOUSE` — `[53.5246, -1.0826]` (Amcore's warehouse in Rotherham). Used as the centre of the 50-mile delivery radius circle.

Auth flow: `db.auth.getSession()` on load → if session exists, call `startApp()` which fetches `installers.json`, calls `initMap()`, then `loadContacts()`. `onAuthStateChange` handles the post-OAuth redirect case.

### `dashboard.html`
Manager/team dashboard. Also a single self-contained file. Key sections:

- **Header** — navigation back to map, export CSV, sign-out, user name display.
- **Summary cards** — today's contacts, this week, pipeline counts by outcome.
- **Charts** — three Chart.js canvases: pipeline doughnut (latest outcome per installer), daily activity bar (last 30 days), activity by employee horizontal bar.
- **Filters** — date range, employee dropdown, outcome, installer name search.
- **Contact log table** — paginated (50 per page), sortable columns, edit/delete actions.
- **Edit modal** (`#edit-overlay`) — inline editing of a contact log entry.

Key JavaScript globals:
- `ADMIN_EMAILS` — `['greg@amcorenewables.co.uk']`. Only email in this array gets admin privileges.
- `IS_ADMIN()` — function returning `isAdmin(currentUser)`. Gates the "Show deleted records" toggle and determines edit/delete permissions.
- `allData` / `filtered` — full dataset and current filtered view.
- `showDeleted` — boolean, toggled by admin only, includes soft-deleted records in the query when true.
- `activeCharts` — object holding Chart.js instances so they can be destroyed and rebuilt on data reload without memory leaks.

**Soft delete:** Records are never hard-deleted. `deleteContact()` sets `deleted_at` and `deleted_by` on the row. `restoreContact()` nulls them out. Only admins can restore. The `loadData()` query filters `deleted_at IS NULL` unless `showDeleted` is true.

**Edit audit trail:** `edit-save` writes `updated_at` (ISO timestamp) and `updated_by` (user email) to the row on every edit. These are shown as small badges in the table.

### `installers.json`
Static data file. Array of installer objects. Each object has at minimum:
```json
{
  "id": "...",
  "name": "...",
  "lat": 53.123,
  "lng": -1.456,
  "postcode": "S1 1AA",
  "address": "...",
  "phone": "...",
  "email": "...",
  "website": "...",
  "techs": ["Solar Photovoltaic", "Battery Storage"],
  "bus": true,
  "cert": "MCS/...",
  "cert_body": "..."
}
```
`techs` is an array of strings matching keys in the `TECHS` object. `bus` is a boolean for the BUS scheme filter. Fields may be null/missing — all rendering code handles this gracefully.

---

## 4. Current State of the Project

### Fully Built & Working
- Interactive map with clustering, desaturated tile layer, and circle marker styling
- All 13 technology filters with colour-coded dots and installer counts
- BUS scheme toggle filter
- 50-mile delivery radius circle from warehouse
- Contact status filter dropdown
- Company name / postcode search
- Colour-coded markers by latest contact outcome
- Log Contact modal with outcome, notes, and follow-up date (shown only for "Follow Up" outcome)
- Contact history displayed inside marker popups (last 4 entries)
- Mobile-responsive sidebar with overlay toggle
- Microsoft Azure AD login (via Supabase OAuth) on both pages
- Dashboard with all three charts
- Paginated, sortable contact log table
- CSV export of filtered data
- Soft delete with restore (admin only)
- Edit audit trail (updated_at / updated_by)
- Admin-only "Show deleted records" toggle
- **Users can edit/delete their own logs** (implemented in this session)
- **RLS policy tightened** — database now enforces update permissions, not just the frontend (implemented in this session)
- Pipeline stats in sidebar (counts per outcome)
- Map colour key in sidebar

### Not Started / Potential Future Work
- Follow-up date reminders or alerts (the `follow_up_date` field is stored but never surfaced as a notification)
- Bulk actions on the dashboard (e.g. bulk delete, bulk reassign)
- User management UI (adding/removing admin emails currently requires a code change)
- Automated `installers.json` refresh process (exists but is outside this repo)

---

## 5. Known Issues & Bugs

- **Ownership check is name-based, not ID-based.** The `employee` field stores the user's display name from `getUserName()`. The RLS policy and the frontend ownership check both use `COALESCE(full_name, name, email_prefix)` to match. This is reliable because the Log Contact modal locks the employee field to the authenticated user's name (`empField.readOnly = true` when `currentUser` exists). However, if a user's display name changes in Azure AD, their old log entries will no longer be recognised as theirs. A future improvement would be to store `auth.uid()` in a separate column and use that for ownership.

- **Employee filter on dashboard is append-only.** `populateEmployeeFilter()` appends `<option>` elements on each `loadData()` call without clearing first. In practice `loadData()` is only called a few times per session so duplicates don't accumulate, but it's worth cleaning up.

- **No loading state on dashboard.** The table shows "Loading…" on initial load but there's no spinner or disabled state on the filter controls while data is fetching.

---

## 6. Design & UI Decisions

### Colour Palette
| Use | Hex |
|---|---|
| Primary blue (sidebar header, buttons, links) | `#1a5276` |
| Sidebar background | `#0f1d2b` |
| Sidebar dark background | `#07111c` |
| Sidebar border | `#1e3045` |
| Outcome — Interested | `#f39c12` |
| Outcome — Follow Up | `#e67e22` |
| Outcome — Converted | `#27ae60` |
| Outcome — Existing Customer | `#7d3c98` |
| Outcome — Not Interested | `#7f8c8d` |
| Outcome — No Answer | `#bdc3c7` |
| Outcome — Removed from MCS | `#922b21` |
| Default marker (not contacted) | `#222` |

### Typography
Arial, sans-serif throughout. No custom fonts.

### Visual Style
- `index.html` sidebar: dark navy theme, light body map.
- `dashboard.html`: light grey page background (`#f0f4f8`), white cards with subtle box-shadow.
- Map tiles are desaturated via CSS filter: `saturate(0.35) brightness(1.05)` applied to `.leaflet-tile-pane`.
- Markers are `L.circleMarker` with `radius: 7`. Marker colour encodes the latest contact outcome; white border (`color: "#fff"`, `weight: 1.5`).
- Cluster icons are custom dark circles (`#2c3e50`) with white count text.

### Mobile
- Sidebar slides in from the left on mobile (< 768px) using a CSS transition on `left`.
- A hamburger button (`#menu-btn`) appears fixed top-left on mobile.
- A semi-transparent overlay (`#sidebar-overlay`) closes the sidebar on tap-outside.

---

## 7. Configuration & Environment

There are **no environment variables** and **no build process**. All configuration is hardcoded in the HTML files:

| Value | Location | Notes |
|---|---|---|
| Supabase URL | Both HTML files, `createClient()` call | `https://teezsldwkpwzgvfizial.supabase.co` |
| Supabase anon key | Both HTML files, `createClient()` call | Long JWT string, safe to be public — RLS enforces security |
| Admin email | `dashboard.html`, `ADMIN_EMAILS` array | `greg@amcorenewables.co.uk` |
| Warehouse coords | `index.html`, `WAREHOUSE` constant | `[53.5246, -1.0826]` |
| Delivery radius | `index.html`, `radiusCircle` | 50 miles (50 * 1609.344 metres) |

**Deployment:** The site is static files — just serve the directory. No build step, no package.json. Works with any static file host or even opened directly in a browser from the filesystem (CORS permitting for the `installers.json` fetch).

**Supabase RLS policies on `contacts` table (as of latest session):**
| Policy name | Command |
|---|---|
| Authenticated read | SELECT |
| Authenticated insert | INSERT |
| Authenticated delete | DELETE |
| contacts_update_policy | UPDATE |

The `contacts_update_policy` (UPDATE) is the non-trivial one — admins can update any record; non-admins can only update their own non-deleted records. See Section 8 for why.

---

## 8. Important Conventions & Rules

### Do Not Reverse: Name-based employee field
The `employee` field on the `contacts` table stores the user's display name as a string, not their UUID. The RLS `contacts_update_policy`, the dashboard's ownership check (`r.employee === currentName`), and the edit modal's field locking all depend on this. Changing to UUID-based ownership would require a schema migration, a data migration, and updates to all three of those places simultaneously.

### Do Not Reverse: Soft delete pattern
Records in `contacts` are never hard-deleted. `deleteContact()` sets `deleted_at`/`deleted_by`. The `loadData()` query filters `is('deleted_at', null)` by default. Hard-deleting would bypass the restore capability and lose audit history. The "Authenticated delete" RLS policy exists on the table but is not used by the application code — it's a safety net only.

### Admin access is email-based, frontend-only for UI gating
`ADMIN_EMAILS` in `dashboard.html` controls what the UI shows. The database enforces update permissions via the RLS `contacts_update_policy` which also hardcodes the admin email. If you add a new admin, update **both** places.

### `marker._d` convention
Every Leaflet marker on the map has its installer data object attached as `marker._d`. This is used throughout — in `buildPopup()`, `applyMarkerStyle()`, `latestContact()`, and event handlers. Don't replace this with a different property name without updating all references.

### Single-file architecture
Both pages are intentionally self-contained single HTML files. This was a deliberate choice to keep the project simple and deployable anywhere without a build step. Don't split into separate JS/CSS files unless there's a strong reason — it adds complexity with no toolchain to manage it.

### `getUserName()` must stay consistent
The `getUserName()` function exists in **both** `index.html` and `dashboard.html` with identical logic:
```js
user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'User'
```
This exact priority order is also mirrored in the Supabase RLS `contacts_update_policy` via `COALESCE(NULLIF(full_name,''), NULLIF(name,''), split_part(email,'@',1))`. If you change the priority order in the JS, you must update the SQL policy too, or ownership checks will break.

---

## 9. How to Continue Development

### To pick up immediately
1. Open `index.html` and `dashboard.html` in a browser (or serve the directory locally).
2. Sign in with a Microsoft account that has access to the Supabase Azure AD OAuth app.
3. `installers.json` must be present — it's a large static file not committed to git (or is, depending on current state). If missing, the map will show "Failed to load installer data."

### Suggested next steps
1. **Follow-up date alerts** — the `follow_up_date` column is populated when outcome is "Follow Up" but is never surfaced as a reminder. A dashboard widget or highlighted row for overdue follow-ups would be useful.
2. **Store `auth.uid()` alongside `employee`** — add a `user_id uuid` column to `contacts`, populate it on insert from `db.auth.getUser()`, and migrate the RLS policy to use `auth.uid() = user_id` instead of name matching. This makes ownership robust against name changes in Azure AD.
3. **Fix the employee filter duplication bug** — in `populateEmployeeFilter()`, clear existing options (except the "All employees" placeholder) before appending, in case `loadData()` is called multiple times.
4. **Admin email as a Supabase config** — rather than hardcoding `greg@amcorenewables.co.uk` in both the JS and the RLS policy, consider a `admins` table with a single row, and query it. This avoids the need to redeploy when admin access changes.

### Context a new Claude needs
- The project has **no build toolchain** — don't suggest npm, webpack, or TypeScript unless the user explicitly wants to add them.
- The user (Greg) is the admin (`greg@amcorenewables.co.uk`).
- The Supabase project is already fully set up — tables exist, auth is configured, RLS is in place.
- The most recent work (this session) was: adding user self-edit/delete on the dashboard, and tightening the Supabase UPDATE RLS policy to enforce ownership at the database level rather than only in the frontend.
- The git repo is at `C:\Users\GregRoy\mcs-map` and is clean/up to date with `origin/main` as of this session.
