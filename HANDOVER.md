# MCS Installer Map — Project Handover

## 1. Project Overview

**MCS Installer Map** is an internal sales/business-development tool for **Amco Renewables**. It visualises all MCS (Microgeneration Certification Scheme) certified installers across the UK on an interactive map, and provides a lightweight CRM layer so the sales team can log outreach calls, track contact status, and manage a pipeline of potential installer partners.

**Target audience:** Internal staff at Amco Renewables (sales/BD team + one manager).

**Live URL:** `https://catchsit.github.io/mcs-map/`

---

## 2. Tech Stack & Architecture

### Languages & Libraries
| Library | Version | Purpose |
|---|---|---|
| Leaflet.js | 1.9.4 | Interactive map rendering |
| Leaflet.MarkerCluster | 1.5.3 | Clustering map markers |
| Supabase JS SDK | 2.x (UMD) | Database + authentication client |
| Chart.js | 4.x (UMD) | Charts on the dashboard |
| Inter (Google Fonts) | — | UI typography |
| Plain HTML/CSS/JS | — | No framework, no build toolchain |

### Architecture
This is a **static HTML project** — no Node.js, no bundler, no build step. All dependencies are loaded from CDN. The HTML files talk directly to Supabase from the browser.

The backend automation runs entirely as **Supabase Edge Functions** (Deno/TypeScript), triggered by `pg_cron` schedules. There is no separate CI/CD pipeline for data — the scraper pushes `installers.json` directly to GitHub via the GitHub API.

```
mcs-map/
├── index.html                              # Main map interface
├── dashboard.html                          # CRM/manager dashboard
├── followups.html                          # Dedicated follow-ups page
├── installers.json                         # Installer data — updated daily by mcs-scraper
├── HANDOVER.md                             # This file
├── shared/
│   ├── status-config.js                   # Contact outcome colours/labels (single source of truth)
│   └── escape-html.js                     # HTML escaping utility
└── supabase/
    ├── migrations/
    │   ├── 001_contacts_schema.sql        # contacts table
    │   ├── 002_contacts_rls.sql           # RLS policies
    │   ├── 003_cron_schedule.sql          # pg_cron: send-followup-digest (07:00 UTC Mon–Fri)
    │   ├── 004_cron_weekly_summary.sql    # pg_cron: send-weekly-summary (08:00 UTC Monday)
    │   ├── 005_installer_ids.sql          # installer_ids table
    │   ├── 006_cron_mcs_monitor.sql       # (superseded by 008)
    │   ├── 007_mcs_new_installers.sql     # mcs_new_installers staging table
    │   └── 008_cron_mcs_split.sql         # pg_cron: mcs-scraper (08:00) + mcs-notifier (08:05)
    └── functions/
        ├── mcs-scraper/index.ts           # Fetches MCS, diffs, pushes installers.json
        ├── mcs-notifier/index.ts          # Emails new installer alerts + follow-up summary
        ├── send-followup-digest/index.ts  # Per-employee follow-up reminder emails
        └── send-weekly-summary/index.ts   # Monday morning team summary email
```

### External Services
- **Supabase** — Postgres database + Azure AD OAuth. Project URL: `https://teezsldwkpwzgvfizial.supabase.co`. The anon key is embedded in both HTML files (visible in source — intentional; security enforced via RLS).
- **GitHub Pages** — hosts the static HTML at `https://catchsit.github.io/mcs-map/`.
- **GitHub API** — `mcs-scraper` pushes `installers.json` commits directly via the Git Data API using a PAT stored as a Supabase secret.
- **OpenStreetMap** via Leaflet tile layer — map tiles.
- **Microsoft Azure AD** — authentication provider, configured via Supabase's OAuth integration. All users sign in with their company Microsoft account.
- **Gmail SMTP** — all automated emails sent via `mcsinstallers.alerts@gmail.com` using an App Password stored as Supabase secret `GMAIL_APP_PASSWORD`.
- **mcscertified.com** — data source. The `mcs-scraper` Edge Function fetches directly from the WordPress AJAX endpoint at `https://mcscertified.com/wp-admin/admin-ajax.php`.

---

## 3. Key Files & Their Roles

### `index.html`
The main map page. Single self-contained file. Layout: fixed top nav above a flex row of sidebar + map.

- **Top nav** — map pin icon (active here), bar chart icon (links to dashboard), follow-ups badge with count of open follow-ups, user initials avatar, sign-out.
- **Login screen** — shown before auth, hidden after. Microsoft OAuth via Supabase Azure provider.
- **Sidebar** — filters (search, contact status, technology chips, BUS toggle, radius toggle), pipeline stats, reset button.
- **Map** — Leaflet map with desaturated OSM tile layer and a `MarkerClusterGroup`.
- **Log Contact Modal** — form to record a call outcome against an installer. Fields: outcome (chip selector), notes, next action, follow-up date (Follow Up only).

Key JavaScript globals:
- `allMarkers` — array of all `L.marker` instances. Each has `marker._d` set to the installer data object from `installers.json`.
- `contactMap` — object keyed by `installer_id`, value is array of contact records from Supabase. Rebuilt on every `loadContacts()` call.
- `activeTechs` — `Set` of technology names currently active in the filter.
- `TECHS` — object mapping technology name → hex colour. Used for tech filter dots and popup tags only (not marker colour).
- `STATUS` — object mapping contact outcome → `{ color, soft, label }`. Drives marker pin colour and popup pills.
- `WAREHOUSE` — `[53.5436, -1.0992]` (Amco warehouse, Unit 8 Wheatley Hall Trade Park, Doncaster DN2 4NH). Centre of the 50-mile delivery radius circle.

### `dashboard.html`
Manager/team dashboard.

- **Period toggles** — Today / Week / Month / Year / All. Controls the Contacts made card, Daily activity chart, and By employee chart.
- **4 Summary cards** — Contacts made, Follow ups open, Coverage %, Not interested.
- **3 Charts** — Daily activity (bar), Pipeline composition (doughnut), By employee (horizontal bar).
- **Filters + table** — date range, employee, outcome, search. Paginated (50/page), sortable, CSV export.
- **Edit modal** — inline editing of a contact log entry.
- **Log Contact modal** — log a contact directly from the dashboard without going to the map.

Key globals:
- `ADMIN_EMAILS` — `['greg@amcorenewables.co.uk']`. Gates "Show deleted" toggle and edit/delete permissions.
- `activePeriod` — `'today'|'week'|'month'|'year'|'all'`, default `'month'`.

### `followups.html`
Lists installers whose **latest** contact record has `outcome = 'Follow Up'`, grouped into Overdue, Due today, and Upcoming. Log Contact modal on each card. After saving a non-Follow-Up outcome the card disappears automatically.

### `installers.json`
Static data file pushed to GitHub by `mcs-scraper` each time new installers are detected. Array of objects:
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

---

## 4. Edge Functions

All four functions are deployed to the Supabase project and triggered by `pg_cron`. They all use `mcsinstallers.alerts@gmail.com` via Gmail SMTP. The cron schedules are live — check `SELECT * FROM cron.job;` in the Supabase SQL editor to confirm.

### `mcs-scraper` — runs 08:00 UTC Mon–Fri
Fetches all MCS-certified installers, detects new ones, and updates the map.

1. Loads all known installer IDs from the `installer_ids` table.
2. Fetches a fresh WordPress nonce from `mcscertified.com/find-an-installer/`.
3. Queries `admin-ajax.php` (`action=filter_installers`) for each of the 13 technology types in **parallel**, paginating until the API returns a partial page (genuine end of results) or 500 pages.
4. Diffs fetched IDs against `installer_ids` to find new installers.
5. If new installers found:
   - Upserts their IDs into `installer_ids`.
   - Upserts their full data into `mcs_new_installers` (staging table, `notified_at = null`).
   - Pushes updated `installers.json` to GitHub via the Git Data API.
6. On first run (empty `installer_ids`): seeds the table without queuing notifications.

### `mcs-notifier` — runs 08:05 UTC Mon–Fri
Sends a daily email to `greg@amcorenewables.co.uk` combining two sections:
- **New installers** — reads up to 10 rows from `mcs_new_installers` where `notified_at IS NULL`, shows installer cards with contact details. Shows total count if more than 10 are pending.
- **Follow-ups due today** — reads `contacts` where `follow_up_date = today` and `deleted_at IS NULL`.

After sending, marks all pending `mcs_new_installers` rows as `notified_at = now()`. Sends nothing if both sections are empty.

### `send-followup-digest` — runs 07:00 UTC Mon–Fri
Sends **per-employee** follow-up reminder emails. Groups `contacts` where `follow_up_date = today (UK)` by `employee_email`, sends one digest per person. Only employees with `employee_email` set receive emails.

### `send-weekly-summary` — runs 08:00 UTC every Monday
Sends a weekly summary to `greg@amcorenewables.co.uk` covering:
- This week's activity by employee (contact count per person).
- Pipeline snapshot: Follow-ups open, Interested, Converted, Not Interested counts; overdue follow-up warning if any.
- Last 15 contacts logged in the past 7 days.

---

## 5. Database Schema

Authoritative SQL is in `supabase/migrations/`. Summary below.

### `contacts` table
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `installer_id` | text | Matches `id` field in `installers.json` |
| `installer_name` | text | Denormalised name for display |
| `employee` | text | User's display name (from `getUserName()`) |
| `employee_email` | text | User's email — used by follow-up digest |
| `outcome` | text | One of the 7 outcome values |
| `notes` | text | Free-text call notes |
| `next_action` | text | Next step to take |
| `follow_up_date` | date | Set when outcome is "Follow Up" |
| `contacted_at` | timestamptz | Auto-set to `now()` on insert |
| `updated_at` | timestamptz | Set on every edit |
| `updated_by` | text | Email of editor |
| `deleted_at` | timestamptz | Soft-delete timestamp |
| `deleted_by` | text | Email of deleter |

### `installer_ids` table
Cumulative record of every MCS installer ID ever seen. Used by `mcs-scraper` for daily diffing. Rows are only added, never removed.
| Column | Type | Notes |
|---|---|---|
| `installer_id` | text | Primary key — matches `id` in `installers.json` |
| `installer_name` | text | Name at time of first detection |
| `first_seen_at` | timestamptz | Auto-set to `now()` on insert |

### `mcs_new_installers` table
Staging table: new installers queued for email notification. Written by `mcs-scraper`, read and marked by `mcs-notifier`.
| Column | Type | Notes |
|---|---|---|
| `id` | bigserial | Primary key |
| `installer_id` | text | MCS installer ID |
| `installer_name` | text | Company name |
| `installer_data` | jsonb | Full raw MCS record (used to build email cards) |
| `detected_at` | timestamptz | When first detected |
| `notified_at` | timestamptz | Null until `mcs-notifier` marks it sent |

---

## 6. Configuration & Environment

No `.env` files — all config is either hardcoded in HTML or stored as Supabase secrets.

### Hardcoded in HTML files
| Value | Location |
|---|---|
| Supabase URL | Both HTML files, `createClient()` |
| Supabase anon key | Both HTML files, `createClient()` |
| Admin email (`greg@amcorenewables.co.uk`) | `dashboard.html` → `ADMIN_EMAILS` array |
| Warehouse coords `[53.5436, -1.0992]` | `index.html` → `WAREHOUSE` constant |
| Delivery radius (50 miles) | `index.html` → `radiusCircle` |

### Hardcoded in Edge Functions
| Value | Location |
|---|---|
| `greg@amcorenewables.co.uk` | `mcs-notifier` → `NOTIFY_TO`, `send-weekly-summary` → `MANAGER_EMAIL` |
| `mcsinstallers.alerts@gmail.com` | All four Edge Functions |
| `CatchSit/mcs-map` repo + `installers.json` path | `mcs-scraper` |

### Supabase secrets (Edge Function environment)
| Secret | Purpose |
|---|---|
| `GMAIL_APP_PASSWORD` | Gmail App Password for `mcsinstallers.alerts@gmail.com` — **no spaces** |
| `GITHUB_PAT` | GitHub Personal Access Token with `contents: write` on `CatchSit/mcs-map` — used by `mcs-scraper` to push `installers.json` |
| `SUPABASE_URL` | Auto-injected by Supabase runtime |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by Supabase runtime |

### RLS policies on `contacts` table
| Policy | Command | Rule |
|---|---|---|
| Authenticated read | SELECT | Any authenticated user |
| Authenticated insert | INSERT | Any authenticated user |
| Authenticated delete | DELETE | Safety net (not used by app code) |
| contacts_update_policy | UPDATE | Admin OR (own record AND not deleted) |

The `contacts_update_policy` uses `COALESCE(NULLIF(full_name,''), NULLIF(name,''), split_part(email,'@',1))` to match the employee name — must stay in sync with `getUserName()` in JS.

---

## 7. Current State

### Fully Built & Working
- Interactive map with pin-shaped markers, clustering, and desaturated tile layer
- Pin colour encodes latest pipeline status; uncontacted installers show as black pins
- All 13 technology filters with colour-coded dots and counts
- BUS scheme toggle filter
- 50-mile delivery radius circle from Amco warehouse (DN2 4NH)
- Contact status filter dropdown
- Company name / postcode search
- Log Contact modal with outcome chips, notes, next action, follow-up date
- Contact history in marker popups (last 4 entries)
- Mobile-responsive sidebar
- Microsoft Azure AD login on all pages
- Shared top nav on all pages (follow-ups badge, user avatar, sign out)
- Dashboard period toggles (Today / Week / Month / Year / All)
- 4 dashboard summary cards
- 3 dashboard charts: Daily activity, Pipeline composition, By employee
- Log contact directly from dashboard
- Paginated, sortable contact log table with CSV export
- Soft delete with restore (admin only)
- Edit audit trail (`updated_at` / `updated_by`)
- Admin-only "Show deleted records" toggle
- `mcs-scraper` Edge Function — daily MCS fetch, diff, `installers.json` push to GitHub
- `mcs-notifier` Edge Function — daily email: new installers + today's follow-ups (to manager)
- `send-followup-digest` Edge Function — daily per-employee follow-up reminders
- `send-weekly-summary` Edge Function — Monday morning team summary (to manager)
- `followups.html` — overdue / due-today / upcoming buckets with Log Contact modal

### Potential Future Work
- **UUID-based ownership** — the `employee` field stores a display name string; if someone's Azure AD name changes, old records won't be recognised as theirs. Adding a `user_id uuid` column + migrating RLS would fix this.
- **Admin email as Supabase config** — replace hardcoded `greg@amcorenewables.co.uk` in JS and Edge Functions with an `admins` table lookup.
- **Follow-up overdue highlighting** — in the dashboard table, highlight rows where `follow_up_date < today` and outcome is still "Follow Up".
- **Bulk actions** on the dashboard (bulk delete, bulk reassign).
- **Region sweep in mcs-scraper** — currently fetches one query per technology type. Adding a region-centre sweep (as well as per-tech) would improve coverage of installers at the edges of the UK.

---

## 8. Known Issues & Bugs

- **Ownership check is name-based, not ID-based.** The `employee` field stores the user's display name. The RLS policy and frontend ownership check both use `COALESCE(full_name, name, email_prefix)`. If a user's Azure AD display name changes, old log entries won't be recognised as theirs.

- **No loading state on dashboard.** The table shows "Loading…" on initial load but there's no spinner or disabled state on filters while data is fetching.

- **Coverage card requires `installers.json` fetch.** On dashboard load, `installers.json` is fetched to get the total count. Until that resolves, the card shows raw contacted count rather than a percentage.

---

## 9. Design & UI Decisions

### Design System
"Daylight" — a warm off-white/sage palette. CSS custom properties defined in `:root` on both pages. Inter font throughout.

### Colour Palette
| Use | Hex / Token |
|---|---|
| Page background | `#fafaf7` (`--bg`) |
| Surface (cards, modals) | `#ffffff` (`--surface`) |
| Surface 2 (inputs, hover) | `#f4f4ee` (`--surface2`) |
| Border | `#e6e4d9` (`--border`) |
| Primary text | `#1f2117` (`--text`) |
| Secondary text | `#535649` (`--text2`) |
| Muted text | `#8e9080` (`--text3`) |
| Accent (buttons, links) | `#5d8a64` (`--accent`) |
| Accent dark | `#2f5a3d` (`--accentDk`) |
| Outcome — Interested | `#5d8a64` |
| Outcome — Follow Up | `#c08438` |
| Outcome — Converted | `#2f5a3d` |
| Outcome — Existing Customer | `#6f5b94` |
| Outcome — Not Interested | `#8e9080` |
| Outcome — No Answer | `#b9b9a9` |
| Outcome — Removed from MCS | `#b85544` |
| Uncontacted marker (pin) | `#000000` |

### Marker Design
- Shape: teardrop/pin (`L.divIcon` with `clip-path: path(...)`) — 16×23px.
- Colour: latest pipeline status colour; black when uncontacted.
- Clusters: white circle with sage-green border, contact count text.
- Technology colours (`TECHS`) are only used in sidebar filter chips and popup tags — not pin colour.

### Layout
- **Map page:** `body` is flex-column. Top nav (52px) + `#main-wrap` (flex-row of sidebar 320px + map flex:1).
- **Dashboard:** Standard document flow. Sticky top nav, scrollable main content.
- Map tiles desaturated: `saturate(0.35) brightness(1.04) contrast(0.96)` on `.leaflet-tile-pane`.
- Dashboard cards collapse to 2 columns below 768px.

---

## 10. Important Conventions & Rules

### Do Not Reverse: Name-based employee field
The `employee` field stores the user's display name, not UUID. The RLS `contacts_update_policy`, dashboard ownership check, and edit modal field locking all depend on this. Changing to UUID requires a schema migration, data migration, and updates to all three simultaneously.

### Do Not Reverse: Soft delete pattern
Records are never hard-deleted. `deleteContact()` sets `deleted_at`/`deleted_by`. Hard-deleting bypasses restore and loses audit history.

### Admin access is email-based — update in multiple places
`ADMIN_EMAILS` in `dashboard.html` controls UI gating. The database RLS `contacts_update_policy` also hardcodes the admin email. If adding a new admin, update **both** plus the `NOTIFY_TO` / `MANAGER_EMAIL` constants in the Edge Functions if relevant.

### `marker._d` convention
Every Leaflet marker has its installer data attached as `marker._d`. Used in `buildPopup()`, `applyMarkerStyle()`, `latestContact()`, and event handlers. Don't rename without updating all references.

### `makeMarkerIcon(d, latest)` — pin colour logic
```js
const color = (latest && STATUS[latest.outcome]) ? STATUS[latest.outcome].color : '#000000';
```
Technology colours (`TECHS`) are **not** used for pin colour. Uncontacted = black.

### `getUserName()` must stay consistent
Identical logic in all three HTML files and mirrored in the RLS policy:
```js
user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'User'
```
If you change the priority order in JS, update the SQL policy too.

### Single-file architecture
HTML pages are intentionally self-contained. Keep it this way — it removes the need for any build toolchain.

### Period toggle vs. table filter are independent
The period toggle (Today/Week/Month/Year/All) on the dashboard controls charts and the Contacts card only. The date range filter controls the contact log table only. They do not interact.

### mcs-scraper only pushes installers.json when new installers are found
If a daily run finds no new MCS installers, `installers.json` is not touched. This is intentional — no-op runs produce no commit noise.

---

## 11. How to Continue Development

### To pick up immediately
1. Open `index.html`, `dashboard.html`, or `followups.html` in a browser (or `npx serve .`).
2. Sign in with a Microsoft account that has access to the Supabase Azure AD OAuth app.
3. `installers.json` must be present. If missing, the map shows "Failed to load installer data."

### To deploy Edge Function changes
```bash
supabase functions deploy mcs-scraper
supabase functions deploy mcs-notifier
supabase functions deploy send-followup-digest
supabase functions deploy send-weekly-summary
```

### To trigger the scraper manually
In the Supabase dashboard → Edge Functions → `mcs-scraper` → Invoke (or `mcs-notifier` to send the email immediately).

### To check cron schedules
```sql
SELECT * FROM cron.job;
```

### Suggested next steps
1. **UUID-based ownership** — add `user_id uuid` to `contacts`, populate on insert via `auth.uid()`, migrate RLS.
2. **Admin email as config** — replace hardcoded emails in JS and Edge Functions with an `admins` table.
3. **Region sweep in mcs-scraper** — add a second sweep querying by region centre coordinates to improve installer coverage beyond the current ~5,500.
4. **Follow-up overdue highlighting** — highlight rows in the dashboard table where `follow_up_date < today` and outcome is still "Follow Up".
