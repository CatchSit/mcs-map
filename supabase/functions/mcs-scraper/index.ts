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
      if (batch.length < 100 || page >= 500) break
    } catch (e) {
      console.warn(`[WARN] ${label} p${page}:`, e)
      break
    }
    page++
    await sleep(100)
  }
}

// ─── Postcode area sweep ──────────────────────────────────────────────────────
// One query per UK postcode area. The API sorts results by distance from the
// given coordinate, so local installers appear first. We paginate until all
// results on a page are beyond the area radius, then stop. We only keep
// installers whose postcode belongs to the queried area, so each installer is
// captured by exactly one area and there are no duplicates. No single area has
// anywhere near the ~5,500 per-query result cap, so complete coverage is
// guaranteed without geographic tricks.

// [area, centre lat, centre lng, radius km]
const POSTCODE_AREAS: Array<[string, string, string, number]> = [
  ['AB', '57.15', '-2.11', 100], ['AL', '51.75', '-0.33',  30],
  ['B',  '52.48', '-1.89',  40], ['BA', '51.38', '-2.36',  40],
  ['BB', '53.75', '-2.48',  35], ['BD', '53.80', '-1.75',  35],
  ['BH', '50.72', '-1.88',  40], ['BL', '53.58', '-2.43',  30],
  ['BN', '50.83', '-0.17',  40], ['BR', '51.41',  '0.02',  25],
  ['BS', '51.45', '-2.60',  40], ['BT', '54.60', '-5.93',  70],
  ['CA', '54.90', '-2.94',  70], ['CB', '52.20',  '0.12',  40],
  ['CF', '51.48', '-3.18',  40], ['CH', '53.19', '-2.89',  40],
  ['CM', '51.74',  '0.48',  40], ['CO', '51.89',  '0.90',  40],
  ['CR', '51.37', '-0.10',  25], ['CT', '51.28',  '1.08',  40],
  ['CV', '52.41', '-1.51',  40], ['CW', '53.10', '-2.44',  35],
  ['DA', '51.45',  '0.22',  25], ['DD', '56.46', '-2.97',  50],
  ['DE', '52.92', '-1.48',  40], ['DG', '55.07', '-3.61',  70],
  ['DH', '54.78', '-1.55',  35], ['DL', '54.52', '-1.55',  40],
  ['DN', '53.52', '-1.13',  40], ['DT', '50.72', '-2.44',  40],
  ['DY', '52.51', '-2.08',  30], ['E',  '51.52', '-0.03',  20],
  ['EC', '51.52', '-0.10',  15], ['EH', '55.95', '-3.19',  50],
  ['EN', '51.65', '-0.08',  25], ['EX', '50.72', '-3.53',  50],
  ['FK', '56.00', '-3.78',  50], ['FY', '53.82', '-3.05',  35],
  ['G',  '55.87', '-4.27',  40], ['GL', '51.87', '-2.24',  45],
  ['GU', '51.24', '-0.58',  35], ['GY', '49.46', '-2.59',  30],
  ['HA', '51.58', '-0.33',  25], ['HD', '53.65', '-1.78',  35],
  ['HG', '54.00', '-1.54',  40], ['HP', '51.75', '-0.45',  30],
  ['HR', '52.06', '-2.72',  50], ['HS', '57.77', '-7.02',  80],
  ['HU', '53.74', '-0.33',  35], ['HX', '53.72', '-1.86',  30],
  ['IG', '51.56',  '0.08',  20], ['IM', '54.24', '-4.52',  40],
  ['IP', '52.06',  '1.16',  45], ['IV', '57.48', '-4.23', 120],
  ['JE', '49.21', '-2.13',  25], ['KA', '55.61', '-4.50',  50],
  ['KT', '51.41', '-0.30',  25], ['KW', '58.44', '-3.10', 100],
  ['KY', '56.11', '-3.16',  45], ['L',  '53.41', '-3.00',  35],
  ['LA', '54.05', '-2.80',  50], ['LD', '52.24', '-3.38',  60],
  ['LE', '52.64', '-1.13',  40], ['LL', '53.05', '-3.80',  60],
  ['LN', '53.23', '-0.54',  50], ['LS', '53.80', '-1.55',  35],
  ['LU', '51.88', '-0.42',  30], ['M',  '53.48', '-2.24',  30],
  ['ME', '51.40',  '0.52',  35], ['MK', '52.04', '-0.76',  35],
  ['ML', '55.79', '-3.99',  35], ['N',  '51.55', '-0.12',  20],
  ['NE', '55.00', '-1.65',  45], ['NG', '52.96', '-1.15',  40],
  ['NP', '51.59', '-3.00',  40], ['NR', '52.63',  '1.30',  50],
  ['NW', '51.57', '-0.18',  20], ['OL', '53.54', '-2.12',  30],
  ['OX', '51.75', '-1.26',  45], ['PA', '55.84', '-4.43',  80],
  ['PE', '52.57', '-0.25',  45], ['PH', '56.40', '-3.47',  80],
  ['PL', '50.37', '-4.14',  45], ['PO', '50.82', '-1.09',  40],
  ['PR', '53.76', '-2.70',  35], ['RG', '51.46', '-0.97',  40],
  ['RH', '51.24', '-0.17',  35], ['RM', '51.58',  '0.18',  25],
  ['S',  '53.38', '-1.47',  40], ['SA', '51.62', '-3.94',  60],
  ['SE', '51.47', '-0.06',  20], ['SG', '51.90', '-0.20',  30],
  ['SK', '53.41', '-2.16',  30], ['SL', '51.51', '-0.59',  25],
  ['SM', '51.36', '-0.19',  20], ['SN', '51.56', '-1.79',  40],
  ['SO', '50.90', '-1.40',  40], ['SP', '51.07', '-1.80',  45],
  ['SR', '54.91', '-1.39',  30], ['SS', '51.54',  '0.71',  35],
  ['ST', '53.00', '-2.18',  40], ['SW', '51.46', '-0.16',  20],
  ['SY', '52.71', '-2.75',  60], ['TA', '51.02', '-3.10',  45],
  ['TD', '55.62', '-2.81',  60], ['TF', '52.68', '-2.45',  40],
  ['TN', '51.13',  '0.26',  40], ['TQ', '50.46', '-3.52',  40],
  ['TR', '50.26', '-5.05',  50], ['TS', '54.57', '-1.24',  35],
  ['TW', '51.45', '-0.34',  20], ['UB', '51.54', '-0.48',  20],
  ['W',  '51.51', '-0.21',  20], ['WA', '53.39', '-2.60',  35],
  ['WC', '51.52', '-0.12',  15], ['WD', '51.66', '-0.40',  25],
  ['WF', '53.68', '-1.50',  35], ['WN', '53.55', '-2.63',  30],
  ['WR', '52.19', '-2.22',  40], ['WS', '52.58', '-1.98',  30],
  ['WV', '52.59', '-2.12',  30], ['YO', '53.96', '-1.08',  50],
  ['ZE', '60.15', '-1.15',  80],
]

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function postcodeArea(postcode: string): string {
  const m = postcode.trim().toUpperCase().match(/^([A-Z]{1,2})\d/)
  return m ? m[1] : ''
}

async function fetchAreaInstallers(
  nonce: string, area: string, lat: string, lng: string, radiusKm: number
): Promise<RawInstaller[]> {
  const centreLat = parseFloat(lat)
  const centreLng = parseFloat(lng)
  const accepted: RawInstaller[] = []
  const seen = new Set<string>()
  let page = 1

  while (page < 500) {
    const p = new URLSearchParams({
      action: 'filter_installers', nonce, form_type: 'installers', search: '',
      user_searched_location: 'region', lat, lng, per_page: '100', page: String(page),
    })
    for (const tech of TECH_KEYS) p.append('technology[]', tech)

    try {
      const resp = await fetch(`${AJAX_URL}?${p}`, { headers: BROWSER_HEADERS })
      if (!resp.ok) { console.warn(`[WARN] ${area} p${page}: ${resp.status}`); break }
      const data = await resp.json()
      if (!data?.success) { console.warn(`[WARN] ${area} p${page}: success=false`); break }
      const batch: RawInstaller[] = data?.data?.data ?? []
      if (!batch.length) break

      // Stop once all results on a page are beyond this area's radius.
      // Installers are distance-sorted, so we've passed all local ones.
      const allBeyond = batch.every(inst => {
        if (!inst.lat || !inst.lng) return false
        return distanceKm(centreLat, centreLng, parseFloat(inst.lat), parseFloat(inst.lng)) > radiusKm
      })

      // Only keep installers whose postcode belongs to this area
      for (const inst of batch) {
        if (inst.installer_id && !seen.has(inst.installer_id) &&
            postcodeArea(inst.postcode ?? '') === area) {
          seen.add(inst.installer_id)
          accepted.push(inst)
        }
      }

      if (batch.length < 100 || allBeyond) break
    } catch (e) {
      console.warn(`[WARN] ${area} p${page}:`, e)
      break
    }
    page++
    await sleep(100)
  }

  if (accepted.length > 0)
    console.log(`  [${area}] ${accepted.length} installers (${page} pages)`)
  return accepted
}

async function fetchAllInstallers(nonce: string): Promise<RawInstaller[]> {
  // Run in batches of 20 to avoid hammering MCS's server
  const BATCH = 20
  const seenIds = new Set<string>()
  const all: RawInstaller[] = []

  console.log(`[Postcode sweep] ${POSTCODE_AREAS.length} areas in batches of ${BATCH}`)
  for (let i = 0; i < POSTCODE_AREAS.length; i += BATCH) {
    const batch = POSTCODE_AREAS.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(([area, lat, lng, radius]) => fetchAreaInstallers(nonce, area, lat, lng, radius))
    )
    for (const list of results)
      for (const inst of list)
        if (inst.installer_id && !seenIds.has(inst.installer_id)) {
          seenIds.add(inst.installer_id); all.push(inst)
        }
    console.log(`[Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(POSTCODE_AREAS.length / BATCH)}] running total: ${all.length}`)
  }

  console.log(`[Postcode sweep done] ${all.length} total unique installers`)
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

  // 1. Is this a first run? (installer_ids empty)
  const { count: knownCount } = await db
    .from('installer_ids').select('*', { count: 'exact', head: true })
  const firstRun = (knownCount ?? 0) === 0
  console.log(`Known IDs in DB: ${knownCount}${firstRun ? ' — first run' : ''}`)

  // 2. Fetch all installers from MCS
  const nonce      = await getNonce()
  const installers = await fetchAllInstallers(nonce)
  console.log(`Fetched: ${installers.length}`)

  // 3. Diff — query only the fetched IDs using batched .in() to stay under the
  //    PostgREST 1000-row-per-request cap. This avoids loading all known IDs.
  const fetchedIds = installers.map(i => i.installer_id).filter(Boolean) as string[]
  const knownInFetch = new Set<string>()
  const CHUNK = 900
  for (let i = 0; i < fetchedIds.length; i += CHUNK) {
    const chunk = fetchedIds.slice(i, i + CHUNK)
    const { data } = await db.from('installer_ids').select('installer_id').in('installer_id', chunk)
    for (const r of (data ?? [])) knownInFetch.add(r.installer_id)
  }

  const newInstallers = firstRun
    ? []
    : installers.filter(i => i.installer_id && !knownInFetch.has(i.installer_id))
  console.log(`New: ${newInstallers.length} (known among fetched: ${knownInFetch.size})`)

  // 4. Persist new installers and update the map cumulatively
  if (newInstallers.length > 0) {
    // Insert into known IDs table
    const { error: upsertErr } = await db.from('installer_ids').upsert(
      newInstallers.map(i => ({ installer_id: i.installer_id, installer_name: String(i.name ?? '').trim() })),
      { onConflict: 'installer_id' }
    )
    if (upsertErr) console.error('installer_ids upsert error:', JSON.stringify(upsertErr))
    // Queue for email notification
    await db.from('mcs_new_installers').upsert(
      newInstallers.map(i => ({
        installer_id:   i.installer_id,
        installer_name: String(i.name ?? '').trim(),
        installer_data: i,
      })),
      { onConflict: 'installer_id', ignoreDuplicates: true }
    )
    console.log(`Queued ${newInstallers.length} new installers for notification`)

    // Merge this run's results on top of the existing installers.json.
    // This means the map can only grow — a throttled run that fetches fewer
    // installers still adds its new records without removing existing ones.
    try {
      const currentResp = await fetch(
        `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${MAP_FILE}`,
        { headers: { 'Cache-Control': 'no-cache' } }
      )
      type MapRecord = ReturnType<typeof toMapRecord>
      const existing: MapRecord[] = currentResp.ok ? await currentResp.json() : []
      const merged = new Map<string, MapRecord>(existing.map(r => [r.id, r]))
      for (const inst of installers) {
        if (inst.installer_id) merged.set(inst.installer_id, toMapRecord(inst))
      }
      const mapJson = JSON.stringify([...merged.values()])
      await pushInstallerJson(mapJson)
      console.log(`installers.json pushed — ${merged.size} records (was ${existing.length}, fetched ${installers.length})`)
    } catch (e) {
      console.warn('GitHub push failed:', e)
    }
  } else if (firstRun) {
    // Seed known IDs without emailing
    const seedRows = installers
      .filter(i => i.installer_id)
      .map(i => ({ installer_id: i.installer_id, installer_name: String(i.name ?? '').trim() }))
    for (let i = 0; i < seedRows.length; i += CHUNK) {
      await db.from('installer_ids').upsert(seedRows.slice(i, i + CHUNK), { onConflict: 'installer_id' })
    }
    console.log(`First run — seeded ${seedRows.length} IDs, no notification queued`)
  } else {
    console.log('No new installers — nothing to do')
  }

  return new Response(JSON.stringify({ fetched: installers.length, new: newInstallers.length, knownInDB: knownCount }), { status: 200 })
})
