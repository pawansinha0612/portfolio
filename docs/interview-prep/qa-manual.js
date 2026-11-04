// Manual & functional testing interview questions and model answers, used by /interview-prep/manual-testing/ and /interview-prep/practice/.
// Each item: q = question, t = topics (used by the filters), a = model answer (HTML).
(window.QA_TRACKS = window.QA_TRACKS || {}).manual = {
  basic: [
    { q: 'What is the difference between the SDLC and the STLC?', t: ['Fundamentals'], a: `
      <p>The <strong>SDLC</strong> (software development life cycle) is the whole journey of building software: requirements, design, build, test, release and maintenance. The <strong>STLC</strong> (software testing life cycle) is the testing work that runs inside it.</p>
      <p>A typical STLC looks like this:</p>
      <ol>
        <li><strong>Requirement analysis:</strong> read the requirements and ask what is testable, unclear or missing.</li>
        <li><strong>Test planning:</strong> scope, approach, environments, risks, effort and exit criteria.</li>
        <li><strong>Test design:</strong> write test conditions, cases and data.</li>
        <li><strong>Environment set-up:</strong> get the build, data and access ready.</li>
        <li><strong>Execution:</strong> run the tests, log defects and retest fixes.</li>
        <li><strong>Closure:</strong> report results, open risks and lessons learnt.</li>
      </ol>
      <p>In Agile these steps don't disappear. They shrink and repeat inside every sprint, and testing starts at the requirements stage, not after the build.</p>
      <p class="say">The SDLC is how we build the product; the STLC is how we test it. The key point is that testing starts when requirements are written, not when code is finished.</p>` },
    { q: 'What is the difference between verification and validation?', t: ['Fundamentals'], a: `
      <p><strong>Verification</strong> asks "are we building the product right?" It checks the work against the specification. Reviews, walkthroughs, inspections and static analysis are verification. You can verify a requirements document before any code exists.</p>
      <p><strong>Validation</strong> asks "are we building the right product?" It checks that the product meets the real user's needs. Running the software, demos and user acceptance testing are validation.</p>
      <p>You need both. A product can match its spec perfectly and still be useless if the spec was wrong. A product can delight users in a demo and still break a regulatory rule written in the spec.</p>
      <p class="say">Verification is "did we build it to spec?" Validation is "is the spec what the user actually needed?" I like to do some of both early, like reviewing the acceptance criteria with the product owner before the build starts.</p>` },
    { q: 'What are the levels of testing, and what types of testing do you know?', t: ['Fundamentals'], a: `
      <p><strong>Levels</strong> describe <em>what</em> you test, from small to large:</p>
      <ul>
        <li><strong>Unit (component):</strong> one function or class, usually written by developers.</li>
        <li><strong>Integration:</strong> how components or services work together, such as an API calling a database or a third party.</li>
        <li><strong>System:</strong> the whole product end to end against its requirements.</li>
        <li><strong>Acceptance:</strong> does it meet the business need? UAT is the common form.</li>
      </ul>
      <p><strong>Types</strong> describe <em>why</em> you test, and can happen at any level:</p>
      <ul>
        <li><strong>Functional:</strong> does it do the right thing?</li>
        <li><strong>Non-functional:</strong> performance, security, usability, accessibility, compatibility.</li>
        <li><strong>Change-related:</strong> retesting (confirming a fix) and regression testing (checking nothing else broke).</li>
      </ul>
      <p class="say">Levels are about scope, types are about purpose. So I might do functional and accessibility testing at system level, and regression at every level.</p>` },
    { q: 'What is the difference between smoke testing and sanity testing?', t: ['Fundamentals', 'Regression'], a: `
      <p><strong>Smoke testing</strong> is a broad, shallow check on a new build. Does it deploy, does it start, can you log in, do the main pages load? If smoke fails, the build is rejected and nobody wastes time testing it further.</p>
      <p><strong>Sanity testing</strong> is a narrow, focused check after a small change or a bug fix. It confirms that one area now works and looks reasonable, before you decide whether deeper testing is needed.</p>
      <ul>
        <li>Smoke: wide and shallow, on every new build, often automated.</li>
        <li>Sanity: narrow and a bit deeper, on a specific change, often manual.</li>
      </ul>
      <p>Teams use these words loosely, so in an interview I describe what I'd actually check rather than argue about the labels.</p>
      <p class="say">Smoke asks "is this build stable enough to test at all?" Sanity asks "does this one fix or change make sense?" Both are quick gates, not a replacement for regression.</p>` },
    { q: 'Explain equivalence partitioning and boundary value analysis with an example.', t: ['Test design'], a: `
      <p><strong>Equivalence partitioning</strong> splits inputs into groups the system should treat the same way. You test one value from each group, because if one value in a group works, the others should too.</p>
      <p><strong>Boundary value analysis</strong> tests the edges of those groups, because that's where off-by-one bugs live (a <code>&lt;</code> written where <code>&lt;=</code> was meant).</p>
      <p>Example: an age field accepts 18 to 65.</p>
      <pre>Partitions:  below 18 (invalid) | 18–65 (valid) | above 65 (invalid)
EP values:   10, 40, 70
Boundaries:  17, 18, 65, 66   (two-value)
             or 17, 18, 19, 64, 65, 66   (three-value)</pre>
      <p>Don't forget the partitions people miss: empty, non-numeric, decimals like 18.5, negative numbers, leading spaces and very long input.</p>
      <p class="say">Partitioning cuts the number of tests; boundaries put them where the bugs are. For an 18 to 65 age field I'd test 17, 18, 65 and 66, plus one middle value and the invalid formats.</p>` },
    { q: 'What makes a good test case?', t: ['Test design'], a: `
      <p>A good test case can be run by someone else and give the same result. It has:</p>
      <ul>
        <li>A clear <strong>title</strong> that says what is being checked.</li>
        <li><strong>Preconditions:</strong> user role, data and state needed before you start.</li>
        <li><strong>Steps</strong> that are short and specific.</li>
        <li><strong>Test data</strong>, written down, not "use any account".</li>
        <li>An <strong>expected result</strong> that is checkable, not "it works".</li>
        <li>A <strong>link</strong> to the requirement or story it covers.</li>
      </ul>
      <p>It also tests one idea. If a case checks five things, a failure tells you little. Keep cases independent, so one failure doesn't block the rest.</p>
      <p>Match the detail to the context. A regulated project may need full step-by-step scripts. An Agile team may be better served by a checklist of test conditions plus exploratory sessions. Too much detail costs time to write and maintain.</p>
      <p class="say">My test for a test case: could a new team member run it tomorrow without asking me a question, and would they know for sure whether it passed?</p>` },
    { q: 'What goes into a good bug report?', t: ['Defects'], a: `
      <ul>
        <li><strong>Title:</strong> short and specific. "Checkout total ignores discount code when cart has 2+ items", not "checkout broken".</li>
        <li><strong>Environment:</strong> build or version, environment, browser or device, user role.</li>
        <li><strong>Steps to reproduce:</strong> numbered, minimal, with the exact test data.</li>
        <li><strong>Expected result</strong> and <strong>actual result</strong>, side by side.</li>
        <li><strong>Evidence:</strong> screenshot, screen recording, console errors, request and response, log extract.</li>
        <li><strong>Severity</strong> and suggested <strong>priority</strong>.</li>
        <li><strong>Reproducibility:</strong> always, or 3 out of 10 tries.</li>
        <li><strong>Link</strong> to the story or requirement.</li>
      </ul>
      <p>Before logging it, try to narrow it down. Does it happen on another browser, another user, another data set? One bug per report, and check for duplicates first.</p>
      <p>Keep the tone neutral. Describe the behaviour, not the developer.</p>
      <p class="say">A good bug report lets a developer reproduce the issue in a couple of minutes without messaging me. If they have to ask, the report wasn't finished.</p>` },
    { q: 'What is the difference between severity and priority? Give examples.', t: ['Defects'], a: `
      <p><strong>Severity</strong> is the impact of the bug on the system or the user. The tester usually sets it. <strong>Priority</strong> is how soon it should be fixed. The product owner or business usually decides it, based on severity plus business context.</p>
      <ul>
        <li><strong>High severity, high priority:</strong> users can't complete payment.</li>
        <li><strong>High severity, low priority:</strong> the app crashes on a rarely used admin report that nobody needs until year end.</li>
        <li><strong>Low severity, high priority:</strong> the company name or logo is wrong on the home page, just before a launch.</li>
        <li><strong>Low severity, low priority:</strong> a typo in a help page few people read.</li>
      </ul>
      <p>They're separate because they answer different questions. Severity is fairly objective. Priority changes with deadlines, customers and release plans.</p>
      <p class="say">Severity is how bad it is; priority is how soon we fix it. A spelling mistake in the brand name is low severity but can be top priority on launch day.</p>` },
    { q: 'How would you test a login page?', t: ['Scenarios', 'Test design'], a: `
      <p>I'd start by asking for the rules: password policy, lockout rules, "remember me", SSO or MFA, and what error messages should say.</p>
      <ul>
        <li><strong>Functional:</strong> valid login, wrong password, unknown user, empty fields, case sensitivity of username and password, leading and trailing spaces.</li>
        <li><strong>Lockout and limits:</strong> what happens after N failed attempts, and does it unlock as specified?</li>
        <li><strong>Security basics:</strong> error messages don't reveal whether the username exists, the password is masked, the page uses HTTPS, the back button after logout doesn't show a logged-in page, the session expires.</li>
        <li><strong>Related flows:</strong> forgot password, reset link expiry, MFA, remember me, logging in on two devices.</li>
        <li><strong>Usability and accessibility:</strong> keyboard-only login, Tab order, labels read by a screen reader, errors announced, password managers and paste work.</li>
        <li><strong>Compatibility:</strong> main browsers and mobile.</li>
      </ul>
      <p>Then I'd prioritise. Valid login, lockout and the security checks first, cosmetic checks last.</p>
      <p class="say">I'd cover the happy path, the negative cases, lockout, security basics like not revealing whether a username exists, and accessibility. Then I'd ask what's riskiest for this product and start there.</p>` },
    { q: 'What is UAT, and how is it different from system testing?', t: ['UAT', 'Fundamentals'], a: `
      <p><strong>User acceptance testing (UAT)</strong> is where business users or their representatives confirm the product supports their real work, so they can accept it for release.</p>
      <ul>
        <li><strong>Who:</strong> system testing is done by the test team; UAT is done by business users, with testers supporting.</li>
        <li><strong>Based on:</strong> system testing checks requirements and specs; UAT checks real business processes and scenarios.</li>
        <li><strong>Goal:</strong> system testing aims to find defects; UAT aims to build confidence and get a sign-off decision.</li>
        <li><strong>When:</strong> UAT comes after system testing, in an environment as close to production as possible.</li>
      </ul>
      <p>UAT is not the place to find basic functional bugs. If it is, system testing wasn't done well enough.</p>
      <p class="say">System testing asks "does it meet the requirements?" UAT asks "can the business actually run on this?" Ideally UAT finds very few defects and ends with a clear sign-off.</p>` },
  ],
  intermediate: [
    { q: 'What is decision table testing, and when would you use it?', t: ['Test design'], a: `
      <p>A decision table lists combinations of conditions and the action the system should take for each. It suits business rules with several conditions that interact, where it's easy to miss a combination.</p>
      <p>Example: free shipping applies if the customer is a member <em>or</em> the order is over $100, but never for oversized items.</p>
      <pre>Rule           1   2   3   4   5   6   7   8
Member         Y   Y   Y   Y   N   N   N   N
Order &gt; $100   Y   Y   N   N   Y   Y   N   N
Oversized      Y   N   Y   N   Y   N   Y   N
Free shipping  N   Y   N   Y   N   Y   N   N</pre>
      <p>Three yes/no conditions give 2 × 2 × 2 = 8 rules. Each rule becomes a test case. You can collapse rules where a condition doesn't matter (oversized always means no), but only once the full table is agreed.</p>
      <p>The biggest value often comes before testing. Filling in the table shows gaps in the requirement, and you take those questions to the product owner.</p>
      <p class="say">I use decision tables whenever a rule has "and", "or" and "unless" in it. Writing the table usually finds a combination nobody specified.</p>` },
    { q: 'Explain state transition testing with an example.', t: ['Test design'], a: `
      <p>State transition testing models a system as states, the events that move it between states, and the result of each move. It suits anything with a lifecycle: orders, accounts, bookings, workflows.</p>
      <p>Example: an online order.</p>
      <pre>Created --pay--&gt; Paid --ship--&gt; Shipped --deliver--&gt; Delivered
Created --cancel--&gt; Cancelled
Paid    --cancel--&gt; Refunded</pre>
      <p>From the model you design tests for:</p>
      <ul>
        <li><strong>Valid transitions:</strong> every arrow at least once.</li>
        <li><strong>Invalid transitions:</strong> events that should be blocked, such as cancelling a delivered order or shipping an unpaid one.</li>
        <li><strong>Sequences:</strong> realistic paths through several states.</li>
      </ul>
      <p>The invalid transitions find the most bugs. Try them through the UI, and through the API or a second browser tab, where the UI's own guards don't protect you.</p>
      <p class="say">I draw the states and arrows first, cover every valid arrow, then spend real effort on the moves that should be impossible, like cancelling something that has already shipped.</p>` },
    { q: 'Walk me through the defect lifecycle.', t: ['Defects'], a: `
      <p>Names vary by tool and team, but a common flow is:</p>
      <ol>
        <li><strong>New:</strong> the tester logs it.</li>
        <li><strong>Triaged / Assigned:</strong> severity and priority agreed, and an owner set.</li>
        <li><strong>In progress:</strong> the developer works on it.</li>
        <li><strong>Fixed / Ready for test:</strong> the fix is in a build the tester can use.</li>
        <li><strong>Retest:</strong> the tester confirms the fix, and runs some regression around it.</li>
        <li><strong>Closed</strong> if it passes, or <strong>Reopened</strong> if it doesn't.</li>
      </ol>
      <p>Side exits: <strong>Rejected</strong> (not a bug, works as designed), <strong>Duplicate</strong>, <strong>Cannot reproduce</strong> and <strong>Deferred</strong> (a real bug, fixed in a later release).</p>
      <p>What matters is that every exit has a reason written down. "Deferred" needs someone in the business to accept the risk. "Cannot reproduce" should come back to the tester to try again with more detail, not just close.</p>
      <p class="say">New, assigned, fixed, retested, closed, with reopen as the loop. I care most about the side exits: who accepted a deferral, and why something was rejected.</p>` },
    { q: 'What is exploratory testing, and how do you make it structured?', t: ['Exploratory'], a: `
      <p>Exploratory testing is designing and running tests at the same time, using what you learn from each test to choose the next one. It isn't random clicking. It's skilled, focused investigation.</p>
      <p>I structure it with <strong>session-based test management</strong>:</p>
      <ul>
        <li><strong>A charter:</strong> one line of mission. "Explore the refund flow with partial refunds and multiple payment methods, to find calculation and state errors."</li>
        <li><strong>A time box:</strong> often 60 to 90 minutes, without interruptions.</li>
        <li><strong>Notes</strong> as you go: what you tried, what you saw, questions and bugs.</li>
        <li><strong>A debrief</strong> with the lead or team: what was covered, what wasn't, what's next.</li>
      </ul>
      <p>Useful heuristics: change the data (empty, huge, special characters), interrupt the flow (back button, refresh, timeout), act like different users, and repeat things quickly.</p>
      <p>It works best alongside scripted checks, not instead of them. Scripts confirm what we know. Exploration finds what we didn't think to ask.</p>
      <p class="say">I run exploratory testing as time-boxed sessions with a charter and a debrief, so it's accountable and the team can see what was covered.</p>` },
    { q: 'What does a tester do during a Scrum sprint?', t: ['Agile'], a: `
      <ul>
        <li><strong>Refinement:</strong> ask questions about stories, spot missing rules and edge cases, and help write testable acceptance criteria.</li>
        <li><strong>Sprint planning:</strong> include testing effort in the estimate, and flag stories that need special data, environments or third parties.</li>
        <li><strong>During the sprint:</strong> write test ideas early, test stories as soon as they're ready (not at the end), pair with developers, and keep automated checks up to date.</li>
        <li><strong>Stand-up:</strong> raise blockers such as broken environments or stories arriving late.</li>
        <li><strong>Review:</strong> help demo, and be honest about what wasn't tested.</li>
        <li><strong>Retro:</strong> bring evidence, such as bugs found late and why.</li>
      </ul>
      <p>The tester isn't the gatekeeper at the end. Quality is the team's job, and the tester's role is to make risks visible and help everyone test better.</p>
      <p>The anti-pattern to avoid is a mini-waterfall where all stories land on the last two days.</p>
      <p class="say">In Scrum I try to be involved from refinement, so I'm preventing bugs, not just finding them on day nine of the sprint.</p>` },
    { q: 'How do you write good acceptance criteria, and where does BDD fit in?', t: ['Agile', 'Test design'], a: `
      <p>Good acceptance criteria are specific, testable and about behaviour, not implementation. Each one should have a clear pass or fail.</p>
      <p><strong>BDD</strong> (behaviour-driven development) gets the product owner, developer and tester to agree examples before the build, often called the "three amigos". The examples are written in Given / When / Then form:</p>
      <pre>Scenario: Discount code applied to an eligible cart
  Given a cart with items totalling $120
  When the customer applies the code SAVE10
  Then the total is $108
  And the discount line shows "SAVE10 -$12.00"</pre>
      <p>Tips:</p>
      <ul>
        <li>Use concrete examples with real numbers, not "a valid amount".</li>
        <li>Cover the negative and edge cases: expired code, code used twice, cart under the minimum.</li>
        <li>One behaviour per scenario.</li>
        <li>Avoid UI detail like "click the blue button", so scenarios survive redesigns.</li>
      </ul>
      <p>BDD's main value is the conversation. Tools like Cucumber can automate the scenarios, but scenarios nobody discussed are just test scripts with extra syntax.</p>
      <p class="say">I push for concrete examples in Given/When/Then during refinement. Arguing about an example before the build is much cheaper than arguing about a bug after it.</p>` },
    { q: 'How do you decide what to include in a regression test?', t: ['Regression'], a: `
      <p>You can rarely run everything, so I select by risk:</p>
      <ul>
        <li><strong>Impact of the change:</strong> what code, screens, APIs and data does it touch? Ask the developer, and look at the change itself where you can.</li>
        <li><strong>Business-critical journeys:</strong> sign-up, login, search, checkout, payments. These run every release.</li>
        <li><strong>Areas with a history of bugs</strong> and complex areas that break easily.</li>
        <li><strong>Integration points:</strong> third parties, shared services, reports fed by this data.</li>
        <li><strong>Recently fixed defects:</strong> make sure they stay fixed.</li>
      </ul>
      <p>I keep the regression pack in tiers: a smoke set for every build, a core set for every release, and a full set for major releases or platform changes.</p>
      <p>The stable, repetitive, high-value cases should be automated so manual time goes on the changed and risky areas. And prune the pack. Tests that never fail and cover nothing important cost time for no value.</p>
      <p class="say">I pick regression by what changed, what matters most to the business, and what has broken before. Critical journeys always run; the rest is chosen per release.</p>` },
    { q: 'What SQL do you use as a tester? Give some examples.', t: ['SQL'], a: `
      <p>I use SQL to set up test data, check that the UI or API saved what it should, and find data problems the screen hides.</p>
      <pre>-- Did the order save correctly?
SELECT order_id, status, total_amount
FROM orders
WHERE customer_id = 1042
ORDER BY created_at DESC;

-- Join to check the order lines add up
SELECT o.order_id, o.total_amount, SUM(l.qty * l.unit_price) AS line_total
FROM orders o
JOIN order_lines l ON l.order_id = o.order_id
GROUP BY o.order_id, o.total_amount
HAVING o.total_amount &lt;&gt; SUM(l.qty * l.unit_price);

-- Duplicate emails that should be unique
SELECT email, COUNT(*) FROM customers
GROUP BY email HAVING COUNT(*) &gt; 1;

-- Required fields left empty
SELECT * FROM customers WHERE email IS NULL;</pre>
      <p>Note <code>IS NULL</code>, not <code>= NULL</code>, which never matches. And on shared environments I'm careful with <code>UPDATE</code> and <code>DELETE</code>: always a <code>WHERE</code> clause, and run it as a <code>SELECT</code> first.</p>
      <p class="say">I mostly use SELECTs with joins, GROUP BY and HAVING to prove the database matches what the screen says, and to hunt for duplicates and nulls.</p>` },
    { q: 'How do you approach cross-browser and cross-device testing?', t: ['Scenarios'], a: `
      <p>You can't test every combination, so start with data:</p>
      <ol>
        <li><strong>Build a coverage matrix</strong> from real analytics: which browsers, operating systems, devices and screen sizes your users have. Add anything the contract or business requires.</li>
        <li><strong>Tier it.</strong> Full testing on the top combinations, critical journeys on the next tier, a quick smoke on the rest.</li>
        <li><strong>Cover the engines,</strong> not just brand names. Chromium-based browsers behave alike, while Safari (WebKit) and Firefox (Gecko) differ more. On iOS, browsers have historically been required to use WebKit, so test on real Safari.</li>
        <li><strong>Use real devices for touch, keyboards and performance,</strong> and emulators or a cloud device farm for breadth.</li>
      </ol>
      <p>What to look for: layout at different widths, touch targets, the on-screen keyboard covering fields, date pickers and file uploads, autofill, orientation changes, and slow networks.</p>
      <p class="say">I let analytics decide the browser and device matrix, test the top tier deeply, and make sure Safari on a real iPhone is in it, because that's where a lot of surprises come from.</p>` },
    { q: 'What is WCAG, and how do you test accessibility as a manual tester?', t: ['Accessibility'], a: `
      <p><strong>WCAG</strong> (Web Content Accessibility Guidelines) is the W3C standard for accessible web content. It's built on four principles, often remembered as <strong>POUR</strong>: Perceivable, Operable, Understandable and Robust. Success criteria have levels A, AA and AAA. Most organisations, including Australian government, target level <strong>AA</strong>.</p>
      <p>Automated scanners such as axe or Lighthouse catch only part of the issues, so manual checks matter:</p>
      <ul>
        <li><strong>Keyboard only:</strong> can you reach and use everything with Tab, Shift+Tab, Enter, Space and arrow keys? Is focus always visible? No keyboard traps?</li>
        <li><strong>Screen reader:</strong> try VoiceOver or NVDA. Do buttons, links, form fields and errors make sense when read aloud?</li>
        <li><strong>Images:</strong> meaningful alt text, and empty alt on decorative images.</li>
        <li><strong>Forms:</strong> visible labels, errors that say what's wrong and how to fix it.</li>
        <li><strong>Colour:</strong> contrast of at least 4.5:1 for normal text, and colour never the only signal.</li>
        <li><strong>Zoom:</strong> usable at 200% and on narrow screens without losing content.</li>
      </ul>
      <p class="say">I run an automated scan first, then do the checks a tool can't: keyboard only, a screen reader pass, and form errors. Unplugging the mouse finds a lot.</p>` },
  ],
  advanced: [
    { q: 'What is risk-based testing, and how do you apply it?', t: ['Test design', 'Regression'], a: `
      <p>Risk-based testing spends test effort in proportion to risk. Risk is roughly <strong>likelihood</strong> of failure × <strong>impact</strong> if it fails.</p>
      <ol>
        <li><strong>Identify risks</strong> with the product owner, developers and support: features, integrations, data, regulatory rules.</li>
        <li><strong>Score them.</strong> Likelihood comes from complexity, change size, new technology and past defects. Impact comes from money, customers affected, legal exposure and reputation.</li>
        <li><strong>Map effort to score.</strong> High risk gets deep testing with several techniques, plus exploratory sessions. Low risk gets a light check or nothing, and that choice is written down.</li>
        <li><strong>Order execution</strong> so the highest risks are tested first. If time runs out, what's left is the least important work.</li>
        <li><strong>Report by risk,</strong> not by test case count: which risks are covered, which are open.</li>
        <li><strong>Revisit</strong> as you learn. A component that keeps failing moves up.</li>
      </ol>
      <p>It turns "we didn't have time to test everything" into a decision the business made with its eyes open.</p>
      <p class="say">I agree a risk list with the business, test the top of it first and hardest, and report what's covered against each risk. If we stop early, we stop at the bottom of the list.</p>` },
    { q: 'You have a form with many fields and options, and testing every combination is impossible. What do you do?', t: ['Test design'], a: `
      <p>First, separate the fields that interact from the ones that don't. Many fields are independent and only need equivalence partitions and boundaries on their own.</p>
      <p>For the fields that do interact, I use <strong>pairwise (all-pairs) testing</strong>. Most combination bugs are triggered by two factors together, so you build a set of tests where every pair of values appears at least once.</p>
      <pre>4 parameters × 3 values each = 81 full combinations
All pairs covered in as few as   9 tests</pre>
      <p>A tool such as Microsoft's PICT generates the set, and lets you add constraints (this option is impossible with that one) so you don't waste tests.</p>
      <p>Then add back what pairwise misses:</p>
      <ul>
        <li>Known high-risk combinations of three or more, added explicitly.</li>
        <li>Combinations from real usage, such as the most common customer choices.</li>
        <li>Decision tables for business rules, where every rule matters.</li>
      </ul>
      <p>Pairwise is a strong default, not a guarantee. Say that out loud when you report coverage.</p>
      <p class="say">I'd use pairwise to cover every pair of values in a handful of tests, then add the specific combinations the business says are risky, and be clear about what that doesn't cover.</p>` },
    { q: 'How would you test a payment form?', t: ['Scenarios', 'SQL', 'Accessibility'], a: `
      <p>I'd test in a sandbox with the payment provider's test cards. Never real card numbers.</p>
      <ul>
        <li><strong>Field validation:</strong> card number length and check digit (Luhn), card types (Amex has 15 digits and a 4-digit security code), expiry in the past, this month and far future, required fields, spaces and pasted numbers.</li>
        <li><strong>Gateway outcomes:</strong> approved, declined, insufficient funds, expired card, 3-D Secure challenge passed and failed, gateway timeout. The provider's test cards trigger each one.</li>
        <li><strong>Money:</strong> totals, tax, discounts, currency and rounding. The amount charged must equal the amount shown.</li>
        <li><strong>Double payment:</strong> double-click Pay, refresh during processing, back button after paying, two tabs. The customer must be charged once.</li>
        <li><strong>Data checks:</strong> query the database to confirm one order, the right status and amount, and that full card numbers and security codes are not stored or logged.</li>
        <li><strong>Accessibility:</strong> labels, keyboard use, errors announced to screen readers, no time limit without warning.</li>
        <li><strong>Recovery:</strong> what happens if the connection drops after the bank approves but before the confirmation page loads?</li>
      </ul>
      <p class="say">On a payment form I focus on three things: the customer is charged exactly once, the amount is exactly right, and card data is never stored where it shouldn't be.</p>` },
    { q: "A developer says your bug isn't a bug and won't fix it. How do you handle it?", t: ['Defects', 'Scenarios'], a: `
      <ol>
        <li><strong>Check my own facts first.</strong> Re-read the requirement and acceptance criteria. Reproduce it again in a clean state. Maybe I misunderstood, or my environment was wrong.</li>
        <li><strong>Talk, don't fight in comments.</strong> A quick call or a desk visit, showing it live. Many disagreements come from different readings of the same requirement.</li>
        <li><strong>Make it about the user, not about who's right.</strong> "A customer who does X will see Y. Is that what we want?"</li>
        <li><strong>If it's a requirements gap,</strong> take it to the product owner. They own the decision on expected behaviour, not me and not the developer.</li>
        <li><strong>Record the decision.</strong> If it's accepted as designed or deferred, write who decided and why, and close or defer it properly.</li>
      </ol>
      <p>Sometimes the developer is right. Accept that gracefully and learn the rule. If I still believe the risk is serious, I raise it once more with evidence, such as support tickets or the business impact, then let the right person decide.</p>
      <p class="say">I check my facts, show it rather than argue, frame it as user impact, and if we still disagree the product owner decides. My job is to make the risk visible, not to win.</p>` },
    { q: 'The release is tomorrow and testing is not finished. What do you do?', t: ['Scenarios', 'Regression', 'Exploratory'], a: `
      <ol>
        <li><strong>Get the real picture fast:</strong> what's tested, what's not, open defects and their severity.</li>
        <li><strong>Prioritise by risk.</strong> Use the remaining time on the critical journeys and the areas that changed most. A focused exploratory session on the riskiest change often finds more than finishing low-value scripts.</li>
        <li><strong>Get help.</strong> Developers, BAs and product owners can run checks too, with clear charters.</li>
        <li><strong>Tell the stakeholders early,</strong> not at 5 pm. Give them the facts: what's covered, what's untested, the open bugs and what each risk could mean.</li>
        <li><strong>Offer options:</strong> release as planned and accept the named risks, release with a feature turned off or behind a flag, release to a small group first, or delay.</li>
        <li><strong>Plan for after:</strong> extra monitoring, a rollback plan, and finishing the testing straight after release.</li>
      </ol>
      <p>The go or no-go decision belongs to the business. My job is to make sure they make it with an honest view of the risk.</p>
      <p class="say">I don't hide the gap and I don't just say "not ready". I test the riskiest things first, then give the decision-makers a clear list of what's untested and their options.</p>` },
    { q: 'How do you estimate testing effort?', t: ['Agile', 'Scenarios'], a: `
      <p>I combine a few methods and compare the results:</p>
      <ul>
        <li><strong>Work breakdown:</strong> split the work into tasks (analysis, test design, data and environment set-up, execution, retesting, regression, reporting) and estimate each one.</li>
        <li><strong>Three-point estimate:</strong> optimistic, most likely and pessimistic for each task. A common formula is <code>(O + 4M + P) / 6</code>.</li>
        <li><strong>Comparison:</strong> how long did similar features take before? Past data beats gut feel.</li>
        <li><strong>In Agile:</strong> testing is part of the team's story points, not a separate estimate. I make sure test effort is discussed when the team sizes the story.</li>
      </ul>
      <p>Then add what people forget: environment downtime, test data creation, defect retest cycles, third-party availability and UAT support.</p>
      <p>Always state your assumptions with the number, such as "assumes a stable environment from day one". When an assumption breaks, you can show why the estimate changed.</p>
      <p class="say">I break the work down, use three-point estimates and past data, and always publish the assumptions with the number. Retesting and environment problems are what usually blow estimates.</p>` },
    { q: 'How do you measure test coverage, and how do you know when you have tested enough?', t: ['Test design', 'Regression'], a: `
      <p>Coverage has several dimensions, and no single number tells the story:</p>
      <ul>
        <li><strong>Requirements coverage:</strong> every requirement or acceptance criterion traced to tests, with results. A traceability matrix or links in the test tool do this.</li>
        <li><strong>Risk coverage:</strong> every identified risk has tests proportional to its score.</li>
        <li><strong>Code coverage:</strong> from developers' automated tests. Useful for finding untested code, but 90% line coverage doesn't mean 90% of behaviour is tested.</li>
        <li><strong>Platform coverage:</strong> browsers, devices and user roles in the matrix.</li>
        <li><strong>Exploratory coverage:</strong> which areas had sessions, from the session notes.</li>
      </ul>
      <p>"Enough" is never "everything". It's when agreed <strong>exit criteria</strong> are met: critical risks tested, no open critical or high defects (or each one accepted by the business), the defect find rate has slowed, and the remaining risk is understood and accepted.</p>
      <p class="say">I report coverage against requirements and risks, not test case counts. We've tested enough when the exit criteria are met and the business understands and accepts what's left.</p>` },
    { q: 'What does shift-left testing mean in practice?', t: ['Agile'], a: `
      <p>Shift-left means moving testing activities earlier in delivery, because a defect found in a requirement costs far less to fix than one found in production.</p>
      <p>In practice:</p>
      <ul>
        <li><strong>Review requirements and designs</strong> before the build. Ask "how would we test this?" in refinement. Untestable stories are unclear stories.</li>
        <li><strong>Agree examples first</strong> using three amigos and BDD-style acceptance criteria.</li>
        <li><strong>Test early builds,</strong> even half-finished ones, on a developer's branch or a feature environment.</li>
        <li><strong>Support developer testing:</strong> unit and API tests in the pipeline, with testers helping decide what to cover.</li>
        <li><strong>Include non-functional needs early:</strong> accessibility, performance and security considered at design time, not just before go-live.</li>
      </ul>
      <p>Shift-left doesn't remove later testing. You still need system, regression and acceptance testing, and many teams also "shift right" with monitoring and testing in production.</p>
      <p class="say">For me shift-left mostly means being in the refinement room asking awkward questions, so many bugs never get written in the first place.</p>` },
    { q: 'How do you decide what to automate and what to keep manual?', t: ['Regression', 'Agile'], a: `
      <p><strong>Good candidates for automation:</strong></p>
      <ul>
        <li>Regression checks that run every release, especially critical journeys.</li>
        <li>Stable features that don't change often.</li>
        <li>Data-heavy checks: the same flow with many inputs.</li>
        <li>Smoke tests on every build in the pipeline.</li>
        <li>API and business-rule checks, which are faster and less brittle than UI tests.</li>
      </ul>
      <p><strong>Keep manual:</strong></p>
      <ul>
        <li>Exploratory testing and new features still changing every sprint.</li>
        <li>Usability, visual feel and much of accessibility, which need human judgement.</li>
        <li>One-off checks where automation would cost more than it ever saves.</li>
      </ul>
      <p>Weigh the cost honestly. Automation needs building, maintenance and investigation of failures. A flaky suite people ignore is worse than none. Push checks to the lowest sensible level: unit, then API, then a thin layer of UI tests.</p>
      <p class="say">I automate what's repetitive, stable and important, so people can spend their time on exploration and judgement, which machines are bad at.</p>` },
    { q: 'How would you plan and run UAT with business users?', t: ['UAT'], a: `
      <ol>
        <li><strong>Agree entry criteria:</strong> system testing complete, no open critical defects, a stable environment with realistic data, and users trained on the basics.</li>
        <li><strong>Pick the right testers:</strong> people who do the job every day, with time actually freed up in their calendars.</li>
        <li><strong>Write scenarios with them,</strong> based on real business processes ("process a refund for a customer who paid by two methods"), not technical test cases.</li>
        <li><strong>Make it easy:</strong> a short briefing, a simple way to log issues, and a tester or BA on hand to help reproduce and triage.</li>
        <li><strong>Triage daily:</strong> sort defects from change requests and training issues. Many UAT "bugs" are new requirements, and those need a product decision.</li>
        <li><strong>Agree exit criteria and sign-off</strong> up front: who signs, and what open issues are acceptable.</li>
      </ol>
      <p>The common failures are business users with no time, environments that aren't ready, and UAT used as a second round of system testing. Fix those in planning, not on day one.</p>
      <p class="say">I treat UAT as the business's test, not mine. I set it up so their people can test real processes easily, triage what they find every day, and end with a clear sign-off decision.</p>` },
  ],
};
