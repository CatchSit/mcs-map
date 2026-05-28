"""
MCS Certified Installer Monitor
Checks for newly added installers on mcscertified.com and emails a daily summary.

Environment variables (set as GitHub Actions secrets):
  EMAIL_FROM        - sender email address (Gmail)
  EMAIL_TO          - recipient email address
  EMAIL_PASSWORD    - Gmail App Password
  SMTP_HOST         - smtp.gmail.com
  SMTP_PORT         - 587
  SUPABASE_URL      - https://teezsldwkpwzgvfizial.supabase.co
  SUPABASE_ANON_KEY - Supabase anon key
"""

import json
import os
import re
import smtplib
import time
from collections import Counter
from datetime import datetime, date
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DATA_FILE     = "scripts/known_installers.json"
MAP_DATA_FILE = "installers.json"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

FIND_PAGE = "https://mcscertified.com/find-an-installer/"
AJAX_URL  = "https://mcscertified.com/wp-admin/admin-ajax.php"

TECHNOLOGY_LABELS = {
    "technology_ashp":           "Air Source Heat Pump",
    "technology_battery":        "Battery Storage",
    "technology_biomass":        "Biomass",
    "technology_eahp":           "Exhaust Air Heat Pump",
    "technology_gahp":           "Gas Absorption Heat Pump",
    "technology_gshp":           "Ground Source Heat Pump",
    "technology_hydro":          "Hydro",
    "technology_micro_chp":      "Micro CHP",
    "technology_sahp":           "Solar Assisted Heat Pump",
    "technology_solar_pv":       "Solar Photovoltaic",
    "technology_solar_thermal":  "Solar Thermal",
    "technology_wind_turbine":   "Wind Turbine",
    "technology_wshp":           "Water Source Heat Pump",
}

TECH_KEYS = list(TECHNOLOGY_LABELS.keys())

# Region → (lat, lng) centre coordinates
REGIONS: dict[str, tuple[float, float]] = {
    "region_nationwide":           (54.50, -3.50),
    "region_east_midlands":        (52.80, -1.20),
    "region_eastern":              (52.20,  0.50),
    "region_london":               (51.51, -0.13),
    "region_north_east":           (54.97, -1.60),
    "region_north_west":           (53.48, -2.24),
    "region_northern_ireland":     (54.60, -6.72),
    "region_scotland":             (56.49, -4.20),
    "region_south_east":           (51.25,  0.50),
    "region_south_west":           (51.00, -3.00),
    "region_wales":                (52.10, -3.80),
    "region_west_midlands":        (52.48, -1.90),
    "region_yorkshire_humberside": (53.80, -1.55),
}

# ---------------------------------------------------------------------------
# HTTP session — realistic browser headers + retry on transient failures
# ---------------------------------------------------------------------------

def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer":         FIND_PAGE,
    })
    retry = Retry(
        total=4,
        backoff_factor=2,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session

# ---------------------------------------------------------------------------
# Nonce
# ---------------------------------------------------------------------------

def get_nonce(session: requests.Session) -> str:
    resp = session.get(FIND_PAGE, timeout=30)
    resp.raise_for_status()
    match = re.search(r'"nonce"\s*:\s*"([^"]+)"', resp.text)
    if not match:
        raise RuntimeError(
            "Could not find nonce in MCS page HTML — the site may have changed."
        )
    return match.group(1)

# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

def _paginate(
    session: requests.Session,
    base_params: list[tuple],
    seen_ids: set[str],
    all_installers: list[dict],
    label: str,
) -> None:
    page = 1
    while True:
        params = base_params + [("page", str(page))]
        try:
            resp = session.get(AJAX_URL, params=params, timeout=30)
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as e:
            print(f"    [WARN] {label} page {page} failed: {e}")
            break

        if not data.get("success"):
            print(f"    [WARN] {label} page {page} — API success=false")
            break

        batch = data.get("data", {}).get("data", [])
        if not batch:
            break

        new_count = 0
        for installer in batch:
            iid = installer.get("installer_id")
            if iid and iid not in seen_ids:
                seen_ids.add(iid)
                all_installers.append(installer)
                new_count += 1

        print(f"    {label} page {page}: {len(batch)} returned, {new_count} new (total: {len(all_installers)})")

        if new_count == 0 or page >= 500:
            break

        page += 1
        time.sleep(0.5)


def fetch_all_installers(session: requests.Session, nonce: str) -> list[dict]:
    """
    Two-sweep strategy:
    Sweep 1 — each region with that region's own centre coordinates.
    Sweep 2 — each technology with no region filter.
    """
    seen_ids:       set[str]   = set()
    all_installers: list[dict] = []

    print("  [Sweep 1] Regions ...")
    for region, (lat, lng) in REGIONS.items():
        base_params = [
            ("action",                 "filter_installers"),
            ("nonce",                  nonce),
            ("form_type",              "installers"),
            ("search",                 ""),
            ("region[]",               region),
            ("user_searched_location", "region"),
            ("lat",                    str(lat)),
            ("lng",                    str(lng)),
            ("per_page",               "100"),
        ]
        for tech_key in TECH_KEYS:
            base_params.append(("technology[]", tech_key))
        _paginate(session, base_params, seen_ids, all_installers, region)
        time.sleep(1)

    print(f"  [Sweep 1 complete] {len(all_installers)} unique installers")

    print("  [Sweep 2] Technologies ...")
    for tech_key in TECH_KEYS:
        base_params = [
            ("action",                 "filter_installers"),
            ("nonce",                  nonce),
            ("form_type",              "installers"),
            ("search",                 ""),
            ("technology[]",           tech_key),
            ("user_searched_location", "region"),
            ("lat",                    "54.50"),
            ("lng",                    "-3.50"),
            ("per_page",               "100"),
        ]
        _paginate(session, base_params, seen_ids, all_installers, tech_key)
        time.sleep(0.5)

    print(f"  [Sweep 2 complete] {len(all_installers)} unique installers total")
    return all_installers

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def installer_technologies(installer: dict) -> list[str]:
    return [
        label
        for flag, label in TECHNOLOGY_LABELS.items()
        if installer.get(flag) == "1"
    ]


def installer_location(installer: dict) -> str:
    parts = []
    for key in ("address_line_1", "address_line_2", "address_line_3", "county", "postcode"):
        v = (installer.get(key) or "").strip()
        if v and v.lower() not in ("n/a", "unspecified"):
            parts.append(v)
    return ", ".join(parts) if parts else "Location not listed"


def installer_postcode(installer: dict) -> str:
    return (installer.get("postcode") or "").strip()


def maps_url(postcode: str) -> str:
    return (
        f"https://www.google.com/maps/search/{postcode.replace(' ', '+')}"
        if postcode else ""
    )

# ---------------------------------------------------------------------------
# State persistence
# ---------------------------------------------------------------------------

def load_known(path: str) -> dict[str, str]:
    if not Path(path).exists():
        return {}
    with open(path) as f:
        raw = json.load(f)
    if isinstance(raw, list):
        return {k: "" for k in raw}
    return raw


def save_map_data(path: str, installers: list[dict]):
    existing: dict[str, dict] = {}
    if Path(path).exists():
        try:
            with open(path) as f:
                for r in json.load(f):
                    if r.get("id"):
                        existing[r["id"]] = r
        except Exception:
            pass

    for i in installers:
        iid = i.get("installer_id", "")
        if not iid:
            continue
        addr_parts = []
        for key in ("address_line_1", "address_line_2", "address_line_3", "county", "postcode"):
            v = (i.get(key) or "").strip()
            if v and v.lower() not in ("n/a", "unspecified"):
                addr_parts.append(v)
        website = (i.get("website") or "").strip()
        if website and not website.startswith("http"):
            website = "https://" + website
        existing[iid] = {
            "id":       iid,
            "name":     (i.get("name") or "Unknown").strip(),
            "lat":      float(i["lat"])  if i.get("lat")  else None,
            "lng":      float(i["lng"])  if i.get("lng")  else None,
            "techs":    [label for flag, label in TECHNOLOGY_LABELS.items() if i.get(flag) == "1"],
            "phone":    (i.get("telephone") or "").strip(),
            "email":    (i.get("email") or "").strip(),
            "website":  website,
            "address":  ", ".join(addr_parts),
            "postcode": (i.get("postcode") or "").strip(),
            "cert":     (i.get("certification_number") or "").strip(),
            "cert_body":(i.get("certification_body") or "").strip(),
            "bus":      i.get("boiler_upgrade_scheme") == "1",
        }

    records = list(existing.values())
    with open(path, "w") as f:
        json.dump(records, f, separators=(",", ":"))
    print(f"Map data saved to '{path}' ({len(records)} total, {len(installers)} fetched today).")


def save_known(path: str, installers: list[dict], existing: dict[str, str] | None = None):
    data = dict(existing or {})
    for i in installers:
        if i.get("installer_id"):
            data[i["installer_id"]] = (i.get("name") or "").strip()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)

# ---------------------------------------------------------------------------
# Diff
# ---------------------------------------------------------------------------

def find_new_installers(installers: list[dict], known: dict[str, str]) -> list[dict]:
    return [
        i for i in installers
        if i.get("installer_id") and i["installer_id"] not in known
    ]

# ---------------------------------------------------------------------------
# Supabase — follow-up reminders
# ---------------------------------------------------------------------------

def fetch_due_followups(today_iso: str) -> list[dict]:
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("  Supabase credentials not set — skipping follow-up check.")
        return []
    headers = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    }
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/contacts",
            headers=headers,
            params={"select": "*", "order": "contacted_at.desc"},
            timeout=30,
        )
        resp.raise_for_status()
        all_contacts = resp.json()
    except requests.RequestException as e:
        print(f"  [WARN] Could not fetch contacts from Supabase: {e}")
        return []

    latest: dict[str, dict] = {}
    for c in all_contacts:
        if c.get("deleted_at"):
            continue
        iid = c["installer_id"]
        if iid not in latest:
            latest[iid] = c

    due = [
        c for c in latest.values()
        if c.get("outcome") == "Follow Up"
        and c.get("follow_up_date")
        and c["follow_up_date"] <= today_iso
    ]
    due.sort(key=lambda x: x["follow_up_date"])
    return due

# ---------------------------------------------------------------------------
# Email — HTML builder
# ---------------------------------------------------------------------------

TECH_COLOURS = {
    "Air Source Heat Pump":      "#1a7a4a",
    "Ground Source Heat Pump":   "#155d3a",
    "Exhaust Air Heat Pump":     "#1d8c55",
    "Gas Absorption Heat Pump":  "#23a066",
    "Water Source Heat Pump":    "#178a50",
    "Solar Assisted Heat Pump":  "#0e6e3f",
    "Solar Photovoltaic":        "#b07d00",
    "Solar Thermal":             "#c48f00",
    "Battery Storage":           "#6b3fa0",
    "Biomass":                   "#7a5c2e",
    "Hydro":                     "#1565a8",
    "Wind Turbine":              "#0d7da8",
    "Micro CHP":                 "#a04040",
}


def tech_badge(label: str) -> str:
    colour = TECH_COLOURS.get(label, "#555")
    return (
        f'<span style="display:inline-block;background:{colour};color:#fff;'
        f'font-size:11px;font-weight:bold;padding:3px 8px;border-radius:12px;'
        f'margin:2px 3px 2px 0;">{label}</span>'
    )


def build_installer_card(e: dict) -> str:
    name      = (e.get("name") or "Unknown").strip()
    cert      = (e.get("certification_number") or "").strip()
    cert_body = (e.get("certification_body") or "").strip()
    email     = (e.get("email") or "").strip()
    phone     = (e.get("telephone") or "").strip()
    website   = (e.get("website") or "").strip()
    postcode  = installer_postcode(e)
    location  = installer_location(e)
    techs     = installer_technologies(e)
    bus       = e.get("boiler_upgrade_scheme") == "1"
    sub_type  = (e.get("technology_sub_type") or "").strip()

    badges = "".join(tech_badge(t) for t in techs) if techs else "<em>Not specified</em>"
    bus_badge = (
        '<span style="display:inline-block;background:#1a5276;color:#fff;'
        'font-size:11px;font-weight:bold;padding:3px 8px;border-radius:12px;margin-left:6px;">'
        'BUS Registered</span>'
        if bus else ""
    )
    email_link = f'<a href="mailto:{email}" style="color:#1a5276;">{email}</a>' if email else "Not listed"
    phone_link = f'<a href="tel:{phone}" style="color:#1a5276;">{phone}</a>' if phone else "Not listed"
    if website:
        if not website.startswith("http"):
            website = "https://" + website
        web_link = f'<a href="{website}" style="color:#1a5276;">{website}</a>'
    else:
        web_link = "Not listed"
    maps_link = (
        f'<a href="{maps_url(postcode)}" style="color:#1a5276;">{location}</a>'
        if postcode else location
    )
    cert_line    = f"{cert_body} &bull; {cert}" if cert_body and cert else cert or cert_body or "Not listed"
    sub_type_line = f"<br><span style='color:#888;font-size:12px;'>{sub_type}</span>" if sub_type else ""

    return f"""
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ddd;border-radius:8px;margin-bottom:16px;font-family:Arial,sans-serif;font-size:14px;color:#333;">
      <tr>
        <td style="background:#1a5276;border-radius:7px 7px 0 0;padding:12px 16px;">
          <span style="color:#fff;font-size:16px;font-weight:bold;">{name}</span>
          {bus_badge}
          <span style="float:right;color:#acd4f5;font-size:12px;">{cert_line}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 16px;">
          <div style="margin-bottom:10px;">{badges}{sub_type_line}</div>
          <table cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td width="50%" style="vertical-align:top;padding-right:12px;">
                <p style="margin:4px 0;"><strong>&#128222; Phone:</strong> {phone_link}</p>
                <p style="margin:4px 0;"><strong>&#9993; Email:</strong> {email_link}</p>
                <p style="margin:4px 0;"><strong>&#127760; Website:</strong> {web_link}</p>
              </td>
              <td width="50%" style="vertical-align:top;">
                <p style="margin:4px 0;"><strong>&#128205; Location:</strong> {maps_link}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>"""


def build_email_html(new_entries: list[dict], run_date: str, due_followups: list[dict]) -> str:
    sections = []

    if due_followups:
        rows = ""
        for f in due_followups:
            name     = (f.get("installer_name") or "Unknown").strip()
            employee = (f.get("employee") or "").strip()
            due_date = f.get("follow_up_date", "")
            notes    = (f.get("notes") or "").strip()
            try:
                due_fmt = date.fromisoformat(due_date).strftime("%d %B %Y")
            except Exception:
                due_fmt = due_date
            rows += f"""
            <tr>
              <td style="padding:10px;border-bottom:1px solid #f5deb3;font-weight:bold;">{name}</td>
              <td style="padding:10px;border-bottom:1px solid #f5deb3;">{employee}</td>
              <td style="padding:10px;border-bottom:1px solid #f5deb3;color:#c0392b;font-weight:bold;">{due_fmt}</td>
              <td style="padding:10px;border-bottom:1px solid #f5deb3;color:#666;">{notes}</td>
            </tr>"""
        sections.append(f"""
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8e8;border:2px solid #e67e22;border-radius:8px;margin-bottom:24px;font-family:Arial,sans-serif;">
          <tr><td style="background:#e67e22;border-radius:6px 6px 0 0;padding:12px 16px;">
            <strong style="color:#fff;font-size:15px;">&#128276; {len(due_followups)} Follow-up(s) Due Today</strong>
          </td></tr>
          <tr><td style="padding:0 8px 8px;">
            <table width="100%" style="border-collapse:collapse;font-size:13px;">
              <thead><tr style="background:#fef3d0;">
                <th style="padding:8px 10px;text-align:left;color:#7d5a00;">Installer</th>
                <th style="padding:8px 10px;text-align:left;color:#7d5a00;">Employee</th>
                <th style="padding:8px 10px;text-align:left;color:#7d5a00;">Due Date</th>
                <th style="padding:8px 10px;text-align:left;color:#7d5a00;">Notes</th>
              </tr></thead>
              <tbody>{rows}</tbody>
            </table>
          </td></tr>
        </table>""")

    if not new_entries:
        sections.append("""
        <table width="100%" cellpadding="20" style="background:#f0f4f8;border-radius:8px;font-family:Arial,sans-serif;">
          <tr><td style="text-align:center;color:#555;">
            <p style="font-size:18px;">&#10003; No new installers added today.</p>
            <p style="font-size:14px;">The MCS database was checked and is unchanged since yesterday.</p>
          </td></tr>
        </table>""")
    else:
        tech_counts  = Counter(t for e in new_entries for t in installer_technologies(e))
        tech_summary = " &nbsp;|&nbsp; ".join(f"{c} &times; {t}" for t, c in tech_counts.most_common())
        cards        = "".join(build_installer_card(e) for e in new_entries)
        sections.append(f"""
        <table width="100%" cellpadding="12" style="background:#eaf3fb;border-radius:8px;margin-bottom:20px;font-family:Arial,sans-serif;">
          <tr><td>
            <p style="margin:0;font-size:15px;color:#1a5276;">
              <strong>{len(new_entries)} new installer(s)</strong> joined MCS since yesterday
            </p>
            <p style="margin:6px 0 0;font-size:13px;color:#555;">{tech_summary}</p>
          </td></tr>
        </table>
        {cards}""")

    body_content = "\n".join(sections)
    return f"""<!DOCTYPE html>
    <html><body style="margin:0;padding:20px;background:#f5f5f5;font-family:Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:700px;margin:0 auto;">
        <tr>
          <td style="background:#1a5276;border-radius:8px 8px 0 0;padding:20px 24px;">
            <h1 style="margin:0;color:#fff;font-size:20px;">MCS New Installer Alert</h1>
            <p style="margin:4px 0 0;color:#acd4f5;font-size:13px;">{run_date}</p>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;border-radius:0 0 8px 8px;padding:24px;">
            {body_content}
            <hr style="border:none;border-top:1px solid #eee;margin:20px 0;"/>
            <p style="font-size:11px;color:#aaa;margin:0;">
              Source: <a href="https://mcscertified.com/find-an-installer/" style="color:#aaa;">mcscertified.com/find-an-installer</a>
            </p>
          </td>
        </tr>
      </table>
    </body></html>"""


def send_email(subject: str, html_body: str):
    email_from = os.environ["EMAIL_FROM"]
    email_to   = os.environ["EMAIL_TO"]
    password   = os.environ["EMAIL_PASSWORD"]
    smtp_host  = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    smtp_port  = int(os.environ.get("SMTP_PORT", "587"))

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = email_from
    msg["To"]      = email_to
    msg.attach(MIMEText(html_body, "html"))

    with smtplib.SMTP(smtp_host, smtp_port) as server:
        server.ehlo()
        server.starttls()
        server.login(email_from, password)
        server.sendmail(email_from, email_to, msg.as_string())
    print(f"Email sent to {email_to}")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    run_date = datetime.now().strftime("%A %d %B %Y")
    print(f"=== MCS Installer Monitor — {run_date} ===")

    known    = load_known(DATA_FILE)
    first_run = not known
    if first_run:
        print("\nNo existing data — this is the first run; seeding database.")

    session = make_session()

    print("\nFetching nonce from MCS website ...")
    nonce = get_nonce(session)
    print(f"  Nonce: {nonce}")

    print("\nFetching all installers (nationwide) ...")
    installers = fetch_all_installers(session, nonce)
    print(f"\nTotal installers fetched: {len(installers)}")

    if first_run:
        new_entries = []
        print("First run — no email sent.")
    else:
        new_entries = find_new_installers(installers, known)
        print(f"New installers found: {len(new_entries)}")

    save_known(DATA_FILE, installers, existing=known)
    print(f"Known installers saved to '{DATA_FILE}'.")
    save_map_data(MAP_DATA_FILE, installers)

    today_iso = datetime.now().strftime("%Y-%m-%d")
    print("\nChecking for due follow-ups ...")
    due_followups = fetch_due_followups(today_iso)
    print(f"  Follow-ups due: {len(due_followups)}")

    if not first_run:
        if new_entries and due_followups:
            subject = f"MCS: {len(new_entries)} new installer(s), {len(due_followups)} follow-up(s) due — {run_date}"
        elif due_followups:
            subject = f"MCS: {len(due_followups)} follow-up(s) due today — {run_date}"
        elif new_entries:
            subject = f"MCS New Installers: {len(new_entries)} added — {run_date}"
        else:
            subject = f"MCS Installer Report: No new installers — {run_date}"
        html = build_email_html(new_entries, run_date, due_followups)
        print("\nSending email ...")
        send_email(subject, html)

    print("\nDone.")


if __name__ == "__main__":
    main()
