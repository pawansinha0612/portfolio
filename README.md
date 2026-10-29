# pawansinha.com.au

Portfolio website and tooling for **Pawan Sinha, QA & Test Automation Engineer** (Melbourne, ABN registered).

**Live site:** https://pawansinha.com.au

```
docs/        The website: plain HTML, CSS and JavaScript, no build step
  index.html   Page content
  styles.css   Design, layout and animation styles
  main.js      Animations, scroll effects, booking button, placeholder hiding
  CNAME        Tells GitHub Pages to serve the site at pawansinha.com.au
blog/        Daily blog: posts (Markdown), topic queue, AI drafting, page builder, LinkedIn sharing
.github/     GitHub Actions: weekly blog drafts, daily blog publish
enquiry/     Google Apps Script backend for the site's enquiry form (saves to a Google Sheet, emails a notification)
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
| Booking button | `data-booking-url` on `<body>` (currently Calendly). Empty = buttons go to the enquiry form |
| Upwork link / ABN | Search for `upwork.com` / `ABN` in `index.html` |
| Testimonials | Loaded from the enquiries Google Sheet (rows marked approved). Nothing to edit in the HTML |

Anything still holding a `[placeholder]` is hidden automatically, so unfinished items never appear on the live site.

**Animations** are in `main.js` and the "Motion" sections of `styles.css`: word reveals, smooth scrolling
([Lenis](https://github.com/darkroomengineering/lenis)), marquees, scroll-filled statement, pinned process steps, cursor effects.
They switch off for visitors who have reduced motion enabled in their device settings.

---

## Blog

Posts live in `blog/posts/YYYY-MM-DD-slug.md` and are published to `docs/blog/` by `blog/build.py`.
A post goes live on its `date` (Melbourne time), so approved posts come out one a day.

| When | What runs | What it does |
|---|---|---|
| Sunday ~9am | `.github/workflows/blog-drafts.yml` | Drafts the next 7 topics from `blog/topics.md` with a free NVIDIA-hosted model (secret `AI_API_KEY` from build.nvidia.com; GitHub Models was retired 30 Jul 2026) in the style of `blog/voice.md`, and opens a pull request |
| You | Review the pull request | Edit, delete or re-date drafts, then merge to approve |
| Daily ~8am | `.github/workflows/blog-publish.yml` | Builds the blog, commits `docs/blog/`, then shares the newest post on LinkedIn |

- **Add topics:** add `- [ ] Title — angle` lines to `blog/topics.md`.
- **Write a post yourself:** add a Markdown file in `blog/posts/` (see the format at the top of `blog/build.py`) and push.
- **Preview locally:** `pip install markdown && python3 blog/build.py --include-future`, open `docs/blog/index.html`, then `git checkout docs/` before committing.
- **Run now:** GitHub → Actions → choose the workflow → Run workflow.
- **Switch AI provider:** set repository variables `AI_BASE_URL`, `AI_MODEL` and secret `AI_API_KEY` (any OpenAI-compatible API, e.g. NVIDIA).
- **LinkedIn:** every ~60 days run Actions → **LinkedIn token** (`.github/workflows/linkedin-token.yml`): once for the sign-in link, once with the code from `/linkedin-callback/`. It saves the token itself; the publish job opens an issue a week before expiry.

## Availability notifier

Emails your contacts, one at a time and personalised, when your current contract is about to end.

### Option A (recommended): Google Sheet, no password anywhere

`notifier/google-sheets/Code.gs` runs inside a Google Sheet and sends from your own Gmail via Google's sign-in consent. You never create or store a password.

One-time setup:
1. Create a new Google Sheet (e.g. "Availability notifier").
2. **Extensions → Apps Script**, delete the sample code, paste `notifier/google-sheets/Code.gs`, save.
3. Reload the sheet. An **Availability** menu appears. Run **Set up tabs** and click through Google's "Allow" screen. If you see "Google hasn't verified this app", click **Advanced → Go to … (unsafe)**. It is your own script.
4. Fill the **Contacts** tab (`name, first_name, email, tags (separated by ;), personal_note, opt_out`). You can type them in, or let the script find them:
   - **Availability → Import job contacts from Gmail** searches the last 3 years of mail for recruiting and testing keywords. It skips newsletters, job alerts, no-reply senders and job boards, plus anyone already in Contacts, and lists the people it finds in a **Found** tab. People you replied to are ticked already.
   - Review the list and tick `keep` for the people you want, then run **Move ticked Found rows to Contacts**.
   - **Availability → Import from Google Contacts** reads your saved contacts, including names, emails, phone numbers, companies and job titles. First turn on the People API: Apps Script → **Services (+)** → **People API** → **Add**. Job-related contacts that have an email are ticked automatically. Contacts with only a phone number are listed for reference and can't be emailed until you add an address.
   - To change the search, add a `gmail_search` row to Profile with any Gmail search query.

Each new contract:
1. Edit the **Profile** tab with your new `contract_end_date`, `available_from`, headline, skills and wording. A new end date starts a fresh campaign, so everyone can be emailed again.
2. Tick the people you want in **Found**. Then run **Availability → 1. Send test email to me**. This copies the ticked rows into Contacts, then sends one sample to `test_email` (or to your Google account if that's blank).
3. **Availability → 2. Send to everyone** (or **2b** for one tag, e.g. `recruiter`).

"Send to everyone" stays locked until you've test-sent the *current* Profile, so if you edit anything you have to send yourself a new test first. Every send is logged in the **Sent** tab, so nobody gets the same email twice. A personal Gmail account can send about 100 emails a day from a script. If you have more contacts, run the same menu item the next day and it continues where it stopped.

Contacts are never removed by sending. To send a follow-up for the same contract, delete the relevant rows in **Sent** and run step 3 again.

### Option B: local Python script (needs a Gmail App Password)

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
0 9 * * * /usr/bin/env python3 "$HOME/portfolio/notifier/notify.py" check >> /tmp/notify.log 2>&1
```
