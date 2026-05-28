import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer'

const GMAIL_USER            = 'mcsinstallers.alerts@gmail.com'
const GMAIL_APP_PASSWORD    = Deno.env.get('GMAIL_APP_PASSWORD')!
const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const NOTIFY_TO             = 'greg@amcorenewables.co.uk'
const MAP_URL               = 'https://catchsit.github.io/mcs-map/index.html'

if (!GMAIL_APP_PASSWORD || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing required secrets — check GMAIL_APP_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
})

// deno-lint-ignore no-explicit-any
type RawInstaller = Record<string, any>

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

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function installerCard(inst: RawInstaller): string {
  const techs   = getTechs(inst).join(', ') || 'Unknown'
  const address = getAddress(inst)
  const phone   = String(inst.telephone ?? '').trim()
  const email   = String(inst.email     ?? '').trim()
  let   website = String(inst.website   ?? '').trim()
  if (website && !website.startsWith('http')) website = 'https://' + website
  const bus     = inst.boiler_upgrade_scheme === '1'

  return `
    <div style="background:#f7f9fc;border:1px solid #dde3ea;border-radius:8px;padding:16px 18px;margin-bottom:14px">
      <p style="font-size:15px;font-weight:bold;color:#1a5276;margin:0 0 4px">${esc(String(inst.name ?? 'Unknown'))}</p>
      <p style="font-size:12px;color:#666;margin:0 0 10px">${esc(address)}</p>
      <p style="font-size:12px;margin:0 0 4px"><strong>Technologies:</strong> ${esc(techs)}</p>
      ${phone   ? `<p style="font-size:12px;margin:0 0 4px"><strong>Phone:</strong> ${esc(phone)}</p>` : ''}
      ${email   ? `<p style="font-size:12px;margin:0 0 4px"><strong>Email:</strong> <a href="mailto:${esc(email)}">${esc(email)}</a></p>` : ''}
      ${website ? `<p style="font-size:12px;margin:0 0 4px"><strong>Website:</strong> <a href="${esc(website)}">${esc(website)}</a></p>` : ''}
      ${bus     ? `<p style="font-size:12px;margin:0;color:#1a7a4a"><strong>✓ Boiler Upgrade Scheme</strong></p>` : ''}
    </div>`
}

Deno.serve(async () => {
  console.log('=== MCS Notifier ===')

  // 1. Fetch pending new-installer alerts
  const { data: pending, error: pendingErr } = await db
    .from('mcs_new_installers')
    .select('id, installer_data')
    .is('notified_at', null)

  if (pendingErr) {
    console.error('DB error (mcs_new_installers):', pendingErr)
    return new Response(JSON.stringify({ error: pendingErr }), { status: 500 })
  }

  console.log(`Pending new installers: ${pending?.length ?? 0}`)

  // 2. Fetch today's follow-ups
  const ukToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const { data: followUps, error: fuErr } = await db
    .from('contacts')
    .select('installer_name, employee, employee_email, outcome, notes')
    .eq('follow_up_date', ukToday)
    .is('deleted_at', null)
    .not('employee_email', 'is', null)

  if (fuErr) {
    console.error('DB error (contacts):', fuErr)
    return new Response(JSON.stringify({ error: fuErr }), { status: 500 })
  }

  const newCount = pending?.length ?? 0
  const fuCount  = followUps?.length ?? 0

  if (newCount === 0 && fuCount === 0) {
    console.log('Nothing to report today')
    return new Response(JSON.stringify({ new: 0, followUps: 0 }), { status: 200 })
  }

  const ukDateDisplay = new Date().toLocaleDateString('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  // 3. Build new-installer section
  const newInstallerHtml = newCount > 0 ? `
    <div style="margin-bottom:28px">
      <h2 style="font-size:15px;color:#1a5276;border-bottom:2px solid #1a5276;padding-bottom:6px;margin-bottom:14px">
        ${newCount} New MCS Installer${newCount > 1 ? 's' : ''} Detected
      </h2>
      ${(pending ?? []).map(row => installerCard(row.installer_data as RawInstaller)).join('')}
    </div>` : ''

  // 4. Build follow-up section
  const fuRows = (followUps ?? []).map(c => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;font-weight:bold;color:#1a5276">${esc(c.installer_name)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee">${esc(c.employee)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee">${esc(c.outcome)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;font-size:12px">${c.notes ? esc(c.notes) : '—'}</td>
    </tr>`).join('')

  const followUpHtml = fuCount > 0 ? `
    <div style="margin-bottom:28px">
      <h2 style="font-size:15px;color:#1a5276;border-bottom:2px solid #1a5276;padding-bottom:6px;margin-bottom:14px">
        ${fuCount} Follow-up${fuCount > 1 ? 's' : ''} Due Today
      </h2>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#f7f9fc">
            <th style="padding:9px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#666;border-bottom:2px solid #eee">Installer</th>
            <th style="padding:9px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#666;border-bottom:2px solid #eee">Employee</th>
            <th style="padding:9px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#666;border-bottom:2px solid #eee">Last Outcome</th>
            <th style="padding:9px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#666;border-bottom:2px solid #eee">Notes</th>
          </tr>
        </thead>
        <tbody>${fuRows}</tbody>
      </table>
    </div>` : ''

  const subject = [
    newCount > 0 ? `${newCount} new installer${newCount > 1 ? 's' : ''}` : '',
    fuCount  > 0 ? `${fuCount} follow-up${fuCount > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' · ') + ` — ${ukDateDisplay}`

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:660px;margin:0 auto;color:#333">
      <div style="background:#1a5276;padding:22px 26px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;font-size:18px;margin:0">MCS Daily Update</h1>
        <p style="color:#acd4f5;font-size:13px;margin:5px 0 0 0">${ukDateDisplay}</p>
      </div>
      <div style="background:#fff;border:1px solid #dde3ea;border-top:none;padding:24px 26px;border-radius:0 0 8px 8px">
        ${newInstallerHtml}
        ${followUpHtml}
        <div style="margin-top:8px">
          <a href="${MAP_URL}" style="display:inline-block;background:#1a5276;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:bold">
            Open MCS Map →
          </a>
        </div>
        <p style="font-size:11px;color:#aaa;margin-top:20px">
          Automated daily update from the MCS Installer Map.
        </p>
      </div>
    </div>`

  // 5. Send email
  try {
    await transporter.sendMail({
      from:    `MCS Map <${GMAIL_USER}>`,
      to:      NOTIFY_TO,
      subject,
      html,
    })
    console.log(`Email sent to ${NOTIFY_TO}`)
  } catch (err) {
    console.error('Send failed:', err)
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 })
  }

  // 6. Mark new-installer rows as notified
  if (newCount > 0) {
    const { error: markErr } = await db
      .from('mcs_new_installers')
      .update({ notified_at: new Date().toISOString() })
      .is('notified_at', null)
    if (markErr) console.warn('Failed to mark rows notified:', markErr)
    else console.log(`Marked ${newCount} rows notified`)
  }

  return new Response(JSON.stringify({ new: newCount, followUps: fuCount }), { status: 200 })
})
