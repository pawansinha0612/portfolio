#!/usr/bin/env python3
"""Builds the public jobs page, https://pawansinha.com.au/jobs/.

Pulls recent jobs from free public job boards, keeps performance testing and
QA automation roles, ranks them (Australia and APAC first), and writes:
  docs/jobs/index.html   the page (readable without JavaScript)
  docs/jobs/jobs.json    the same list as data

Run daily by .github/workflows/jobs-page.yml. Python standard library only.
What to look for lives in jobs/config.json.

Safety rules:
  - If every job board fails, nothing is written and the script exits 1
    (the run shows red), so the live page keeps yesterday's list.
  - Jobs from the previous run that are still recent are kept, so one board
    failing for a day doesn't empty its part of the page.
  - If nothing matches at all and a previous page exists, the previous page is kept.

Usage:
  python3 jobs/build.py                 fetch and write the page
  python3 jobs/build.py --only remotive fetch from some boards only (testing)
  JOBS_FAKE_FAIL=1 python3 jobs/build.py   pretend every board failed (testing)
  python3 jobs/build.py --offline          rebuild the page from docs/jobs/jobs.json only
"""

import argparse
import datetime as dt
import email.utils
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONFIG_PATH = os.path.join(HERE, "config.json")
OUT_DIR = os.path.join(ROOT, "docs", "jobs")
OUT_HTML = os.path.join(OUT_DIR, "index.html")
OUT_JSON = os.path.join(OUT_DIR, "jobs.json")
SITE = "https://pawansinha.com.au"
ENDPOINT = ("https://script.google.com/macros/s/AKfycbzvFENGzJ59oV9fx3Vc6CFzkjVpv5uFCx3Ob4zp_gfw0tNCXCI8TQYwJ9zQfkHQrARF"
            "/exec")
USER_AGENT = "Mozilla/5.0 (compatible; pawansinha.com.au-jobs/1.0; +https://pawansinha.com.au/jobs/)"
UTC = dt.timezone.utc
MANY_COUNTRIES = 25
PERF_TITLE = re.compile(r"perf[o]?r?mance|rendimiento|load|stress|non-functional", re.I)
REMOTE_BOARDS = {"Himalayas", "Remote OK", "Remotive", "Jobicy", "We Work Remotely"}

try:
    from zoneinfo import ZoneInfo
    MELB = ZoneInfo("Australia/Melbourne")
except Exception:  # no tz database available
    MELB = dt.timezone(dt.timedelta(hours=11))


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- HTTP

def http_get(url, accept="application/json"):
    if os.environ.get("JOBS_FAKE_FAIL"):
        raise RuntimeError("JOBS_FAKE_FAIL is set")
    last = None
    for _ in range(2):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
            with urllib.request.urlopen(req, timeout=40) as resp:
                return resp.read()
        except Exception as exc:  # retry once, then give up
            last = exc
            time.sleep(3)
    raise last


def get_json(url):
    return json.loads(http_get(url).decode("utf-8", "replace"))


# ---------------------------------------------------------------- helpers

def strip_html(text):
    text = html.unescape(text or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def parse_date(value):
    """Return an aware datetime, or None."""
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)) or str(value).isdigit():
            return dt.datetime.fromtimestamp(int(value), UTC)
        s = str(value).strip()
        if re.match(r"^\d{4}-\d{2}-\d{2}", s):
            s = s.replace("Z", "+00:00")
            d = dt.datetime.fromisoformat(s)
            return d if d.tzinfo else d.replace(tzinfo=UTC)
        return email.utils.parsedate_to_datetime(s)
    except Exception:
        return None


def as_list_text(value):
    if isinstance(value, list):
        return ", ".join(str(v) for v in value)
    return str(value or "")


def job(source, jid, title, company, location, url, posted, description="", extra=""):
    return {
        "source": source,
        "id": f"{source}:{jid}",
        "title": strip_html(title)[:140],
        "company": strip_html(company)[:80],
        "location": strip_html(location)[:3000],  # shortened for display by place()
        "url": str(url or "").strip(),
        "posted": parse_date(posted),
        "description": strip_html(description)[:20000],
        "extra": extra or "",
    }


# ---------------------------------------------------------------- sources
# Each source returns a list of job dicts. A failure in one is caught by the caller.

def src_himalayas(cfg):
    out, ok = [], 0
    base = "https://himalayas.app/jobs/api/search?"
    searches = [(q, None) for q in cfg.get("queries", [])]
    searches += [(q, "AU") for q in cfg.get("australia_queries", [])]
    for q, country in searches:
        params = {"q": q, "sort": "recent"}
        if country:
            params["country"] = country
        try:
            data = get_json(base + urllib.parse.urlencode(params))
            ok += 1
        except Exception as exc:
            log(f"  himalayas query '{q}' failed: {exc}")
            continue
        for j in data.get("jobs", []):
            loc = as_list_text(j.get("locationRestrictions")) or "Remote (worldwide)"
            out.append(job("Himalayas", j.get("guid") or j.get("applicationLink"), j.get("title"),
                           j.get("companyName"), loc, j.get("applicationLink") or j.get("guid"),
                           j.get("pubDate"), (j.get("excerpt") or "") + " " + (j.get("description") or ""),
                           j.get("employmentType") or ""))
        time.sleep(1)
    if searches and not ok:
        raise RuntimeError("every Himalayas query failed")
    return out


def src_remoteok(cfg):
    data = get_json("https://remoteok.com/api")
    out = []
    for j in data:
        if not isinstance(j, dict) or not j.get("id") or not j.get("position"):
            continue  # first element is the legal notice
        out.append(job("Remote OK", j["id"], j.get("position"), j.get("company"),
                       j.get("location") or "Remote", j.get("url") or j.get("apply_url"),
                       j.get("date") or j.get("epoch"),
                       as_list_text(j.get("tags")) + " " + (j.get("description") or "")))
    return out


def src_remotive(cfg):
    data = get_json("https://remotive.com/api/remote-jobs")
    return [job("Remotive", j.get("id"), j.get("title"), j.get("company_name"),
                j.get("candidate_required_location") or "Remote", j.get("url"),
                j.get("publication_date"), as_list_text(j.get("tags")) + " " + (j.get("description") or ""),
                j.get("job_type") or "")
            for j in data.get("jobs", [])]


def src_jobicy(cfg):
    urls = ["https://jobicy.com/api/v2/remote-jobs?count=100",
            "https://jobicy.com/api/v2/remote-jobs?count=100&geo=australia",
            "https://jobicy.com/api/v2/remote-jobs?count=100&geo=apac"]
    urls += ["https://jobicy.com/api/v2/remote-jobs?count=50&" + urllib.parse.urlencode({"tag": t})
             for t in cfg.get("tags", [])]
    out, ok = [], 0
    for u in urls:
        try:
            data = get_json(u)
            ok += 1
        except Exception as exc:
            log(f"  jobicy {u} failed: {exc}")
            continue
        for j in data.get("jobs", []) or []:
            out.append(job("Jobicy", j.get("id"), j.get("jobTitle"), j.get("companyName"),
                           j.get("jobGeo") or "Remote", j.get("url"), j.get("pubDate"),
                           (j.get("jobExcerpt") or "") + " " + (j.get("jobDescription") or ""),
                           as_list_text(j.get("jobType"))))
        time.sleep(1)
    if not ok:
        raise RuntimeError("every Jobicy request failed")
    return out


def src_arbeitnow(cfg):
    out = []
    for page in range(1, int(cfg.get("pages", 1)) + 1):
        data = get_json(f"https://www.arbeitnow.com/api/job-board-api?page={page}")
        for j in data.get("data", []):
            loc = j.get("location") or ""
            if str(j.get("remote")).lower() == "true":
                loc = (loc + " (remote)").strip()
            out.append(job("Arbeitnow", j.get("slug"), j.get("title"), j.get("company_name"), loc,
                           j.get("url"), j.get("created_at"),
                           as_list_text(j.get("tags")) + " " + (j.get("description") or ""),
                           as_list_text(j.get("job_types"))))
    return out


def src_weworkremotely(cfg):
    root = ET.fromstring(http_get("https://weworkremotely.com/remote-jobs.rss", "application/rss+xml"))
    out = []
    for item in root.iter("item"):
        full = item.findtext("title") or ""
        company, _, title = full.partition(":")
        if not title:
            company, title = "", full
        loc = item.findtext("region") or item.findtext("country") or "Remote"
        out.append(job("We Work Remotely", item.findtext("guid") or item.findtext("link"), title.strip(),
                       company.strip(), loc, item.findtext("link"), item.findtext("pubDate"),
                       (item.findtext("skills") or "") + " " + (item.findtext("description") or ""),
                       item.findtext("type") or ""))
    return out


SOURCES = {
    "himalayas": src_himalayas,
    "remoteok": src_remoteok,
    "remotive": src_remotive,
    "jobicy": src_jobicy,
    "arbeitnow": src_arbeitnow,
    "weworkremotely": src_weworkremotely,
}


# ---------------------------------------------------------------- matching

def kw_regex(words):
    words = sorted({w.strip().lower() for w in words if w.strip()}, key=len, reverse=True)
    if not words:
        return None
    alt = "|".join(re.escape(w) for w in words)
    return re.compile(rf"(?<![a-z0-9])({alt})(?![a-z0-9])", re.I)


def hits(rx, text):
    return {m.group(1).lower() for m in rx.finditer(text)} if rx and text else set()


class Matcher:
    def __init__(self, cfg):
        self.strong = kw_regex(cfg["strong_keywords"])
        self.qa = kw_regex(cfg["qa_keywords"])
        self.bonus = kw_regex(cfg.get("bonus_keywords", []))
        self.exclude = kw_regex(cfg["exclude_title_words"])
        self.software = kw_regex(cfg.get("software_signals", []))
        self.loc_boost = {k.lower(): v for k, v in cfg.get("location_boost", {}).items()}
        self.loc_rx = kw_regex(self.loc_boost.keys())
        self.au_rx = kw_regex(cfg.get("australia_words", []))

    def score(self, j):
        """Adds score, group and region to the job and returns the score, or None if it doesn't match."""
        title = j["title"]
        if hits(self.exclude, title):
            return None
        desc = j["description"]
        t_strong, t_qa = hits(self.strong, title), hits(self.qa, title)
        d_strong, d_qa = hits(self.strong, desc) - t_strong, hits(self.qa, desc) - t_qa
        if not (t_strong or t_qa):
            return None  # the title must say it's a testing role; a mention in the description isn't enough
        if not t_strong and len(hits(self.software, f"{title} {desc}")) < 2:
            return None  # probably a hardware, lab or factory test role
        s = 0
        if t_strong:
            s += 30 + 5 * (len(t_strong) - 1)
        if t_qa:
            s += 12 + 2 * min(len(t_qa) - 1, 2)
        s += min(4 * len(d_strong), 16)
        s += min(len(d_qa), 5)
        s += min(2 * len(hits(self.bonus, f"{title} {desc} {j['extra']}")), 10)
        boosts = [self.loc_boost[w] for w in hits(self.loc_rx, f"{j['location']} {title}")]
        s += max(boosts, default=0)
        j["score"] = s
        j["group"] = "perf" if (t_strong or PERF_TITLE.search(title)) else "qa"
        j["region"] = self.region(j)
        return s

    def title_ok(self, title):
        """Re-checks a job kept from the previous run, so config changes also clean out old entries."""
        return not hits(self.exclude, title) and bool(hits(self.strong, title) or hits(self.qa, title))

    def region(self, j):
        loc = j["location"]
        many = len([p for p in loc.split(",") if p.strip()]) >= MANY_COUNTRIES  # a worldwide list that happens to include Australia
        if hits(self.au_rx, loc) and not many:
            return "australia"
        if j["source"] in REMOTE_BOARDS or re.search(r"remote|worldwide|anywhere", loc, re.I):
            return "remote"
        return "onsite"


def place(j):
    """Short location for display: long country lists become 'Australia and 12 other countries'."""
    loc = j["location"].strip()
    parts = [p.strip() for p in loc.split(",") if p.strip()]
    remote = ((j.get("region") == "remote" or j["source"] in REMOTE_BOARDS)
              and not re.search(r"remote|worldwide|anywhere", loc, re.I))
    if len(parts) > 3:
        au = next((p for p in parts if p.lower() == "australia"), None)
        if len(parts) >= MANY_COUNTRIES:
            loc = "Many countries"
        elif au:
            loc = f"Australia and {len(parts) - 1} other countries"
        else:
            loc = f"{', '.join(parts[:2])} and {len(parts) - 2} more"
    if len(loc) > 70:
        loc = loc[:69].rstrip(" ,") + "…"
    if remote:
        loc = f"Remote · {loc}" if loc else "Remote"
    return loc


def norm_key(j):
    return re.sub(r"[^a-z0-9]+", " ", (j["title"] + " " + j["company"]).lower()).strip()


# ---------------------------------------------------------------- previous run

def load_previous():
    try:
        with open(OUT_JSON) as f:
            data = json.load(f)
        return data.get("jobs", []) if isinstance(data, dict) else []
    except (OSError, ValueError):
        return []


def from_saved(d):
    """A job from jobs.json, back in the shape the builder uses."""
    return {
        "source": d.get("source", ""), "id": d.get("id", ""), "title": d.get("title", ""),
        "company": d.get("company", ""), "location": d.get("location", ""), "url": d.get("url", ""),
        "posted": parse_date(d.get("posted")), "group": d.get("group", "qa"),
        "region": d.get("region", "remote"), "score": int(d.get("score", 0)),
        "first_seen": parse_date(d.get("first_seen")) or parse_date(d.get("posted")),
    }


# ---------------------------------------------------------------- page

def esc(s):
    return html.escape(str(s or ""), quote=True)


def safe_url(u):
    return u if re.match(r"^https?://", u or "", re.I) else ""


def melb_day(d):
    d = d.astimezone(MELB)
    return f"{d.day} {d:%b %Y}"


REGION_LABEL = {"australia": "Australia / APAC", "remote": "Remote", "onsite": "On-site / hybrid"}
GROUP_LABEL = {"perf": "Performance", "qa": "QA automation"}


def job_item(j):
    posted = melb_day(j["posted"]) if j["posted"] else "Date not given"
    iso = j["posted"].astimezone(MELB).date().isoformat() if j["posted"] else ""
    text = " ".join([j["title"], j["company"], place(j), j["location"][:300], j["source"]]).lower()
    company = esc(j["company"]) or "Company not listed"
    location = esc(place(j)) or "Location not listed"
    return (f'<li class="job" data-group="{j["group"]}" data-region="{j["region"]}" data-text="{esc(text)}">\n'
            f'  <div class="job-main">\n'
            f'    <h3><a href="{esc(j["url"])}" target="_blank" rel="nofollow noopener">{esc(j["title"])}</a></h3>\n'
            f'    <p class="job-meta"><span class="job-co">{company}</span> · {location}</p>\n'
            f'  </div>\n'
            f'  <div class="job-side">\n'
            f'    <span class="job-tag {j["group"]}">{GROUP_LABEL[j["group"]]}</span>\n'
            f'    <span class="job-when"><time datetime="{iso}">{esc(posted)}</time> · via {esc(j["source"])}</span>\n'
            f'  </div>\n'
            f'</li>')


def render(jobs, updated, sources_ok):
    n_perf = sum(1 for j in jobs if j["group"] == "perf")
    n_qa = len(jobs) - n_perf
    n_au = sum(1 for j in jobs if j["region"] == "australia")
    n_remote = sum(1 for j in jobs if j["region"] == "remote")
    items = "\n".join(job_item(j) for j in jobs) if jobs else ""
    empty = "" if jobs else '<p class="jobs-empty-static">No matching roles were found today. Check back tomorrow: the list updates every morning.</p>'
    title = "Performance Testing &amp; QA Automation Jobs — Pawan Sinha"
    desc = ("Remote and Australian performance testing, load testing and QA automation jobs from public job boards, "
            "updated every morning.")
    sources = ", ".join(sources_ok) if sources_ok else "public job boards"
    page = TEMPLATE
    for k, v in {
        "{{TITLE}}": title, "{{DESC}}": esc(desc), "{{UPDATED}}": esc(melb_day(updated)),
        "{{UPDATED_ISO}}": updated.astimezone(MELB).date().isoformat(), "{{COUNT}}": str(len(jobs)),
        "{{N_PERF}}": str(n_perf), "{{N_QA}}": str(n_qa), "{{N_AU}}": str(n_au), "{{N_REMOTE}}": str(n_remote),
        "{{ITEMS}}": items, "{{EMPTY}}": empty, "{{SOURCES}}": esc(sources), "{{ENDPOINT}}": ENDPOINT,
    }.items():
        page = page.replace(k, v)
    return page


TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{TITLE}}</title>
  <meta name="description" content="{{DESC}}">
  <meta property="og:title" content="{{TITLE}}">
  <meta property="og:description" content="{{DESC}}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://pawansinha.com.au/jobs/">
  <meta property="og:image" content="https://pawansinha.com.au/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="https://pawansinha.com.au/jobs/">
  <meta name="theme-color" content="#2557d6">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%232557d6'/><path d='M7 22l6-7 5 4 7-10' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/chat.css">
  <!-- Generated by jobs/build.py every morning. Edit the template there, not this file. -->
  <style>
    .project-hero { padding: 64px 16px 8px; max-width: 860px; }
    .project-hero h1 { font-size: clamp(30px, 5vw, 46px); line-height: 1.1; margin: 0 0 16px; }
    .updated { color: var(--muted); font-size: 14px; margin: 14px 0 0; }
    .jobs { max-width: 860px; padding: 24px 16px 8px; }
    .job-filters { display: flex; flex-direction: column; gap: 12px; margin: 0 0 18px; }
    .job-filters[hidden] { display: none; }
    .job-filters input {
      width: 100%; font: inherit; font-size: 16px; color: var(--text); background: var(--surface);
      border: 1px solid var(--border); border-radius: 10px; padding: 10px 13px; }
    .job-filters input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .chip-btn { font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; color: var(--muted);
      background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 5px 14px; }
    .chip-btn[aria-pressed="true"] { color: var(--accent-text); background: var(--accent); border-color: var(--accent); }
    .chip-btn small { font-weight: 500; opacity: .8; }
    .job-count { color: var(--muted); font-size: 14px; margin: 0 0 10px; }
    .job-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
    .job { display: flex; flex-wrap: wrap; gap: 6px 16px; justify-content: space-between; align-items: flex-start;
      background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px 18px; }
    .job[hidden] { display: none; }
    .job:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
    .job-main { flex: 1 1 380px; min-width: 0; }
    .job h3 { margin: 0 0 4px; font-size: 17px; line-height: 1.35; overflow-wrap: anywhere; }
    .job h3 a { color: var(--text); text-decoration: none; }
    .job h3 a:hover { color: var(--accent); text-decoration: underline; }
    .job-meta { margin: 0; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
    .job-co { color: var(--text); font-weight: 600; }
    .job-side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: 0 1 auto; }
    .job-tag { font-size: 12px; font-weight: 700; padding: 2px 10px; border-radius: 999px; white-space: nowrap; }
    .job-tag.perf { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .job-tag.qa { color: var(--ok); background: var(--ok-bg); }
    .job-when { color: var(--muted); font-size: 13px; text-align: right; }
    .jobs-empty, .jobs-empty-static { color: var(--muted); padding: 28px 0; text-align: center; }
    .jobs-note { color: var(--muted); font-size: 14px; margin: 18px 0 0; }
    .jobs-end { max-width: 860px; padding: 32px 16px 72px; display: flex; flex-direction: column; gap: 16px; }
    .jobs-end .offer { margin: 0; }
    .alert-link { display: inline-flex; gap: 6px; align-items: center; margin: 14px 0 0; font-weight: 600; font-size: 15px; }
    .alerts { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 22px 24px; box-shadow: var(--shadow); scroll-margin-top: 90px; }
    .alerts h2 { margin: 0 0 6px; font-size: 21px; }
    .alerts > p { margin: 0 0 14px; color: var(--muted); font-size: 15px; }
    .alerts form { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; align-items: end; }
    .alerts form[hidden] { display: none; }
    .alerts label { display: grid; gap: 6px; font-size: 14px; font-weight: 600; min-width: 0; }
    .alerts input, .alerts select { width: 100%; font: inherit; font-size: 16px; color: var(--text); background: var(--surface);
      border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; min-width: 0; }
    .alerts input:focus-visible, .alerts select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .alerts .wide { grid-column: 1 / -1; }
    .alerts button { font: inherit; font-weight: 600; cursor: pointer; grid-column: 1 / -1; justify-self: start; }
    .alerts button:disabled { opacity: .6; cursor: progress; }
    .alerts .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
    .alerts .status { margin: 0; font-size: 15px; color: var(--muted); grid-column: 1 / -1; }
    .alerts .status:empty { display: none; }
    .alerts .fine { margin: 10px 0 0; font-size: 13px; color: var(--muted); }
    @media (max-width: 600px) {
      .project-hero { padding-top: 40px; }
      .job { padding: 12px 14px; }
      .job-side { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px 10px; flex-basis: 100%; }
      .job-when { text-align: left; }
      .alerts { padding: 20px 16px; }
      .alerts button { justify-self: stretch; }
    }
  </style>
  <!-- AdSense (content pages only) -->
  <meta name="google-adsense-account" content="ca-pub-8128510632378263">
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8128510632378263" crossorigin="anonymous"></script>
</head>
<body>
  <header class="nav">
    <div class="wrap nav-inner">
      <a class="brand" href="/"><span class="logo" aria-hidden="true"></span>Pawan Sinha</a>
      <nav id="site-menu" aria-label="Main">
        <a href="/#services">Services</a>
        <a href="/#work">Work</a>
        <a href="/tools/">Tools</a>
        <a href="/learn/" aria-current="page">Learn</a>
        <a href="/blog/">Blog</a>
        <a href="/#contact" class="btn btn-small">Hire me</a>
      </nav>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-menu" aria-label="Open menu"><span></span></button>
    </div>
  </header>

  <main>
    <section class="wrap project-hero">
      <p class="eyebrow">Jobs board · Updated daily</p>
      <h1>Performance testing &amp; QA automation jobs</h1>
      <p class="lead">Performance engineering, load testing and test automation roles from public job boards. Australian and Asia-Pacific roles come first, then remote roles open worldwide.</p>
      <p class="updated">Updated <time datetime="{{UPDATED_ISO}}">{{UPDATED}}</time> · {{COUNT}} roles · roles older than 3 weeks drop off</p>
      <a class="alert-link" href="#alerts" data-track="jobs-alert-link">🔔 Get new roles by email</a>
    </section>

    <section class="wrap jobs" aria-label="Job listings">
      <div class="job-filters" id="job-filters" hidden>
        <input id="job-q" type="search" placeholder="Search roles, companies or places, e.g. k6, Sydney, SDET" aria-label="Search jobs">
        <div class="chip-row" role="group" aria-label="Type of role">
          <button class="chip-btn" type="button" data-group="" aria-pressed="true">All roles</button>
          <button class="chip-btn" type="button" data-group="perf" aria-pressed="false">Performance <small>{{N_PERF}}</small></button>
          <button class="chip-btn" type="button" data-group="qa" aria-pressed="false">QA automation <small>{{N_QA}}</small></button>
        </div>
        <div class="chip-row" role="group" aria-label="Where">
          <button class="chip-btn" type="button" data-region="" aria-pressed="true">Anywhere</button>
          <button class="chip-btn" type="button" data-region="australia" aria-pressed="false">Australia / APAC <small>{{N_AU}}</small></button>
          <button class="chip-btn" type="button" data-region="remote" aria-pressed="false">Remote <small>{{N_REMOTE}}</small></button>
        </div>
      </div>
      <p class="job-count" id="job-count" aria-live="polite"></p>
      <ul class="job-list" id="job-list">
{{ITEMS}}
      </ul>
      {{EMPTY}}
      <p class="jobs-empty" id="jobs-empty" hidden>No roles match those filters. Try a broader search.</p>
      <p class="jobs-note">Listings come from public job boards ({{SOURCES}}) and are matched automatically, so the odd one may be off-topic or already filled. Always check the details, salary and work rights on the original posting before you apply. I'm not the recruiter for these roles.</p>
    </section>

    <section class="wrap jobs-end">
      <div class="alerts" id="alerts">
        <h2>🔔 Job alerts</h2>
        <p>Get new roles by email as they're added, daily or every Monday. No email when nothing new turns up. Free, unsubscribe in one click.</p>
        <p class="soon">Loading…</p>
        <form hidden novalidate>
          <label class="wide">Email<input type="email" name="email" required maxlength="200" placeholder="you@example.com" autocomplete="email"></label>
          <label>Roles<select name="roles"><option value="all">Performance + QA</option><option value="perf">Performance only</option><option value="qa">QA automation only</option></select></label>
          <label>Where<select name="where"><option value="australia+remote">Australia + remote</option><option value="australia">Australia / APAC only</option><option value="all">Anywhere</option></select></label>
          <label>How often<select name="often"><option value="weekly">Weekly (Mondays)</option><option value="daily">Daily</option></select></label>
          <label class="hp" aria-hidden="true">Leave this empty<input name="company_site" tabindex="-1" autocomplete="off"></label>
          <button class="btn" type="submit" data-track="jobs-alert-submit">Turn on alerts</button>
          <p class="status" role="status" aria-live="polite"></p>
        </form>
        <p class="fine">Already signed up? Sign up again with the same email to change your choices.</p>
      </div>
      <div class="offer">
        <div>
          <p class="eyebrow">Got an interview?</p>
          <h3>Practise the questions first</h3>
          <p>Performance testing interview questions with model answers, from 3 to 7+ years of experience: k6, JMeter, LoadRunner, bottlenecks, JVM tuning and capacity planning.</p>
        </div>
        <a class="btn" href="/interview-prep/" data-track="jobs-interview-prep">Practise the questions</a>
      </div>
      <div class="offer">
        <div>
          <p class="eyebrow">Roles that aren't on job boards</p>
          <h3>Join my testers' talent pool</h3>
          <p>I recruit QA, automation and performance testers for companies I work with. Join once and I'll email you when a role fits. Nothing is shared without asking you first.</p>
        </div>
        <a class="btn btn-ghost" href="/talent-pool/" data-track="jobs-talent-pool">Join the talent pool</a>
      </div>
      <div class="offer">
        <div>
          <p class="eyebrow">Hiring a performance engineer?</p>
          <h3>Skip the job ad</h3>
          <p>12+ years of performance testing and QA automation in banking, payments and gaming. Available for contract and permanent roles in Melbourne or remote.</p>
        </div>
        <a class="btn btn-ghost" href="/hire/" data-track="jobs-hire">See my profile</a>
      </div>

      <form class="subscribe" data-endpoint="{{ENDPOINT}}" hidden novalidate>
        <div class="sub-text">
          <h2>One performance deep dive a week</h2>
          <p>Every Sunday: the week's posts and new calculators in one short email. Unsubscribe any time.</p>
        </div>
        <div class="sub-row">
          <input type="email" name="email" required maxlength="200" placeholder="you@company.com" aria-label="Email address" autocomplete="email">
          <button class="btn" type="submit">Subscribe</button>
        </div>
        <label class="hp" aria-hidden="true">Leave this empty<input name="company_site" tabindex="-1" autocomplete="off"></label>
        <p class="sub-status" role="status" aria-live="polite"></p>
      </form>
    </section>
  </main>

  <footer class="site-footer">
    <div class="wrap footer-grid">
      <div class="footer-about">
        <a class="brand" href="/"><span class="logo" aria-hidden="true"></span>Pawan Sinha</a>
        <p>Software testing and performance engineering for teams that can't afford to ship bugs. Melbourne, Australia. Remote, hybrid or on-site.</p>
        <p><a href="mailto:hello@pawansinha.com.au">hello@pawansinha.com.au</a> · <a href="https://www.linkedin.com/in/pawan-sinha-b5a356b6/" target="_blank" rel="noopener">LinkedIn</a></p>
      </div>
      <div>
        <h2>Work with me</h2>
        <a href="/#services">Services</a>
        <a href="/#engage">Engagements</a>
        <a href="/#work">Case studies</a>
        <a href="/peak-readiness/">Peak-readiness load test</a>
        <a href="/#contact">Book a free call</a>
        <a href="/hire/">For recruiters</a>
      </div>
      <div>
        <h2>Free resources</h2>
        <a href="/interview-prep/">Interview prep</a>
        <a href="/guides/">Guides</a>
        <a href="/tools/">Calculators</a>
        <a href="/interview-prep/practice/">Interview practice</a>
        <a href="/course/k6/">k6 email course</a>
        <a href="/peak-readiness/quiz/">Peak-readiness quiz</a>
        <a href="/jobs/">Testing jobs</a>
        <a href="/blog/">Blog</a>
        <a href="/blog/feed.xml">RSS feed</a>
      </div>
      <div>
        <h2>Built by me</h2>
        <a href="/#projects">Projects</a>
        <a href="/projects/deal-finder/">Melbourne Deal Finder</a>
        <a href="/portfolio-template/">Portfolio Website Template</a>
        <a href="/perf-advisor/">Perf Advisor</a>
        <a href="/interview-prep/guide/">Interview Guide</a>
        <a href="/templates/">Test templates</a>
        <a href="/shop/">Shop</a>
      </div>
    </div>
    <div class="wrap footer-bottom">
      <p>© <span data-year>2026</span> Pawan Sinha · QA &amp; Test Automation Engineer</p>
      <p><a href="/privacy/">Privacy</a> · ABN 43 627 514 346</p>
    </div>
  </footer>

  <script>
    // Optional filters. Without JavaScript every job is still listed.
    (() => {
      const list = document.getElementById('job-list');
      const jobs = [...list.querySelectorAll('.job')];
      const count = document.getElementById('job-count');
      const none = document.getElementById('jobs-empty');
      if (!jobs.length) return;
      const box = document.getElementById('job-filters');
      const q = document.getElementById('job-q');
      let group = '', region = '';
      box.hidden = false;
      function apply() {
        const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        let shown = 0;
        jobs.forEach(li => {
          const ok = (!group || li.dataset.group === group) && (!region || li.dataset.region === region)
            && words.every(w => li.dataset.text.includes(w));
          li.hidden = !ok;
          if (ok) shown++;
        });
        count.textContent = shown === jobs.length ? `${jobs.length} roles` : `${shown} of ${jobs.length} roles`;
        none.hidden = shown > 0;
      }
      box.querySelectorAll('[data-group]').forEach(b => b.addEventListener('click', () => {
        group = b.dataset.group;
        box.querySelectorAll('[data-group]').forEach(x => x.setAttribute('aria-pressed', x === b));
        apply();
      }));
      box.querySelectorAll('[data-region]').forEach(b => b.addEventListener('click', () => {
        region = b.dataset.region;
        box.querySelectorAll('[data-region]').forEach(x => x.setAttribute('aria-pressed', x === b));
        apply();
      }));
      q.addEventListener('input', apply);
      apply();
    })();
  </script>
  <script>
    // Job alerts form. It appears only once the Apps Script version with job alerts is deployed.
    (() => {
      const ENDPOINT = '{{ENDPOINT}}';
      const box = document.getElementById('alerts');
      const form = box.querySelector('form'), soon = box.querySelector('.soon');
      const status = form.querySelector('.status'), button = form.querySelector('button');
      fetch(ENDPOINT + '?view=features').then(r => r.json()).then(o => {
        if ((o.features || []).includes('jobs')) { form.hidden = false; soon.remove(); }
        else throw new Error('not deployed');
      }).catch(() => { soon.textContent = 'Job alerts open very soon. Meanwhile, bookmark this page: it updates every morning.'; });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const email = form.elements.email;
        if (!email.value.trim() || !email.checkValidity()) { status.textContent = 'Please enter a valid email address.'; email.focus(); return; }
        button.disabled = true; status.textContent = 'Turning on your alerts…';
        const body = new URLSearchParams(new FormData(form));
        body.append('form', 'jobs'); body.append('page', location.href);
        try {
          const out = await (await fetch(ENDPOINT, { method: 'POST', body })).json();
          if (!out.ok) { status.textContent = out.error || 'Something went wrong. Please try again.'; return; }
          status.textContent = out.updated
            ? 'Done: your alert choices are updated.'
            : "You're in. The roles open right now are on their way to your inbox (check the spam folder, just in case).";
          form.elements.email.value = '';
          if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: 'jobs-alert-on', title: 'jobs-alert-on', event: true });
        } catch {
          status.textContent = "Sorry, that didn't go through. Please try again later.";
        } finally {
          button.disabled = false;
        }
      });
    })();
  </script>
  <script src="/subscribe.js" defer></script>
  <script src="/chat.js" data-mode="services" data-endpoint="{{ENDPOINT}}" data-booking-url="https://calendly.com/pawansinha4u/30min" defer></script>
  <script src="/glow.js" defer></script>
  <script src="/menu.js" defer></script>
</body>
</html>
"""


# ---------------------------------------------------------------- main

def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma-separated board names to fetch (for testing)")
    ap.add_argument("--offline", action="store_true", help="rebuild the page from docs/jobs/jobs.json, fetch nothing")
    args = ap.parse_args()

    with open(CONFIG_PATH) as f:
        cfg = json.load(f)
    matcher = Matcher(cfg)
    now = dt.datetime.now(UTC)
    cutoff = now - dt.timedelta(days=int(cfg.get("max_age_days", 21)))
    max_jobs = int(cfg.get("max_jobs", 150))

    status, found = {}, []
    if not args.offline:
        only = set(args.only.split(",")) if args.only else None
        for name, fn in SOURCES.items():
            scfg = cfg.get("sources", {}).get(name, {})
            if not scfg.get("enabled", True) or (only and name not in only):
                continue
            try:
                got = fn(scfg)
                status[name] = "ok"
                log(f"{name}: {len(got)} jobs fetched")
                found += got
            except Exception as exc:
                status[name] = f"{type(exc).__name__}: {exc}"
                log(f"::warning::Jobs page: {name} failed: {exc}")
        if not any(s == "ok" for s in status.values()):
            log("::error::Every job board failed. The page was not changed, so it keeps the previous list.")
            return 1

    # Fresh matches first, then still-recent jobs from the previous run (keeps a board's jobs if it failed today).
    fresh = []
    for j in found:
        if not safe_url(j["url"]) or not j["title"]:
            continue
        if j["posted"] and j["posted"] < cutoff:
            continue
        if j["posted"] and j["posted"] > now + dt.timedelta(days=1):
            j["posted"] = now  # a board with a bad clock shouldn't pin a job to the top
        if matcher.score(j) is None:
            continue
        fresh.append(j)
    previous = [from_saved(d) for d in load_previous()]
    for p in previous:  # recompute labels, so rule changes apply to kept jobs too
        p["region"] = matcher.region(p)
        p["group"] = "perf" if (hits(matcher.strong, p["title"]) or PERF_TITLE.search(p["title"])) else "qa"
    kept_from_previous = [p for p in previous
                          if safe_url(p["url"]) and matcher.title_ok(p["title"])
                          and (p["posted"] or p["first_seen"] or now) >= cutoff]  # undated jobs expire too
    first_seen = {p["url"]: p["first_seen"] for p in previous if p["first_seen"]}
    for j in fresh:
        j["first_seen"] = first_seen.get(j["url"]) or now

    jobs, seen = [], set()
    for j in sorted(fresh, key=lambda j: (-j["score"], -(j["posted"].timestamp() if j["posted"] else 0))) + kept_from_previous:
        keys = {j["url"], norm_key(j)}
        if keys & seen:
            continue
        seen |= keys
        jobs.append(j)
    # Final order: Australia / APAC first, then best match, newest first within a score.
    jobs.sort(key=lambda j: (j["region"] != "australia", -j["score"],
                             -(j["posted"].timestamp() if j["posted"] else 0)))
    per_company, capped = {}, []
    for j in jobs:  # one agency posting the same role ten times shouldn't fill the page
        c = (j["company"] or j["id"]).lower()
        per_company[c] = per_company.get(c, 0) + 1
        if per_company[c] <= int(cfg.get("max_per_company", 3)):
            capped.append(j)
    jobs = capped[:max_jobs]
    log(f"{len(fresh)} matching jobs today, {len(jobs)} on the page")

    if not jobs and previous:
        log("::warning::No jobs matched today. Keeping the previous page.")
        return 0

    sources_ok = sorted({j["source"] for j in jobs})
    os.makedirs(OUT_DIR, exist_ok=True)
    data = {
        "updated": now.isoformat(timespec="seconds"),
        "count": len(jobs),
        "sources": status,
        "jobs": [{
            "title": j["title"], "company": j["company"], "location": j["location"][:3000], "url": j["url"],
            "source": j["source"], "id": j["id"],
            "posted": j["posted"].isoformat(timespec="seconds") if j["posted"] else None,
            "group": j["group"], "region": j["region"], "score": j["score"],
            "first_seen": j["first_seen"].isoformat(timespec="seconds") if j.get("first_seen") else None,
        } for j in jobs],
    }
    write_atomic(OUT_JSON, json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    write_atomic(OUT_HTML, render(jobs, now, sources_ok))
    log(f"Wrote {OUT_HTML} and {OUT_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
