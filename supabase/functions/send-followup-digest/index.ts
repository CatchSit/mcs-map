import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer'

const GMAIL_USER            = 'mcsinstallers.alerts@gmail.com'
const GMAIL_APP_PASSWORD    = Deno.env.get('GMAIL_APP_PASSWORD')!
const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MAP_URL               = 'https://catchsit.github.io/mcs-map/index.html'

if (!GMAIL_APP_PASSWORD || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing required secret — check GMAIL_APP_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in Supabase secrets')
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
})

// Full contacts schema (all columns):
//   id, installer_id, installer_name, employee, employee_email,
//   outcome, notes, next_action, follow_up_date, contacted_at,
//   updated_at, updated_by, deleted_at, deleted_by
interface Contact {
  installer_name:  string
  employee:        string
  employee_email:  string
  outcome:         string
  notes:           string | null
}

Deno.serve(async () => {
  // Today's date in UK time (handles BST/GMT automatically)
  const ukToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

  const { data: contacts, error } = await db
    .from('contacts')
    .select('installer_name, employee, employee_email, outcome, notes')
    .eq('follow_up_date', ukToday)
    .is('deleted_at', null)
    .not('employee_email', 'is', null)

  if (error) {
    console.error('DB error:', error)
    return new Response(JSON.stringify({ error }), { status: 500 })
  }

  if (!contacts?.length) {
    console.log('No follow-ups due today:', ukToday)
    return new Response('No follow-ups today', { status: 200 })
  }

  // Group by employee email
  const byEmployee: Record<string, Contact[]> = {}
  for (const c of contacts) {
    if (!byEmployee[c.employee_email]) byEmployee[c.employee_email] = []
    byEmployee[c.employee_email].push(c)
  }

  const ukDateDisplay = new Date().toLocaleDateString('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  const results = await Promise.all(
    Object.entries(byEmployee).map(async ([email, items]) => {
      const name  = items[0].employee
      const count = items.length

      const tableRows = items.map((c: Contact) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;font-weight:bold;color:#1a5276">${esc(c.installer_name)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #eee">${esc(c.outcome)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;font-size:12px">${c.notes ? esc(c.notes) : '—'}</td>
        </tr>`).join('')

      const html = `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#333">
          <div style="background:#1a5276;padding:22px 26px;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;font-size:18px;margin:0">MCS Follow-ups Due Today</h1>
            <p style="color:#acd4f5;font-size:13px;margin:5px 0 0 0">${ukDateDisplay}</p>
          </div>
          <div style="background:#fff;border:1px solid #dde3ea;border-top:none;padding:24px 26px;border-radius:0 0 8px 8px">
            <p style="font-size:14px;margin:0 0 16px">
              Hi ${esc(name)}, you have <strong>${count} follow-up${count > 1 ? 's' : ''}</strong> due today:
            </p>
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr style="background:#f7f9fc">
                  <th style="padding:9px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#666;border-bottom:2px solid #eee">Installer</th>
                  <th style="padding:9px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#666;border-bottom:2px solid #eee">Last Outcome</th>
                  <th style="padding:9px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#666;border-bottom:2px solid #eee">Notes</th>
                </tr>
              </thead>
              <tbody>${tableRows}</tbody>
            </table>
            <div style="margin-top:22px">
              <a href="${MAP_URL}" style="display:inline-block;background:#1a5276;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:bold">
                Open MCS Map →
              </a>
            </div>
            <p style="font-size:11px;color:#aaa;margin-top:20px">
              You're receiving this because you have follow-ups logged in the MCS Installer Map.
            </p>
          </div>
        </div>`

      try {
        await transporter.sendMail({
          from:    `MCS Map <${GMAIL_USER}>`,
          to:      email,
          subject: `${count} follow-up${count > 1 ? 's' : ''} due today — ${new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/London' })}`,
          html,
        })
        return { email, status: 'sent' }
      } catch (err) {
        console.error('Send failed for', email, err)
        return { email, status: 'failed', error: (err as Error).message }
      }
    })
  )

  console.log('Results:', results)
  return new Response(JSON.stringify({ sent: results.length, results }), { status: 200 })
})

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
