import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer'

const GMAIL_USER            = 'mcsinstallers.alerts@gmail.com'
const GMAIL_APP_PASSWORD    = Deno.env.get('GMAIL_APP_PASSWORD')!
const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MANAGER_EMAIL         = 'greg@amcorenewables.co.uk'
const MAP_URL               = 'https://catchsit.github.io/mcs-map/index.html'
const DASHBOARD_URL         = 'https://catchsit.github.io/mcs-map/dashboard.html'

if (!GMAIL_APP_PASSWORD || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing required secret — check GMAIL_APP_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
})

Deno.serve(async () => {
  const now    = new Date()
  const cutoff = new Date(now.getTime() - 7 * 86400000).toISOString()

  // All contacts in the last 7 days (non-deleted)
  const { data: weekContacts, error: e1 } = await db
    .from('contacts')
    .select('installer_id, installer_name, employee, outcome, notes, follow_up_date, contacted_at')
    .is('deleted_at', null)
    .gte('contacted_at', cutoff)
    .order('contacted_at', { ascending: false })

  if (e1) { console.error('DB error (week):', e1); return new Response(JSON.stringify({ error: e1 }), { status: 500 }) }

  // All non-deleted contacts for pipeline summary (latest per installer)
  const { data: allContacts, error: e2 } = await db
    .from('contacts')
    .select('installer_id, outcome, follow_up_date')
    .is('deleted_at', null)
    .order('contacted_at', { ascending: false })

  if (e2) { console.error('DB error (all):', e2); return new Response(JSON.stringify({ error: e2 }), { status: 500 }) }

  // Build pipeline from latest-per-installer
  const latestMap: Record<string, string> = {}
  const followupDates: Record<string, string|null> = {}
  for (const c of allContacts ?? []) {
    if (!latestMap[c.installer_id]) {
      latestMap[c.installer_id] = c.outcome
      followupDates[c.installer_id] = c.follow_up_date
    }
  }
  const outcomes = Object.values(latestMap)
  const today = now.toISOString().slice(0, 10)

  const pipeline = {
    followUp:    outcomes.filter(o => o === 'Follow Up').length,
    interested:  outcomes.filter(o => o === 'Interested').length,
    converted:   outcomes.filter(o => o === 'Converted').length,
    notInterested: outcomes.filter(o => o === 'Not Interested').length,
    overdue:     Object.entries(followupDates).filter(([,d]) => d && d < today && latestMap[d] === 'Follow Up').length,
  }
  // Correct overdue count (use installer_id as key)
  pipeline.overdue = Object.entries(latestMap)
    .filter(([id, o]) => o === 'Follow Up' && followupDates[id] && followupDates[id]! < today)
    .length

  // Activity by employee this week
  const byEmployee: Record<string, number> = {}
  for (const c of weekContacts ?? []) {
    byEmployee[c.employee] = (byEmployee[c.employee] || 0) + 1
  }
  const employeeRows = Object.entries(byEmployee)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `
      <tr>
        <td style="padding:9px 14px;border-bottom:1px solid #eee">${esc(name)}</td>
        <td style="padding:9px 14px;border-bottom:1px solid #eee;font-weight:600;text-align:right">${n}</td>
      </tr>`).join('')

  // Recent contacts table (up to 15 rows)
  const recentRows = (weekContacts ?? []).slice(0, 15).map(c => {
    const date = new Date(c.contacted_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })
    return `
      <tr>
        <td style="padding:9px 14px;border-bottom:1px solid #eee;font-weight:500;color:#1a5276">${esc(c.installer_name)}</td>
        <td style="padding:9px 14px;border-bottom:1px solid #eee">${esc(c.employee)}</td>
        <td style="padding:9px 14px;border-bottom:1px solid #eee">${esc(c.outcome)}</td>
        <td style="padding:9px 14px;border-bottom:1px solid #eee;color:#666;font-size:12px">${date}</td>
      </tr>`
  }).join('')

  const weekDateRange = `${new Date(cutoff).toLocaleDateString('en-GB', { day:'numeric', month:'short' })} – ${now.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}`

  const statCard = (label: string, value: number, color: string) =>
    `<td style="width:25%;padding:0 6px"><div style="background:#f7f9fc;border:1px solid #eee;border-radius:8px;padding:14px 16px;text-align:center">
      <div style="font-size:28px;font-weight:700;color:${color};letter-spacing:-0.02em">${value}</div>
      <div style="font-size:11px;color:#666;margin-top:4px;text-transform:uppercase;letter-spacing:.06em">${label}</div>
    </div></td>`

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#333">
      <div style="background:#1a5276;padding:24px 28px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;font-size:20px;margin:0">Weekly Summary</h1>
        <p style="color:#acd4f5;font-size:13px;margin:6px 0 0">${weekDateRange}</p>
      </div>
      <div style="background:#fff;border:1px solid #dde3ea;border-top:none;padding:24px 28px;border-radius:0 0 8px 8px">

        <h2 style="font-size:14px;font-weight:600;color:#1a5276;text-transform:uppercase;letter-spacing:.07em;margin:0 0 14px">This week's activity</h2>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
          <thead><tr style="background:#f7f9fc">
            <th style="padding:9px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666;border-bottom:2px solid #eee">Employee</th>
            <th style="padding:9px 14px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666;border-bottom:2px solid #eee">Contacts</th>
          </tr></thead>
          <tbody>${employeeRows || '<tr><td colspan="2" style="padding:14px;text-align:center;color:#999">No contacts logged this week</td></tr>'}</tbody>
        </table>

        <h2 style="font-size:14px;font-weight:600;color:#1a5276;text-transform:uppercase;letter-spacing:.07em;margin:0 0 14px">Pipeline snapshot</h2>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px" cellspacing="0" cellpadding="0">
          <tr>
            ${statCard('Follow-ups open', pipeline.followUp, '#c08438')}
            ${statCard('Interested', pipeline.interested, '#5d8a64')}
            ${statCard('Converted', pipeline.converted, '#2f5a3d')}
            ${statCard('Not interested', pipeline.notInterested, '#8e9080')}
          </tr>
        </table>
        ${pipeline.overdue > 0 ? `<p style="background:#f0d3ce;border:1px solid #b85544;border-radius:7px;padding:10px 14px;font-size:13px;color:#b85544;margin:0 0 24px">⚠ <strong>${pipeline.overdue} overdue follow-up${pipeline.overdue !== 1 ? 's' : ''}</strong> need attention.</p>` : ''}

        <h2 style="font-size:14px;font-weight:600;color:#1a5276;text-transform:uppercase;letter-spacing:.07em;margin:0 0 14px">Recent contacts (last 15)</h2>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
          <thead><tr style="background:#f7f9fc">
            <th style="padding:9px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666;border-bottom:2px solid #eee">Installer</th>
            <th style="padding:9px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666;border-bottom:2px solid #eee">Employee</th>
            <th style="padding:9px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666;border-bottom:2px solid #eee">Outcome</th>
            <th style="padding:9px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666;border-bottom:2px solid #eee">Date</th>
          </tr></thead>
          <tbody>${recentRows || '<tr><td colspan="4" style="padding:14px;text-align:center;color:#999">No contacts this week</td></tr>'}</tbody>
        </table>

        <div style="margin-top:16px;display:flex;gap:12px">
          <a href="${MAP_URL}" style="display:inline-block;background:#1a5276;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:bold">Open Map →</a>
          <a href="${DASHBOARD_URL}" style="display:inline-block;background:#2f5a3d;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:bold">Dashboard →</a>
        </div>
        <p style="font-size:11px;color:#aaa;margin-top:18px">Automated weekly summary from MCS Installer Map. Sent every Monday morning.</p>
      </div>
    </div>`

  const subject = `Weekly summary: ${(weekContacts?.length ?? 0)} contacts, ${pipeline.followUp} follow-ups open — ${weekDateRange}`

  try {
    await transporter.sendMail({ from: `MCS Map <${GMAIL_USER}>`, to: MANAGER_EMAIL, subject, html })
    console.log('Weekly summary sent to', MANAGER_EMAIL)
    return new Response(JSON.stringify({ sent: true, contacts: weekContacts?.length ?? 0 }), { status: 200 })
  } catch (err) {
    console.error('Send failed:', err)
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 })
  }
})

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
