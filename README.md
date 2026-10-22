# pawansinha.com.au

Portfolio website and tooling for **Pawan Sinha, QA & Test Automation Engineer** (Melbourne, ABN registered).

**Live site:** https://pawansinha.com.au

```
docs/        The website: plain HTML, CSS and JavaScript, no build step
  index.html   Page content
  styles.css   Design, layout and animation styles
  main.js      Animations, scroll effects, booking button, placeholder hiding
  CNAME        Tells GitHub Pages to serve the site at pawansinha.com.au
notifier/    Script that emails your network when a contract is about to end
profile/     Private notes (Upwork profile, testimonial drafts, roadmap). Git-ignored, never published.
```

---

## How the site is hosted

| Piece | Where | Cost |
|---|---|---|
| Domain `pawansinha.com.au` | Hostinger (registrar) | ~A$20/year |
| Website files and hosting | GitHub Pages, from the `docs/` folder on `main` | Free |
| HTTPS certificate | Issued automatically by GitHub Pages (Let's Encrypt) | Free |

You don't need a Hostinger hosting plan. Hostinger only holds the domain and its DNS records.

### DNS records (set in Hostinger → Domains → pawansinha.com.au → DNS / Nameservers)

| Type | Name | Value |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `pawansinha0612.github.io` |

**Where these values come from:** the four IP addresses are GitHub Pages' official servers, published in GitHub's docs
([Managing a custom domain for your GitHub Pages site](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site#configuring-an-apex-domain)).
There are four for redundancy, so if one is down, browsers use another.
- The **A records** point the bare domain (`pawansinha.com.au`) at GitHub.
- The **CNAME** points `www.pawansinha.com.au` at your GitHub Pages address. GitHub then redirects `www` to the bare domain.
- The `docs/CNAME` file tells GitHub which site to serve when a request for `pawansinha.com.au` arrives.

Check the records from a terminal:
```bash
dig +short pawansinha.com.au          # should list the four 185.199.x.153 addresses
dig +short www.pawansinha.com.au      # should show pawansinha0612.github.io
```
Or check worldwide at https://dnschecker.org/#A/pawansinha.com.au.

### HTTPS
In GitHub, go to **Settings → Pages** and tick **Enforce HTTPS** once the certificate is issued. If the box stays greyed out
for more than an hour, remove the custom domain, Save, add `pawansinha.com.au` again, and Save. That restarts the certificate request.

### Troubleshooting
| Symptom | Cause | Fix |
|---|---|---|
| Hostinger parking page | Old DNS answer still cached (TTL up to 4 h) | Wait, switch Wi-Fi/mobile data, or flush DNS: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` |
| "Connection not private" | HTTPS certificate not issued yet | Wait, or re-add the custom domain (see above) |
| Works on phone, not on work laptop | The company VPN/DNS caches longer | Disconnect the VPN or wait |
| 404 from GitHub | `docs/CNAME` missing, or Pages not set to `main` + `/docs` | Check Settings → Pages |

---

## Updating the website

1. Edit files in `docs/`. To preview, open `docs/index.html` in a browser.
2. Commit and push to `main`. GitHub Pages republishes in about a minute.

Things to change in `docs/index.html` (see the comment at the top of `<body>`):

| What | Where |
|---|---|
| Availability badge | `data-available-from="YYYY-MM-DD"` on `#availability` (empty = "Available now") |
| Booking button | `data-booking-url` on `<body>`: paste a Calendly link. Empty = pre-filled email |
| Upwork link | Replace `[YOUR_UPWORK_PROFILE_URL]` |
| ABN in footer | Replace `[XX XXX XXX XXX]` |
| Testimonials | Fill in the cards in `#testimonials`. Only use quotes the person has approved |

Anything still holding a `[placeholder]` is hidden automatically, so unfinished items never appear on the live site.

**Animations** are in `main.js` and the "Motion" sections of `styles.css`: word reveals, smooth scrolling
([Lenis](https://github.com/darkroomengineering/lenis)), marquees, scroll-filled statement, pinned process steps, cursor effects.
They switch off for visitors who have reduced motion enabled in their device settings.

---

## Availability notifier

Emails your contacts, one at a time and personalised, when your current contract is about to end.

One-time setup:
```bash
cd notifier
cp config.example.json config.json      # contract end date, links, skills
cp contacts.example.csv contacts.csv    # people to tell
cp .env.example .env                    # Gmail address + App Password
```
`config.json`, `contacts.csv`, `.env` and `sent_log.json` are git-ignored. Your contacts and passwords never leave your machine.

```bash
python3 notify.py status                 # days left, who has been emailed
python3 notify.py preview                # see the email exactly as it will be sent
python3 notify.py send --dry-run         # list recipients, send nothing
python3 notify.py send --tag recruiter   # one group only
python3 notify.py send                   # everyone not yet emailed (asks to confirm)
```

- `contacts.csv` columns: `name, first_name, email, tags (separated by ;), personal_note, opt_out`.
- Nobody gets the same email twice for a contract. When you change `contract_end_date`, a new campaign starts.

Daily reminder (a macOS notification when the notice window opens, or automatic sending if `"auto_send": true`):
```bash
crontab -e
0 9 * * * /usr/bin/env python3 /Users/sinhap/portfolio/notifier/notify.py check >> /tmp/notify.log 2>&1
```
