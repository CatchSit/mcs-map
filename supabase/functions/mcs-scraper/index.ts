import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GITHUB_PAT                = Deno.env.get('GITHUB_PAT')!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GITHUB_PAT) {
  throw new Error('Missing required secrets — check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GITHUB_PAT')
}

const FIND_PAGE   = 'https://mcscertified.com/find-an-installer/'
const AJAX_URL    = 'https://mcscertified.com/wp-admin/admin-ajax.php'
const GITHUB_REPO = 'CatchSit/mcs-map'
const MAP_FILE    = 'installers.json'

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── Technology keys (labels needed for toMapRecord techs array) ──────────────

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

const GITHUB_HEADERS = {
  Authorization:  `Bearer ${GITHUB_PAT}`,
  Accept:         'application/vnd.github.v3+json',
  'User-Agent':   'mcs-map-scraper',
  'Content-Type': 'application/json',
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── Nonce ────────────────────────────────────────────────────────────────────

async function getNonce(): Promise<string> {
  const resp = await fetch(FIND_PAGE, { headers: BROWSER_HEADERS })
  if (!resp.ok) throw new Error(`MCS page returned ${resp.status}`)
  const html = await resp.text()
  const match = html.match(/"nonce"\s*:\s*"([^"]+)"/)
  if (!match) throw new Error('Nonce not found in MCS page')
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
      console.warn(`[WARN] ${label} p${page}:`, e)
      break
    }
    page++
    await sleep(100)
  }
}

async function fetchAllInstallers(nonce: string): Promise<RawInstaller[]> {
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
  const seenIds = new Set<string>()
  const all: RawInstaller[] = []
  for (const list of techResults)
    for (const inst of list)
      if (inst.installer_id && !seenIds.has(inst.installer_id)) {
        seenIds.add(inst.installer_id); all.push(inst)
      }
  console.log(`[Sweep done] ${all.length} unique installers`)
  return all
}

// ─── Map record helpers ───────────────────────────────────────────────────────

function getTechs(inst: RawInstaller): string[] {
  return Object.entries(TECHNOLOGY_LABELS)
    .filter(([flag]) => inst[flag] === '1').map(([, label]) => label)
}

function getAddress(inst: RawInstaller): string {
  return ['address_line_1', 'address_line_2', 'address_line_3', 'county', 'postcode']
    .map(k => String(inst[k] ?? '').trim())
    .filter(v => v && !['n/a', 'unspecified'].includes(v.toLowerCase()))
    .join(', ') || 'Location not listed'
}

function toMapRecord(inst: RawInstaller) {
  let website = String(inst.website ?? '').trim()
  if (website && !website.startsWith('http')) website = 'https://' + website
  return {
    id:       inst.installer_id,
    name:     String(inst.name ?? 'Unknown').trim(),
    lat:      inst.lat ? parseFloat(inst.lat) : null,
    lng:      inst.lng ? parseFloat(inst.lng) : null,
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

// ─── GitHub — Git Data API (no base64 on our side) ───────────────────────────

async function pushInstallerJson(content: string): Promise<void> {
  const blobResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/blobs`, {
    method: 'POST', headers: GITHUB_HEADERS,
    body: JSON.stringify({ content, encoding: 'utf-8' }),
  })
  if (!blobResp.ok) throw new Error(`Blob ${blobResp.status}: ${await blobResp.text()}`)
  const { sha: blobSha } = await blobResp.json()

  const refResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/refs/heads/main`, {
    headers: GITHUB_HEADERS,
  })
  if (!refResp.ok) throw new Error(`Ref ${refResp.status}`)
  const { object: { sha: commitSha } } = await refResp.json()

  const commitResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/commits/${commitSha}`, {
    headers: GITHUB_HEADERS,
  })
  const { tree: { sha: treeSha } } = await commitResp.json()

  const newTreeResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/trees`, {
    method: 'POST', headers: GITHUB_HEADERS,
    body: JSON.stringify({ base_tree: treeSha, tree: [{ path: MAP_FILE, mode: '100644', type: 'blob', sha: blobSha }] }),
  })
  const { sha: newTreeSha } = await newTreeResp.json()

  const newCommitResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/commits`, {
    method: 'POST', headers: GITHUB_HEADERS,
    body: JSON.stringify({ message: 'chore: update installer data [skip ci]', tree: newTreeSha, parents: [commitSha] }),
  })
  const { sha: newCommitSha } = await newCommitResp.json()

  const patchResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/git/refs/heads/main`, {
    method: 'PATCH', headers: GITHUB_HEADERS,
    body: JSON.stringify({ sha: newCommitSha }),
  })
  if (!patchResp.ok) throw new Error(`Ref update ${patchResp.status}: ${await patchResp.text()}`)
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async () => {
  console.log('=== MCS Scraper ===')

  // 1. Load known installer IDs
  const { data: knownRows, error: dbErr } = await db
    .from('installer_ids').select('installer_id')
  if (dbErr) return new Response(JSON.stringify({ error: dbErr }), { status: 500 })

  const knownIds = new Set((knownRows ?? []).map((r: { installer_id: string }) => r.installer_id))
  const firstRun = knownIds.size === 0
  console.log(`Known IDs: ${knownIds.size}${firstRun ? ' — first run' : ''}`)

  // 2. Fetch all installers from MCS
  const nonce      = await getNonce()
  const installers = await fetchAllInstallers(nonce)
  console.log(`Fetched: ${installers.length}`)

  // 3. Diff
  const newInstallers = firstRun
    ? []
    : installers.filter(i => i.installer_id && !knownIds.has(i.installer_id))
  console.log(`New: ${newInstallers.length}`)

  // 4. Persist new installers
  if (newInstallers.length > 0) {
    // Insert into known IDs table
    await db.from('installer_ids').upsert(
      newInstallers.map(i => ({ installer_id: i.installer_id, installer_name: String(i.name ?? '').trim() })),
      { onConflict: 'installer_id' }
    )
    // Queue for email notification
    await db.from('mcs_new_installers').insert(
      newInstallers.map(i => ({
        installer_id:   i.installer_id,
        installer_name: String(i.name ?? '').trim(),
        installer_data: i,
      }))
    )
    console.log(`Queued ${newInstallers.length} new installers for notification`)

    // Push updated installers.json to GitHub
    try {
      const mapJson = JSON.stringify(installers.filter(i => i.installer_id).map(toMapRecord))
      await pushInstallerJson(mapJson)
      console.log('installers.json pushed')
    } catch (e) {
      console.warn('GitHub push failed:', e)
    }
  } else if (firstRun) {
    // Seed known IDs without emailing
    const seedRows = installers
      .filter(i => i.installer_id)
      .map(i => ({ installer_id: i.installer_id, installer_name: String(i.name ?? '').trim() }))
    await db.from('installer_ids').upsert(seedRows, { onConflict: 'installer_id' })
    console.log(`First run — seeded ${seedRows.length} IDs, no notification queued`)
  } else {
    console.log('No new installers — nothing to do')
  }

  return new Response(JSON.stringify({ fetched: installers.length, new: newInstallers.length }), { status: 200 })
})
