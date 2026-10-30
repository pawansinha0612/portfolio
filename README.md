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

Daily posts on advanced performance engineering at https://pawansinha.com.au/blog/, each shared to LinkedIn.
Posts live in `blog/posts/YYYY-MM-DD-slug.md` and are published to `docs/blog/` by `blog/build.py`.
A post goes live on its `date` (Melbourne time), so approved posts come out one a day.

### Your weekly routine (about 10 minutes of your time)

| When | Who | What happens |
|---|---|---|
| **Saturday night** (22:00 UTC, Sunday ~9am Melbourne) | Automatic | `blog-drafts.yml` drafts the next 7 topics from `blog/topics.md` with a free NVIDIA-hosted model and opens a pull request **"Blog drafts for review"** |
| **Sunday** | You → Claude | Ask Claude: *"Fact-check and fix the new blog drafts PR."* Claude rewrites what the model got wrong, adds an interactive widget to each post, applies the style rules below and pushes to the PR |
| **Sunday / Monday** | You | Read the posts (PR → **Files changed**), then **Merge pull request** |
| **Every day ~8am Melbourne** | Automatic | `blog-publish.yml` publishes that day's post on the website (blog list, RSS, sitemap) and shares it on your personal LinkedIn |
| **First hour after each post** | You | Reply to comments on LinkedIn (see *Growing impressions*) |

**Merge or close the drafts PR before the next Saturday.** The drafting job skips a week while a drafts PR is still open.

### Checklist before you merge a drafts PR

- [ ] Every post was fact-checked (the free model invents facts and tool options)
- [ ] Each post opens with a short problem scenario, not a definition, and has a catchy title
- [ ] No invented personal stories ("on my last project…"). Scenarios are written as *you*, clearly hypothetical
- [ ] No semicolons in the text
- [ ] Each post has an interactive widget, and the dates run one per day with no gaps

### Style rules (also in `blog/voice.md`, which the model follows)

- Senior-level depth: CDN, caching, concurrency, bottlenecks, I/O, databases, threads, GC, tool choice, load balancers, cloud, autoscaling, observability, greenfield.
- Problem-first opening, catchy problem-led title under 70 characters, then mechanism, maths with a worked example, how to detect it, trade-offs.
- Australian spelling, short sentences, no semicolons, no hype words.

### Interactive widgets

`docs/widgets.js` turns `<div class="widget" data-widget="NAME"><p><em>fallback text</em></p></div>` in a post into a
calculator or simulator. `build.py` adds the script only to posts that contain one. RSS readers see the fallback text.
Existing widgets: `bottleneck`, `cdn`, `omission`, `threads`, `lb`, `capacity`, `cache`. New ones are added to `widgets.js`.

### Share images

Each post gets its own 1200×630 share image (title, tags, your name and domain) from `blog/og.py`, written to
`docs/blog/<slug>/og.png` when the blog is built. Google, chat apps and LinkedIn link previews show it, and the
LinkedIn post uploads it as its picture. Fonts are in `blog/fonts` (open-source licences included).
Preview one: `python3 blog/og.py blog/posts/<file>.md preview.png`. The coloured word is the last meaningful word of the title,
or set it in the post's front matter, e.g. `highlight: bottleneck`.

### Recurring jobs for you

| How often | What | How |
|---|---|---|
| Weekly | Merge the drafts PR | See above |
| When `blog/topics.md` runs low (the PR warns under 7 left) | Add topics | Add `- [ ] Title — angle` lines under **Queue**. Lines under **Parked** are skipped |
| Every ~60 days (next: late Dec 2026) | Renew the LinkedIn token (and the company page token, once connected) | GitHub opens an issue **"Renew the LinkedIn token…"**. Run Actions → **LinkedIn token** with the code empty, open the sign-in link, then run it again with the code from `/linkedin-callback/` |
| When GitHub emails about it | Renew `SECRETS_ADMIN_TOKEN` | Fine-grained token for this repo with Secrets and Variables read/write |
| If drafting fails | Check the NVIDIA key and models | Actions → Blog drafts → the run's warnings. Free models change. Set variable `AI_MODEL` to a working model ID |

### Company page on LinkedIn (optional, needs LinkedIn approval)

Posts go to your personal profile automatically. They also go to the **Pawan Sinha Consulting** page once that is
connected. Until then the page step is skipped, and a page problem never blocks the profile post.

1. https://www.linkedin.com/developers/apps → **Create app**, for example "Pawan Sinha Page Publisher". Link the
   Pawan Sinha Consulting page, upload the logo, then **Verify** the app from the page (Settings tab).
   It must be a separate app: LinkedIn only grants the page permission to an app that has no other products.
2. **Products** tab → **Community Management API** → **Request access**. Fill in the form: business name and ABN,
   website, and the use case "publish my own company page's blog posts automatically, one admin, my own page only".
   LinkedIn reviews it by hand. It can take days or weeks and may be declined.
3. Once approved: **Auth** tab → add the redirect URL `https://pawansinha.com.au/linkedin-callback/`.
4. GitHub → Settings → Secrets and variables → Actions:
   - Variable `LINKEDIN_PAGE_CLIENT_ID` and secret `LINKEDIN_PAGE_CLIENT_SECRET` from that app's Auth tab.
   - Variable `LINKEDIN_PAGE_URN` = `urn:li:organization:` followed by the page's number, which is in the page's
     admin address (`linkedin.com/company/NUMBER/admin/`).
5. Actions → **LinkedIn token** → Run workflow with account **page** and the code empty → open the sign-in link →
   approve → run it again with account **page** and the code. The page token lasts about 60 days. GitHub opens a
   "Renew the LinkedIn company page token" issue when it needs renewing.

Until then, reshare each post to the page by hand: on the post, **Repost** and switch to posting as the page.

### Growing impressions

On LinkedIn:
- **Reply to every comment in the first hour.** Early engagement decides how far LinkedIn pushes a post.
- **Reshare as your company page** ("Pawan Sinha Consulting") and add a one-line comment of your own.
- **Comment on other performance engineers' posts** during the week. Thoughtful comments put your name in front of their audience.
- **Turn the best post each week into a carousel** (a PDF document post), which usually gets more reach than a link post.
- **Mention the interactive calculator** in the post: "try your own numbers" gives people a reason to click.

Beyond LinkedIn:
- **Republish on dev.to and Medium** a few days later with the canonical URL set to your site, so Google credits your site.
- **Share the strongest deep dives** (for example coordinated omission, load balancer algorithms) in relevant communities such as r/sre, r/devops or Hacker News, without a sales pitch.
- **Google Search Console:** check *Performance* monthly to see which posts get search traffic, and write more on those topics.
- **Link posts to each other** where topics overlap. It keeps readers on the site longer and helps search ranking.

### Other tasks

- **Write a post yourself:** add a Markdown file in `blog/posts/` (format at the top of `blog/build.py`) and push.
- **Preview locally:** `pip install markdown pillow && python3 blog/build.py --include-future`, open `docs/blog/index.html`, then `git checkout docs/` before committing (otherwise future posts go live early).
- **Run a job now:** GitHub → Actions → choose the workflow → Run workflow.
- **Switch AI provider:** set repository variables `AI_BASE_URL`, `AI_MODEL` and secret `AI_API_KEY` (any OpenAI-compatible API).

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
