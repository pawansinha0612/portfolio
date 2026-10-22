# Pawan Sinha — Contractor Portfolio & Availability Notifier

```
docs/        Portfolio website (plain HTML/CSS), hosted free on GitHub Pages
profile/     Ready-to-paste Upwork profile (title, overview, skills, portfolio items)
notifier/    Script that emails your network when your contract is about to end
```

## 1. Publish the website (free)

1. Only two placeholders are left in `docs/index.html`: your Upwork URL and your ABN. Until you fill them in, they're hidden from the page. To preview the site, open the file in a browser.
2. Create a **public** GitHub repo called `portfolio`, then push this folder to it:
   ```bash
   git add . && git commit -m "Initial portfolio"
   git remote add origin https://github.com/pawansinha0612/portfolio.git
   git push -u origin main
   ```
3. On GitHub, go to **Settings → Pages → Build from branch → `main` / `/docs`**.
   The site is served at **https://pawansinha.com.au** (custom domain set by `docs/CNAME`).
4. Domain `pawansinha.com.au` (registered with Hostinger). DNS records at Hostinger:
   `A @ 185.199.108.153`, `.109.153`, `.110.153`, `.111.153` and `CNAME www pawansinha0612.github.io`.

To show your availability, set `data-available-from="YYYY-MM-DD"` on the badge in `index.html`.
Leave it empty to show "Available now".

## 2. Availability notifier

One-time setup:
```bash
cd notifier
cp config.example.json config.json      # your contract end date, links, skills
cp contacts.example.csv contacts.csv    # the people to tell (kept out of git)
cp .env.example .env                    # Gmail address + App Password (kept out of git)
```

Everyday use:
```bash
python3 notify.py status              # days left, who has been emailed
python3 notify.py preview             # see the email exactly as it will be sent
python3 notify.py send --dry-run      # list recipients, send nothing
python3 notify.py send --tag recruiter  # recruiters first, for example
python3 notify.py send                # everyone not yet emailed (asks to confirm)
```

- `contacts.csv` columns: `name, first_name, email, tags (separated by ;), personal_note, opt_out`.
  A short `personal_note` makes each email feel personal. Set `opt_out` to `yes` when someone asks to stop.
- Emails go one at a time, never as a mass CC. Nobody gets the same email twice for a contract.
  When you sign a new contract, change `contract_end_date` and the next campaign starts fresh.

### Get a reminder automatically
Run `check` once a day. When the notice window opens (`notify_days_before`) you get a macOS notification.
If you set `"auto_send": true`, it sends the emails for you instead.
```bash
crontab -e
# add this line (runs at 9am daily):
0 9 * * * /usr/bin/env python3 /Users/sinhap/portfolio/notifier/notify.py check >> /tmp/notify.log 2>&1
```

## 3. Profile roadmap

**Week 1: foundations**
- Business email (Gmail, or Zoho Mail with your domain), a 1-page CV (PDF), and a professional headshot.
- LinkedIn: headline like "Performance & QA Automation Engineer | k6 · JMeter · Playwright · API | Contractor".
  Turn on *Open to work* (recruiters only) and add a *Services* section.
- Publish this site.

**Week 2: Upwork**
- Title: specific, not generic. For example, "Flutter Developer | Mobile Apps, Analytics & Test Automation".
- Overview: open with the client's problem and the result you deliver. Put your stack in line 3, not line 1.
- Portfolio: 3–5 items with the same Problem → What I did → Result format as the website.
  Use screenshots or diagrams, and anonymise clients if needed.
- Take 1–2 skill tests, set a reasonable starting rate, and apply to small, well-scoped jobs first.
  Early 5-star reviews matter more than early rates.
- Ask past colleagues for testimonials. Upwork lets you request client testimonials from outside the platform.

**Ongoing**
- Register with 3–5 Australian IT contract agencies (for example Hays, Talent, Robert Walters, Paxus, Hudson).
- Post on LinkedIn once or twice a week about things you've built or learned.
- Keep `contacts.csv` growing: every recruiter, manager and colleague you meet.

**ABN / admin checklist** (check details with an accountant)
- Register for GST once you expect A$75k+ turnover a year. Many contractors register from the start.
- Set up invoicing (Xero, MYOB, or a free template), a separate business bank account, and set aside money for tax and super.
- Agencies often require **Professional Indemnity** and **Public Liability** insurance.
