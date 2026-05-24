# MCS Installer Map — Project Handover

## 1. Project Overview

**MCS Installer Map** is an internal sales/business-development tool for **Amco Renewables**. It visualises all MCS (Microgeneration Certification Scheme) certified installers across the UK on an interactive map, and provides a lightweight CRM layer on top so the sales team can log outreach calls, track contact status, and manage a pipeline of potential installer partners.

**Target audience:** Internal staff at Amco Renewables (sales/BD team + one manager).

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
| Inter (Google Fonts) | — | UI typography |
| Plain HTML/CSS/JS | — | No framework, no build toolchain |

### Architecture
This is a **static HTML project** — no Node.js, no bundler, no build step. All dependencies are loaded from CDN. The two HTML files are standalone pages that talk directly to Supabase from the browser.

```
mcs-map/
├── index.html                          # Main map interface
├── dashboard.html                      # CRM/manager dashboard
├── installers.json                     # Installer data (refreshed daily)
├── HANDOVER.md                         # This file
└── supabase/
    └── functions/
        └── send-followup-digest/
            └── index.ts                # Email digest Edge Function
```

### External Services
- **Supabase** — Postgres database + Azure AD OAuth. Project URL: `https://teezsldwkpwzgvfizial.supabase.co`. The anon key is embedded in both HTML files (visible in source — intentional; security enforced via RLS).
- **OpenStreetMap** via Leaflet tile layer — map tiles.
- **Microsoft Azure AD** — authentication provider, configured via Supabase's OAuth integration. All users sign in with their company Microsoft account.
- **Gmail SMTP** — used by the follow-up digest Edge Function to send email via `mcsinstallers.alerts@gmail.com`.
- **mcscertified.com** — data source for `installers.json`, refreshed each weekday at 9am via an external process (not part of this repo).

---

## 3. Key Files & Their Roles

### `index.html`
The main map page. Single self-contained file. Layout: fixed top nav above a flex row of sidebar + map.

- **Top nav** (`#top-nav`) — shared nav present on both pages. Map pin icon (active here), bar chart icon (links to dashboard), Follow-ups badge with count of open follow-ups, user initials avatar, sign-out.
- **Login screen** (`#login-screen`) — shown before auth, hidden after. Microsoft OAuth via Supabase Azure provider.
- **Sidebar** (`#sidebar`) — filters (search, contact status, technology chips, BUS toggle, radius toggle), pipeline stats, reset button.
- **Map** (`#map`) — Leaflet map with desaturated OSM tile layer and a `MarkerClusterGroup`.
- **Log Contact Modal** (`#modal-overlay`) — form to record a call outcome against an installer. Fields: outcome (chip selector), notes, next action, follow-up date (Follow Up only).

Key JavaScript globals:
- `allMarkers` — array of all `L.marker` instances (using `L.divIcon` pin shapes). Each has `marker._d` set to the installer data object from `installers.json`.
- `contactMap` — object keyed by `installer_id`, value is array of contact records from Supabase. Rebuilt on every `loadContacts()` call.
- `activeTechs` — `Set` of technology names currently active in the filter.
- `TECHS` — object mapping technology name → hex colour. Used for tech filter dots and popup tags only (not marker colour).
- `STATUS` — object mapping contact outcome → `{ color, soft, label }`. Drives marker pin colour and popup pills.
- `WAREHOUSE` — `[53.5436, -1.0992]` (Amco warehouse, Unit 8 Wheatley Hall Trade Park, Doncaster DN2 4NH). Centre of the 50-mile delivery radius circle.

Auth flow: `db.auth.getSession()` on load → if session exists, call `startApp()` which fetches `installers.json`, calls `initMap()`, then `loadContacts()`. `onAuthStateChange` handles the post-OAuth redirect case.

### `dashboard.html`
Manager/team dashboard. Single self-contained file.

- **Top nav** (`#top-nav`) — same design as map page. Dashboard bar chart icon is active here. Follow-ups badge shows count of open Follow Up records.
- **Period toggles** — Today / Week / Month / Year / All. Controls the window used by the Contacts made card, Daily activity chart, and By employee chart. Pipeline composition always shows all-time latest state.
- **4 Summary cards:**
  - *Contacts made* — count of contacts logged in the selected period.
  - *Follow ups open* — count of all non-deleted contacts with outcome "Follow Up" (current state, not period-filtered).
  - *Coverage* — % of total installers (from `installers.json`) that have ever been contacted.
  - *Not interested* — count of installers whose latest pipeline status is "Not Interested".
- **3 Charts** (side by side, grid `2fr 1.5fr 1.5fr`):
  - *Daily activity* — bar chart of contacts in the selected period window.
  - *Pipeline composition* — doughnut of latest outcome per installer (always all-time).
  - *By employee* — horizontal bar of contacts per person in the selected period.
- **Filters + table** — independent of the period toggle. Date range, employee, outcome, search. Paginated (50/page), sortable columns. Export CSV in table header.
- **Edit modal** (`#edit-overlay`) — inline editing of a contact log entry.
- **Log Contact modal** (`#log-overlay`) — log a contact directly from the dashboard without going to the map. Installer search by name/postcode.

Key JavaScript globals:
- `ADMIN_EMAILS` — `['greg@amcorenewables.co.uk']`. Only email in this array gets admin privileges.
- `IS_ADMIN()` — function returning `isAdmin(currentUser)`. Gates "Show deleted" toggle and edit/delete permissions.
- `allData` / `filtered` — full dataset and current filtered view for the table.
- `activePeriod` — string (`'today'|'week'|'month'|'year'|'all'`), default `'month'`. Drives charts and Contacts card.
- `showDeleted` — boolean, toggled by admin only.
- `totalInstallerCount` — loaded lazily from `installers.json` for the Coverage card.
- `activeCharts` — object holding Chart.js instances; destroyed and rebuilt to avoid memory leaks.

**Soft delete:** Records are never hard-deleted. `deleteContact()` sets `deleted_at`/`deleted_by`. `restoreContact()` nulls them. Only admins can restore. `loadData()` filters `deleted_at IS NULL` unless `showDeleted` is true.

**Edit audit trail:** Every save via the edit modal writes `updated_at` (ISO timestamp) and `updated_by` (user email). Shown as small badges in the table.

### `supabase/functions/send-followup-digest/index.ts`
Deno Edge Function. Runs on a `pg_cron` schedule (`0 7 * * 1-5` — 7am UTC = 8am BST / 7am GMT, weekdays only).

- Queries `contacts` where `follow_up_date = today (UK)`, `deleted_at IS NULL`, `employee_email IS NOT NULL`.
- Groups results by `employee_email`, sends one digest email per person via Gmail SMTP (`npm:nodemailer`).
- Gmail account: `mcsinstallers.alerts@gmail.com`. Password stored as Supabase secret `GMAIL_APP_PASSWORD` (spaces stripped — Google displays with spaces but the secret must have none).
- UK date handling: `new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })` — correctly handles BST/GMT.

### `installers.json`
Static data file. Array of installer objects:
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
`techs` matches keys in the `TECHS` object. `bus` is a boolean for the BUS scheme filter. Fields may be null/missing — all rendering code handles this gracefully.

---

## 4. Database Schema

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

---

## 5. Current State of the Project

### Fully Built & Working
- Interactive map with pin-shaped markers (`L.divIcon`), clustering, and desaturated tile layer
- Pin colour encodes latest pipeline status; uncontacted installers show as black pins
- All 13 technology filters with colour-coded dots and counts (tech colour used in filters/popups only, not pin colour)
- BUS scheme toggle filter
- 50-mile delivery radius circle from Amco warehouse (DN2 4NH)
- Contact status filter dropdown
- Company name / postcode search
- Log Contact modal with outcome chips, notes, next action, follow-up date (Follow Up only)
- Contact history in marker popups (last 4 entries, showing outcome pill, notes, follow-up date, next action)
- Mobile-responsive sidebar with overlay toggle
- Microsoft Azure AD login on both pages
- Shared top nav on both pages (map/dashboard icon links, follow-ups badge, user avatar, sign out)
- Dashboard period toggles (Today / Week / Month / Year / All)
- 4 dashboard summary cards (Contacts made, Follow ups open, Coverage %, Not interested)
- 3 dashboard charts: Daily activity (period-aware), Pipeline composition (all-time), By employee (period-aware)
- Log contact directly from dashboard (no need to find installer on map)
- Paginated, sortable contact log table
- CSV export of filtered data
- Soft delete with restore (admin only)
- Edit audit trail (updated_at / updated_by)
- Admin-only "Show deleted records" toggle
- Users can edit/delete their own logs; admins can edit/delete any log
- RLS policy enforces ownership at database level (not just frontend)
- Pipeline stats in sidebar (counts per outcome)
- Follow-up email digest — Supabase Edge Function sends morning emails (7am UTC weekdays) to employees with follow-ups due that day

### Not Started / Potential Future Work
- **Follow-ups page** — the nav badge links back to the dashboard; a dedicated page listing overdue and upcoming follow-ups would be more useful.
- **Bulk actions** on the dashboard (bulk delete, bulk reassign).
- **User management UI** — adding/removing admin emails currently requires a code change and redeploy.
- **UUID-based ownership** — the `employee` field stores a display name string; if someone's Azure AD name changes, old records won't be recognised as theirs. Adding a `user_id uuid` column would fix this.
- **Automated `installers.json` refresh** — exists but is outside this repo.

---

## 6. Known Issues & Bugs

- **Ownership check is name-based, not ID-based.** The `employee` field stores the user's display name from `getUserName()`. The RLS policy and frontend ownership check both use `COALESCE(full_name, name, email_prefix)` to match. Reliable in practice because the Log Contact modal locks the employee field to the authenticated user's name. However, if a user's display name changes in Azure AD, their old log entries won't be recognised as theirs.

- **No loading state on dashboard.** The table shows "Loading…" on initial load but there's no spinner or disabled state on filters while data is fetching.

- **Coverage card requires `installers.json` fetch.** On dashboard load, `installers.json` is fetched to get the total count. Until that resolves, the card shows raw contacted count rather than a percentage. This is a lightweight background fetch and resolves quickly.

---

## 7. Design & UI Decisions

### Design System
"Daylight" — a warm off-white/sage palette. CSS custom properties defined in `:root` on both pages. Inter font throughout (loaded from Google Fonts).

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
- Colour: latest pipeline status colour; black (`#000000`) when uncontacted.
- White circle at the pin head for legibility.
- Hover: `transform: scale(1.25)` via CSS.
- Clusters: white circle with sage-green border, contact count text.
- Technology colours (`TECHS`) are only used in the sidebar tech filter chips and popup tags — they no longer affect pin colour.

### Layout
- **Map page:** `body` is flex-column. Top nav (52px) + `#main-wrap` (flex-row of sidebar 320px + map flex:1).
- **Dashboard:** Standard document flow. Sticky top nav, scrollable main content.
- Map tiles desaturated: `saturate(0.35) brightness(1.04) contrast(0.96)` on `.leaflet-tile-pane`.

### Mobile
- Sidebar slides in from the left on mobile (< 768px). Opens via `#menu-btn` (hamburger, positioned below top nav at `top: 64px`). Closes on overlay tap.
- Top nav collapses brand name and user name text on narrow screens; icon buttons remain.
- Dashboard cards collapse to 2 columns below 768px.

---

## 8. Configuration & Environment

No environment variables. No build process. All configuration is hardcoded in the HTML files:

| Value | Location | Notes |
|---|---|---|
| Supabase URL | Both HTML files, `createClient()` | `https://teezsldwkpwzgvfizial.supabase.co` |
| Supabase anon key | Both HTML files, `createClient()` | Long JWT — safe to be public, RLS enforces security |
| Admin email | `dashboard.html`, `ADMIN_EMAILS` array | `greg@amcorenewables.co.uk` |
| Warehouse coords | `index.html`, `WAREHOUSE` constant | `[53.5436, -1.0992]` — Unit 8 Wheatley Hall Trade Park, DN2 4NH |
| Delivery radius | `index.html`, `radiusCircle` | 50 miles (50 × 1609.344 metres) |

**Edge Function environment (Supabase secrets):**
| Secret | Purpose |
|---|---|
| `GMAIL_APP_PASSWORD` | Gmail App Password for `mcsinstallers.alerts@gmail.com` — **no spaces** |
| `SUPABASE_URL` | Auto-injected by Supabase runtime |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by Supabase runtime |

**Supabase RLS policies on `contacts` table:**
| Policy name | Command | Rule |
|---|---|---|
| Authenticated read | SELECT | Any authenticated user |
| Authenticated insert | INSERT | Any authenticated user |
| Authenticated delete | DELETE | Safety net (not used by app code) |
| contacts_update_policy | UPDATE | Admin OR (own record AND not deleted) |

The `contacts_update_policy` uses `COALESCE(NULLIF(full_name,''), NULLIF(name,''), split_part(email,'@',1))` to match the employee name — must stay in sync with `getUserName()` in JS.

**pg_cron schedule for follow-up digest:**
```sql
SELECT cron.schedule('send-followup-digest','0 7 * * 1-5',
  $$SELECT net.http_post(url:='https://teezsldwkpwzgvfizial.supabase.co/functions/v1/send-followup-digest',
    headers:='{"Authorization":"Bearer <anon_key>"}'::jsonb)$$
);
```
Runs 7am UTC Mon–Fri (= 8am BST in summer, 7am GMT in winter).

---

## 9. Important Conventions & Rules

### Do Not Reverse: Name-based employee field
The `employee` field on `contacts` stores the user's display name as a string, not their UUID. The RLS `contacts_update_policy`, the dashboard ownership check (`r.employee === currentName`), and the edit modal field locking all depend on this. Changing to UUID-based ownership requires a schema migration, data migration, and updates to all three simultaneously.

### Do Not Reverse: Soft delete pattern
Records are never hard-deleted. `deleteContact()` sets `deleted_at`/`deleted_by`. Hard-deleting bypasses restore and loses audit history.

### Admin access is email-based — update in two places
`ADMIN_EMAILS` in `dashboard.html` controls UI gating. The database RLS `contacts_update_policy` also hardcodes the admin email. Add a new admin in **both** places.

### `marker._d` convention
Every Leaflet marker has its installer data attached as `marker._d`. Used in `buildPopup()`, `applyMarkerStyle()`, `latestContact()`, and event handlers. Don't rename without updating all references.

### `makeMarkerIcon(d, latest)` — pin colour logic
```js
const color = (latest && STATUS[latest.outcome]) ? STATUS[latest.outcome].color : '#000000';
```
Technology colours (`TECHS`) are **not** used for pin colour. Uncontacted = black. Do not reintroduce tech-colour fallback.

### `getUserName()` must stay consistent
Identical logic in both HTML files and mirrored in the RLS policy:
```js
user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'User'
```
If you change the priority order in JS, update the SQL policy too.

### Single-file architecture
Both pages are intentionally self-contained single HTML files. Keep it this way unless there is a strong reason to split — it removes the need for any build toolchain.

### Period toggle vs. table filter are independent
The period toggle (Today/Week/Month/Year/All) on the dashboard controls the charts and Contacts card only. The date range filter below it controls the contact log table only. They do not interact.

---

## 10. How to Continue Development

### To pick up immediately
1. Open `index.html` and `dashboard.html` in a browser (or serve the directory locally with e.g. `npx serve .`).
2. Sign in with a Microsoft account that has access to the Supabase Azure AD OAuth app.
3. `installers.json` must be present. If missing, the map will show "Failed to load installer data."

### Suggested next steps
1. **Dedicated Follow-ups page** — the nav badge links to the dashboard; a filtered view of overdue and upcoming follow-ups would be more actionable.
2. **UUID-based ownership** — add a `user_id uuid` column to `contacts`, populate on insert via `db.auth.getUser()`, migrate RLS to `auth.uid() = user_id`. Makes ownership robust against Azure AD name changes.
3. **Admin email as Supabase config** — replace hardcoded `greg@amcorenewables.co.uk` in JS and RLS with an `admins` table lookup, so admin access can be changed without a code deploy.
4. **Follow-up overdue highlighting** — in the dashboard table, highlight rows where `follow_up_date < today` and outcome is still "Follow Up".

### Context a new Claude needs
- **No build toolchain** — don't suggest npm, webpack, or TypeScript unless the user explicitly wants to add them.
- The user (Greg) is the admin (`greg@amcorenewables.co.uk`). Company is **Amco Renewables** (previously called Amcore — email domain `@amcorenewables.co.uk` is unchanged).
- The Supabase project is fully set up — tables, auth, RLS, Edge Function, and pg_cron schedule are all live.
- The git repo is at `C:\Users\GregRoy\mcs-map`, deployed to GitHub Pages at `https://catchsit.github.io/mcs-map/`.
- The `.old` files (`index.html.old`, `dashboard.html.old`) in the repo root are backups and can be deleted.
