# pawansinha.com.au

Portfolio website and tooling for **Pawan Sinha, QA & Test Automation Engineer** (Melbourne, ABN registered).

**Live site:** https://pawansinha.com.au

```
docs/        The website: plain HTML, CSS and JavaScript, no build step
  index.html   Page content
  styles.css   Design, layout and animation styles
  main.js      Animations, scroll effects, booking button, placeholder hiding
  CNAME        Tells GitHub Pages to serve the site at pawansinha.com.au
  tools/       Calculators, curl → k6 and JMeter → k6 converters, k6 results explainer, SLO and capacity
               calculators (all run in the browser)
  interview-prep/  Interview questions (qa.js), AI practice page, Interview Guide page
  peak-readiness/  Peak-readiness offer, checklist and quiz (quiz/questions.json)
  course/k6/   "k6 in 7 days" email course sign-up (lessons are in enquiry/Code.gs)
blog/        Daily blog: posts (Markdown), topic queue, AI drafting, page builder, LinkedIn sharing
.github/     GitHub Actions: weekly blog drafts, daily blog publish
enquiry/     Google Apps Script backend for the site's enquiry form (saves to a Google Sheet, emails a notification)
health/      Weekly site health check (tokens, pages, blog queue), run by .github/workflows/site-health.yml
jobs/        Daily public jobs page (docs/jobs/), run by .github/workflows/jobs-page.yml; word lists in jobs/config.json.
             The page's job-alert signup is handled by enquiry/Code.gs (form=jobs, sendJobAlerts)
services/    Generator for the /services/ pages
profile/     Git-ignored, never published.
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

### Business email (`hello@pawansinha.com.au`)

Email to any address at `@pawansinha.com.au` is forwarded to your Gmail by **ImprovMX** (free plan, log in at
https://app.improvmx.com with your Gmail). It's receive-only: replies you send come from your Gmail address.
LinkedIn's developer forms accept it as a business email.

| Type | Name | Value | Priority |
|---|---|---|---|
| MX | `@` | `mx1.improvmx.com` | 10 |
| MX | `@` | `mx2.improvmx.com` | 20 |
| TXT | `@` | `v=spf1 include:spf.improvmx.com ~all` | |

These sit in Hostinger DNS next to the website records. Don't delete them, or mail to the domain stops arriving.
- **Check:** `dig +short MX pawansinha.com.au` should list both ImprovMX servers.
- **Mail not arriving:** check Gmail's Spam folder, then the ImprovMX dashboard for a red warning (it re-checks the records).
- **Send as hello@ from Gmail (optional):** this needs an SMTP server. ImprovMX only offers that on its paid plan, so use a
  free SMTP provider, or keep replying from Gmail.

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

**Menu and footer.** Every public page has the same top menu (Services, Work, Resources, Blog, Hire me) and the same
footer. They are copied into `docs/index.html`, `docs/tools/index.html`, `docs/interview-prep/performance-testing/index.html`,
`docs/projects/deal-finder/index.html`, the blog template in `blog/build.py` and the service-page template in
`services/build.py`. To add or rename a menu item, change it in all six. Keep the top menu to five items; new pages go in the footer columns or the home page's Resources section.
On phones the menu folds into the ☰ button (`docs/menu.js`). Long pages put their own jump links in the row of pills
under the menu (`<nav class="subnav">`), not in the top menu.

**Service pages.** Each service card on the home page opens `/services/<name>/`: what I do, the experience behind it,
how we'd work, FAQs, and three ways to get in touch (free call, project brief, interview invite). The pages are built from
the data in `services/build.py`: edit it, run `python3 services/build.py`, commit `docs/services/`. Only put real work
there; add new projects to a service's `highlights` as you finish them.

**Animations** are in `main.js` and the "Motion" sections of `styles.css`: word reveals, smooth scrolling
([Lenis](https://github.com/darkroomengineering/lenis)), marquees, scroll-filled statement, pinned process steps, cursor effects.
They switch off for visitors who have reduced motion enabled in their device settings.

---

## Blog

Daily posts on advanced performance engineering at https://pawansinha.com.au/blog/, each shared to LinkedIn.
Posts live in `blog/posts/YYYY-MM-DD-slug.md` and are published to `docs/blog/` by `blog/build.py`.
A post goes live on its `date` (Melbourne time), so approved posts come out one a day.

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

The owner's operating guide (weekly routine, renewals, what to do when something breaks) is kept privately.
