import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GMAIL_APP_PASSWORD        = Deno.env.get('GMAIL_APP_PASSWORD')!
const GITHUB_PAT                = Deno.env.get('GITHUB_PAT')!

if (!GMAIL_APP_PASSWORD || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GITHUB_PAT) {
  throw new Error('Missing required secret — check GMAIL_APP_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GITHUB_PAT')
}

const GMAIL_USER  = 'mcsinstallers.alerts@gmail.com'
const EMAIL_TO    = 'greg@amcorenewables.co.uk'
const FIND_PAGE   = 'https://mcscertified.com/find-an-installer/'
const AJAX_URL    = 'https://mcscertified.com/wp-admin/admin-ajax.php'
const GITHUB_REPO = 'CatchSit/mcs-map'
const MAP_FILE    = 'installers.json'

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
})

// ─── Technology labels ────────────────────────────────────────────────────────

const TECHNOLOGY_LABELS: Record<string, string> = {
  technology_ashp:          'Air Source Heat Pump',
  technology_battery:       'Battery Storage',
  technology_biomass:       'Biomass',
  technology_eahp:          'Exhaust Air Heat Pump',
  technology_gahp:          'Gas Absorption Heat Pump',
  technology_gshp:          'Ground Source Heat Pump',
  technology_hydro:         'Hydro',
  technology_micro_chp:     'Micro CHP',
  technology_sahp:          'Solar Assisted Heat Pump',
  technology_solar_pv:      'Solar Photovoltaic',
  technology_solar_thermal: 'Solar Thermal',
  technology_wind_turbine:  'Wind Turbine',
  technology_wshp:          'Water Source Heat Pump',
}

const TECH_KEYS = Object.keys(TECHNOLOGY_LABELS)

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer':         FIND_PAGE,
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── Nonce ────────────────────────────────────────────────────────────────────

async function getNonce(): Promise<string> {
  const resp = await fetch(FIND_PAGE, { headers: BROWSER_HEADERS })
  if (!resp.ok) throw new Error(`MCS page returned ${resp.status}`)
  const html = await resp.text()
  const match = html.match(/"nonce"\s*:\s*"([^"]+)"/)
  if (!match) throw new Error('Nonce not found in MCS page HTML — site may have changed')
  return match[1]
}

// ─── Installer fetching ───────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type RawInstaller = Record<string, any>

async function paginate(
  params: URLSearchParams,
  seenIds: Set<string>,
  all: RawInstaller[],
  label: string,
): Promise<void> {
  let page = 1
  while (true) {
    params.set('page', String(page))
    try {
      const resp = await fetch(`${AJAX_URL}?${params}`, { headers: BROWSER_HEADERS })
      if (!resp.ok) { console.warn(`[WARN] ${label} p${page}: ${resp.status}`); break }
      const data = await resp.json()
      if (!data?.success) { console.warn(`[WARN] ${label} p${page}: success=false`); break }
      const batch: RawInstaller[] = data?.data?.data ?? []
      if (!batch.length) break
      let newCount = 0
      for (const inst of batch) {
        const iid: string = inst.installer_id
        if (iid && !seenIds.has(iid)) { seenIds.add(iid); all.push(inst); newCount++ }
      }
      console.log(`  ${label} p${page}: ${batch.length} in, ${newCount} new (${all.length} total)`)
      if (newCount === 0 || page >= 500) break
    } catch (e) {
      console.warn(`[WARN] ${label} p${page} error:`, e)
      break
    }
    page++
    await sleep(100)
  }
}

async function fetchAllInstallers(nonce: string): Promise<RawInstaller[]> {
  // Run all technology queries in parallel — wall-clock time = slowest single
  // query rather than the sum of all queries
  console.log(`[Sweep] ${TECH_KEYS.length} technology queries in parallel ...`)

  const techResults = await Promise.all(
    TECH_KEYS.map(async tech => {
      const localSeen = new Set<string>()
      const localAll:  RawInstaller[] = []
      const p = new URLSearchParams({
        action: 'filter_installers', nonce, form_type: 'installers', search: '',
        'technology[]': tech, user_searched_location: 'region',
        lat: '54.50', lng: '-3.50', per_page: '100',
      })
      await paginate(p, localSeen, localAll, tech)
      return localAll
    })
  )

  // Merge with global deduplication
  const seenIds = new Set<string>()
  const all: RawInstaller[] = []
  for (const list of techResults) {
    for (const inst of list) {
      if (inst.installer_id && !seenIds.has(inst.installer_id)) {
        seenIds.add(inst.installer_id)
        all.push(inst)
      }
    }
  }
  console.log(`[Sweep done] ${all.length} unique installers`)
  return all
}

// ─── Installer helpers ────────────────────────────────────────────────────────

function getTechs(inst: RawInstaller): string[] {
  return Object.entries(TECHNOLOGY_LABELS)
    .filter(([flag]) => inst[flag] === '1')
    .map(([, label]) => label)
}

function getAddress(inst: RawInstaller): string {
  const parts = ['address_line_1', 'address_line_2', 'address_line_3', 'county', 'postcode']
    .map(k => String(inst[k] ?? '').trim())
    .filter(v => v && !['n/a', 'unspecified'].includes(v.toLowerCase()))
  return parts.join(', ') || 'Location not listed'
}

interface MapRecord {
  id: string; name: string; lat: number | null; lng: number | null
  techs: string[]; phone: string; email: string; website: string
  address: string; postcode: string; cert: string; cert_body: string; bus: boolean
}

function toMapRecord(inst: RawInstaller): MapRecord {
  let website = String(inst.website ?? '').trim()
  if (website && !website.startsWith('http')) website = 'https://' + website
  return {
    id:       inst.installer_id,
    name:     String(inst.name ?? 'Unknown').trim(),
    lat:      inst.lat  ? parseFloat(inst.lat)  : null,
    lng:      inst.lng  ? parseFloat(inst.lng)  : null,
    techs:    getTechs(inst),
    phone:    String(inst.telephone ?? '').trim(),
    email:    String(inst.email ?? '').trim(),
    website,
    address:  getAddress(inst),
    postcode: String(inst.postcode ?? '').trim(),
    cert:     String(inst.certification_number ?? '').trim(),
    cert_body:String(inst.certification_body ?? '').trim(),
    bus:      inst.boiler_upgrade_scheme === '1',
  }
}

// ─── GitHub API ───────────────────────────────────────────────────────────────

const GITHUB_HEADERS = {
  Authorization:  `Bearer ${GITHUB_PAT}`,
  Accept:         'application/vnd.github.v3+json',
  'User-Agent':   'mcs-map-monitor',
  'Content-Type': 'application/json',
}

async function getGitHubFile(path: string): Promise<{ text: string; sha: string } | null> {
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: GITHUB_HEADERS,
  })
  if (!resp.ok) return null
  const data = await resp.json()
  const raw = data.content.replace(/\n/g, '')
  const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0))
  return { text: new TextDecoder().decode(bytes), sha: data.sha }
}

function encodeBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(bin)
}

async function updateGitHubFile(path: string, content: string, sha: string): Promise<void> {
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: GITHUB_HEADERS,
    body: JSON.stringify({
      message: 'chore: update installer data [skip ci]',
      content: encodeBase64(content),
      sha,
    }),
  })
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${await resp.text()}`)
}

// ─── Email HTML ───────────────────────────────────────────────────────────────

const TECH_COLOURS: Record<string, string> = {
  'Air Source Heat Pump':     '#1a7a4a',
  'Ground Source Heat Pump':  '#155d3a',
  'Exhaust Air Heat Pump':    '#1d8c55',
  'Gas Absorption Heat Pump': '#23a066',
  'Water Source Heat Pump':   '#178a50',
  'Solar Assisted Heat Pump': '#0e6e3f',
  'Solar Photovoltaic':       '#b07d00',
  'Solar Thermal':            '#c48f00',
  'Battery Storage':          '#6b3fa0',
  'Biomass':                  '#7a5c2e',
  'Hydro':                    '#1565a8',
  'Wind Turbine':             '#0d7da8',
  'Micro CHP':                '#a04040',
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function techBadge(label: string): string {
  const colour = TECH_COLOURS[label] ?? '#555'
  return `<span style="display:inline-block;background:${colour};color:#fff;font-size:11px;font-weight:bold;padding:3px 8px;border-radius:12px;margin:2px 3px 2px 0;">${esc(label)}</span>`
}

function installerCard(inst: RawInstaller): string {
  const name     = esc(String(inst.name ?? 'Unknown').trim())
  const cert     = esc(String(inst.certification_number ?? '').trim())
  const certBody = esc(String(inst.certification_body ?? '').trim())
  const email    = esc(String(inst.email ?? '').trim())
  const phone    = esc(String(inst.telephone ?? '').trim())
  let   website  = String(inst.website ?? '').trim()
  if (website && !website.startsWith('http')) website = 'https://' + website
  const postcode = String(inst.postcode ?? '').trim()
  const location = esc(getAddress(inst))
  const techs    = getTechs(inst)
  const bus      = inst.boiler_upgrade_scheme === '1'
  const subType  = esc(String(inst.technology_sub_type ?? '').trim())

  const badges   = techs.length ? techs.map(techBadge).join('') : '<em>Not specified</em>'
  const busBadge = bus
    ? '<span style="display:inline-block;background:#1a5276;color:#fff;font-size:11px;font-weight:bold;padding:3px 8px;border-radius:12px;margin-left:6px;">BUS Registered</span>'
    : ''
  const certLine = certBody && cert ? `${certBody} &bull; ${cert}` : cert || certBody || 'Not listed'
  const emailLink = email ? `<a href="mailto:${email}" style="color:#1a5276;">${email}</a>` : 'Not listed'
  const phoneLink = phone ? `<a href="tel:${phone}" style="color:#1a5276;">${phone}</a>` : 'Not listed'
  const webLink   = website ? `<a href="${esc(website)}" style="color:#1a5276;">${esc(website)}</a>` : 'Not listed'
  const mapsLink  = postcode
    ? `<a href="https://www.google.com/maps/search/${postcode.replace(/ /g, '+')}" style="color:#1a5276;">${location}</a>`
    : location
  const subLine = subType ? `<br><span style="color:#888;font-size:12px;">${subType}</span>` : ''

  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ddd;border-radius:8px;margin-bottom:16px;font-family:Arial,sans-serif;font-size:14px;color:#333;">
    <tr><td style="background:#1a5276;border-radius:7px 7px 0 0;padding:12px 16px;">
      <span style="color:#fff;font-size:16px;font-weight:bold;">${name}</span>${busBadge}
      <span style="float:right;color:#acd4f5;font-size:12px;">${certLine}</span>
    </td></tr>
    <tr><td style="padding:12px 16px;">
      <div style="margin-bottom:10px;">${badges}${subLine}</div>
      <table cellpadding="0" cellspacing="0" width="100%"><tr>
        <td width="50%" style="vertical-align:top;padding-right:12px;">
          <p style="margin:4px 0;"><strong>&#128222;</strong> ${phoneLink}</p>
          <p style="margin:4px 0;"><strong>&#9993;</strong> ${emailLink}</p>
          <p style="margin:4px 0;"><strong>&#127760;</strong> ${webLink}</p>
        </td>
        <td width="50%" style="vertical-align:top;">
          <p style="margin:4px 0;"><strong>&#128205;</strong> ${mapsLink}</p>
        </td>
      </tr></table>
    </td></tr>
  </table>`
}

interface FollowUp {
  installer_name: string
  employee:       string
  follow_up_date: string
  notes:          string | null
}

function buildHtml(newInstallers: RawInstaller[], runDate: string, followUps: FollowUp[]): string {
  const sections: string[] = []

  if (followUps.length) {
    const rows = followUps.map(f => {
      let dueFmt = f.follow_up_date
      try { dueFmt = new Date(f.follow_up_date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) } catch {}
      return `<tr>
        <td style="padding:10px;border-bottom:1px solid #f5deb3;font-weight:bold;">${esc(f.installer_name)}</td>
        <td style="padding:10px;border-bottom:1px solid #f5deb3;">${esc(f.employee)}</td>
        <td style="padding:10px;border-bottom:1px solid #f5deb3;color:#c0392b;font-weight:bold;">${esc(dueFmt)}</td>
        <td style="padding:10px;border-bottom:1px solid #f5deb3;color:#666;">${f.notes ? esc(f.notes) : '—'}</td>
      </tr>`
    }).join('')
    sections.push(`
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8e8;border:2px solid #e67e22;border-radius:8px;margin-bottom:24px;font-family:Arial,sans-serif;">
      <tr><td style="background:#e67e22;border-radius:6px 6px 0 0;padding:12px 16px;">
        <strong style="color:#fff;font-size:15px;">&#128276; ${followUps.length} Follow-up(s) Due Today</strong>
      </td></tr>
      <tr><td style="padding:0 8px 8px;">
        <table width="100%" style="border-collapse:collapse;font-size:13px;">
          <thead><tr style="background:#fef3d0;">
            <th style="padding:8px 10px;text-align:left;color:#7d5a00;">Installer</th>
            <th style="padding:8px 10px;text-align:left;color:#7d5a00;">Employee</th>
            <th style="padding:8px 10px;text-align:left;color:#7d5a00;">Due Date</th>
            <th style="padding:8px 10px;text-align:left;color:#7d5a00;">Notes</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </td></tr>
    </table>`)
  }

  if (!newInstallers.length) {
    sections.push(`
    <table width="100%" cellpadding="20" style="background:#f0f4f8;border-radius:8px;font-family:Arial,sans-serif;">
      <tr><td style="text-align:center;color:#555;">
        <p style="font-size:18px;">&#10003; No new installers added today.</p>
        <p style="font-size:14px;">The MCS database was checked and is unchanged since yesterday.</p>
      </td></tr>
    </table>`)
  } else {
    const techCounts = new Map<string, number>()
    for (const inst of newInstallers)
      for (const t of getTechs(inst)) techCounts.set(t, (techCounts.get(t) ?? 0) + 1)
    const techSummary = [...techCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${c} &times; ${esc(t)}`).join(' &nbsp;|&nbsp; ')
    const cards = newInstallers.map(installerCard).join('')
    sections.push(`
    <table width="100%" cellpadding="12" style="background:#eaf3fb;border-radius:8px;margin-bottom:20px;font-family:Arial,sans-serif;">
      <tr><td>
        <p style="margin:0;font-size:15px;color:#1a5276;">
          <strong>${newInstallers.length} new installer(s)</strong> joined MCS since yesterday
        </p>
        <p style="margin:6px 0 0;font-size:13px;color:#555;">${techSummary}</p>
      </td></tr>
    </table>
    ${cards}`)
  }

  return `<!DOCTYPE html>
  <html><body style="margin:0;padding:20px;background:#f5f5f5;font-family:Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:700px;margin:0 auto;">
      <tr><td style="background:#1a5276;border-radius:8px 8px 0 0;padding:20px 24px;">
        <h1 style="margin:0;color:#fff;font-size:20px;">MCS Installer Monitor</h1>
        <p style="margin:4px 0 0;color:#acd4f5;font-size:13px;">${esc(runDate)}</p>
      </td></tr>
      <tr><td style="background:#fff;border-radius:0 0 8px 8px;padding:24px;">
        ${sections.join('\n')}
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0;"/>
        <p style="font-size:11px;color:#aaa;margin:0;">
          Source: <a href="https://mcscertified.com/find-an-installer/" style="color:#aaa;">mcscertified.com/find-an-installer</a>
        </p>
      </td></tr>
    </table>
  </body></html>`
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async () => {
  const runDate  = new Date().toLocaleDateString('en-GB', {
    timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
  const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  console.log(`=== MCS Monitor — ${runDate} ===`)

  // 1. Load known installer IDs from DB
  const { data: knownRows, error: dbErr } = await db
    .from('installer_ids')
    .select('installer_id')
  if (dbErr) return new Response(JSON.stringify({ error: dbErr }), { status: 500 })

  const knownIds = new Set((knownRows ?? []).map((r: { installer_id: string }) => r.installer_id))
  const firstRun = knownIds.size === 0
  console.log(`Known IDs in DB: ${knownIds.size}${firstRun ? ' — first run, will seed' : ''}`)

  // 2. Fetch nonce + all current installers from MCS
  const nonce      = await getNonce()
  console.log(`Nonce: ${nonce}`)
  const installers = await fetchAllInstallers(nonce)
  console.log(`Fetched: ${installers.length} installers from MCS`)

  // 3. Diff against known IDs (skip on first run to avoid mass false-positives)
  const newInstallers = firstRun
    ? []
    : installers.filter(i => i.installer_id && !knownIds.has(i.installer_id))
  console.log(`New installers: ${newInstallers.length}`)

  // 4. Upsert all fetched IDs into installer_ids (cumulative — never removes)
  const upsertRows = installers
    .filter(i => i.installer_id)
    .map(i => ({ installer_id: i.installer_id, installer_name: String(i.name ?? '').trim() }))
  const { error: upsertErr } = await db
    .from('installer_ids')
    .upsert(upsertRows, { onConflict: 'installer_id' })
  if (upsertErr) console.warn('DB upsert warning:', upsertErr)
  else console.log(`Upserted ${upsertRows.length} IDs into installer_ids`)

  // 5. Merge installers.json and push to GitHub
  const fileInfo = await getGitHubFile(MAP_FILE)
  const existingMap: Record<string, MapRecord> = {}
  if (fileInfo) {
    try {
      const arr: MapRecord[] = JSON.parse(fileInfo.text)
      for (const r of arr) if (r.id) existingMap[r.id] = r
    } catch (e) {
      console.warn('Could not parse existing installers.json:', e)
    }
  }
  for (const inst of installers) {
    if (inst.installer_id) existingMap[inst.installer_id] = toMapRecord(inst)
  }
  if (fileInfo) {
    const mapJson = JSON.stringify(Object.values(existingMap))
    await updateGitHubFile(MAP_FILE, mapJson, fileInfo.sha)
    console.log(`installers.json updated — ${Object.keys(existingMap).length} total records`)
  } else {
    console.warn('installers.json not found on GitHub — skipping update')
  }

  // 6. First run: seed complete, no email
  if (firstRun) {
    console.log('First run seeding complete — no email sent.')
    return new Response(JSON.stringify({ firstRun: true, seeded: upsertRows.length }), { status: 200 })
  }

  // 7. Fetch due follow-ups from contacts table
  const { data: contacts } = await db
    .from('contacts')
    .select('installer_id, installer_name, employee, outcome, follow_up_date, notes')
    .is('deleted_at', null)
    .order('contacted_at', { ascending: false })

  // deno-lint-ignore no-explicit-any
  const latestMap: Record<string, any> = {}
  for (const c of contacts ?? []) {
    if (!latestMap[c.installer_id]) latestMap[c.installer_id] = c
  }
  const followUps: FollowUp[] = Object.values(latestMap)
    .filter(c => c.outcome === 'Follow Up' && c.follow_up_date && c.follow_up_date <= todayIso)
    .sort((a, b) => a.follow_up_date.localeCompare(b.follow_up_date))
    .map(c => ({
      installer_name: c.installer_name,
      employee:       c.employee,
      follow_up_date: c.follow_up_date,
      notes:          c.notes,
    }))
  console.log(`Follow-ups due today: ${followUps.length}`)

  // 8. Build subject + send email
  const n = newInstallers.length
  const f = followUps.length
  const subject = n && f ? `MCS: ${n} new installer(s), ${f} follow-up(s) due — ${runDate}`
    : f              ? `MCS: ${f} follow-up(s) due today — ${runDate}`
    : n              ? `MCS New Installers: ${n} added — ${runDate}`
                     : `MCS Installer Report: No new installers — ${runDate}`

  const html = buildHtml(newInstallers, runDate, followUps)
  await transporter.sendMail({ from: `MCS Map <${GMAIL_USER}>`, to: EMAIL_TO, subject, html })
  console.log(`Email sent → ${EMAIL_TO}`)

  return new Response(JSON.stringify({ new: n, followUps: f }), { status: 200 })
})
