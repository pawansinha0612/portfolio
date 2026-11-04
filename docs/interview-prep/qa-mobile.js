// Mobile app testing interview questions and model answers, used by /interview-prep/mobile-testing/ and /interview-prep/practice/.
// Each item: q = question, t = topics (used by the filters), a = model answer (HTML).
(window.QA_TRACKS = window.QA_TRACKS || {}).mobile = {
  basic: [
    { q: 'What is the difference between a native app, a hybrid app and a mobile web app?', t: ['Fundamentals'], a: `
      <ul>
        <li><strong>Native:</strong> built for one platform with its own tools, such as Kotlin or Java for Android and Swift or Objective-C for iOS. Best access to device features and usually the best performance. Two codebases to build and test.</li>
        <li><strong>Hybrid / cross-platform:</strong> one codebase shipped as an installable app. Some render web content inside a native shell (Cordova, Ionic). Others draw native or custom UI from shared code (React Native, Flutter). Installed from the store like a native app.</li>
        <li><strong>Mobile web:</strong> a website opened in the phone's browser. Nothing to install, no store review, limited device access.</li>
      </ul>
      <p>It matters for testing because it changes your tools and your risks. Hybrid apps can hide web views that native locators can't see, so automation may need to switch context. Cross-platform apps still need testing on both platforms, because the shared code runs on different OS behaviour underneath.</p>
      <p class="say">I always ask how the app is built before I plan anything. It decides which automation tools will work and where the platform-specific bugs will hide.</p>` },
    { q: 'What makes mobile testing different from testing a website?', t: ['Fundamentals'], a: `
      <p>The app runs on hardware and an OS you don't control, in conditions that keep changing. The extra areas I always cover:</p>
      <ul>
        <li><strong>Fragmentation:</strong> many devices, screen sizes, OS versions and manufacturer skins, especially on Android.</li>
        <li><strong>Interruptions:</strong> calls, notifications, alarms, low-battery warnings, switching apps.</li>
        <li><strong>Lifecycle:</strong> the app is backgrounded, suspended or killed by the OS, then has to restore its state.</li>
        <li><strong>Permissions:</strong> camera, location, notifications, which the user can deny or revoke at any time.</li>
        <li><strong>Network:</strong> moving between Wi-Fi, mobile data and no signal.</li>
        <li><strong>Resources:</strong> battery, memory, storage and CPU are limited.</li>
        <li><strong>Distribution:</strong> store review and slow user updates. You can't hot-fix a bad release, and old versions stay in the field for a long time.</li>
        <li><strong>Gestures and orientation:</strong> swipe, pinch, long press, rotation, split screen.</li>
      </ul>
      <p class="say">On the web you can roll back in minutes. On mobile a bad build sits on people's phones, so testing before release matters more.</p>` },
    { q: 'How do you test interruptions, backgrounding and orientation changes?', t: ['Fundamentals', 'Android', 'iOS'], a: `
      <p>I pick the screens where losing state would hurt most: forms, payments, checkout, video, uploads. On each one I try to break the flow:</p>
      <ul>
        <li>Receive a call or notification mid-task, then return.</li>
        <li>Press home, open other apps, come back after a few minutes.</li>
        <li>Lock and unlock the screen.</li>
        <li>Rotate the device, and use split screen where it's supported.</li>
        <li>Let the OS kill the app in the background, then reopen it from recent apps.</li>
      </ul>
      <p>Expected result: no crash, no lost input, no double submission, and the app returns to a sensible screen.</p>
      <p>On Android, rotation recreates the activity by default, so it is a cheap way to find state bugs. The developer option <strong>Don't keep activities</strong> destroys every screen as soon as you leave it, which shows up restore problems quickly. You can also kill a backgrounded app with <code>adb shell am kill com.example.app</code> to simulate the OS reclaiming memory. On iOS, background the app and stop it from Xcode, or use memory pressure, to check state restoration.</p>` },
    { q: 'Emulators and simulators or real devices: when do you use each?', t: ['Devices & cloud'], a: `
      <p>An <strong>Android emulator</strong> imitates the device hardware and runs a real Android system image. An <strong>iOS simulator</strong> runs on the Mac and imitates the iOS environment, but it is not running on iPhone hardware. Neither is a full stand-in for a real phone.</p>
      <p><strong>Use emulators and simulators for:</strong> fast feedback while developing, most functional and UI automation in CI, checking many screen sizes and OS versions cheaply.</p>
      <p><strong>Use real devices for:</strong></p>
      <ul>
        <li>Performance, battery, heat and memory on real hardware.</li>
        <li>Camera, biometrics, Bluetooth, NFC, sensors and real mobile networks.</li>
        <li>Push notifications in realistic conditions.</li>
        <li>Manufacturer-specific behaviour, such as aggressive battery savers on some Android brands.</li>
        <li>Final sign-off before a release.</li>
      </ul>
      <p class="say">I run most automation on emulators and simulators because they're fast and cheap, and I keep real devices for what only hardware can tell me, plus a real-device check before every release.</p>` },
    { q: 'How do you install test builds on Android and iOS?', t: ['Android', 'iOS', 'Release'], a: `
      <p><strong>Android:</strong></p>
      <ul>
        <li>An <strong>APK</strong> can be sideloaded: <code>adb install -r app-debug.apk</code>, or downloaded on the phone with "install unknown apps" allowed.</li>
        <li>An <strong>AAB</strong> (Android App Bundle) is what you upload to Google Play. You can't install it directly. Use a Play internal testing track or internal app sharing, or turn it into APKs with <code>bundletool</code>.</li>
        <li>Tools such as Firebase App Distribution send builds to testers by email link.</li>
      </ul>
      <p><strong>iOS:</strong></p>
      <ul>
        <li><strong>TestFlight:</strong> the standard route. Internal testers get builds quickly. External testers need the build to pass Apple's beta review first.</li>
        <li><strong>Ad hoc:</strong> a build signed with a provisioning profile that lists each device's UDID. Only registered devices can install it.</li>
        <li><strong>Development builds</strong> run straight from Xcode on a connected device or simulator.</li>
      </ul>
      <p>Always confirm the build number and environment (test, staging, production) before you start. A lot of "bugs" turn out to be the wrong build.</p>` },
    { q: 'What are the adb commands you use most, and how do you read logcat?', t: ['Android'], a: `
      <p><code>adb</code> (Android Debug Bridge) talks to an emulator or a USB-connected device. The ones I use daily:</p>
      <pre>adb devices                              # list connected devices
adb install -r app.apk                   # install or reinstall
adb uninstall com.example.app
adb shell pm clear com.example.app       # wipe app data, like a fresh install
adb shell pm grant com.example.app android.permission.CAMERA
adb exec-out screencap -p &gt; screen.png
adb shell screenrecord /sdcard/bug.mp4
adb logcat -c                            # clear the log first
adb logcat *:E                           # errors only</pre>
      <p>For logcat, I clear the buffer, reproduce the bug, then filter. Filter to the app's process with <code>adb logcat --pid=$(adb shell pidof -s com.example.app)</code>, or by tag. For a crash, search for <code>FATAL EXCEPTION</code> and read the stack trace beneath it. For an app that freezes, look for "ANR" (Application Not Responding).</p>
      <p>Attach the relevant log lines to the bug, not the whole dump. Developers read short evidence.</p>` },
    { q: 'How do you get logs and crash reports from an iOS device?', t: ['iOS'], a: `
      <ul>
        <li><strong>Xcode console:</strong> when the app runs from Xcode, its logs show in the debug area. Best for development builds.</li>
        <li><strong>Console app on the Mac:</strong> connect the iPhone, select it in Console, start streaming and filter by the app's process name. Works for builds not launched from Xcode, such as TestFlight builds.</li>
        <li><strong>Crash logs:</strong> on the device under Settings, Privacy &amp; Security, Analytics &amp; Improvements, Analytics Data. Or in Xcode's Devices and Simulators window. Crashes from TestFlight and App Store users also appear in the Xcode Organizer.</li>
        <li><strong>Simulator:</strong> <code>xcrun simctl spawn booted log stream</code> streams logs from the running simulator.</li>
      </ul>
      <p>A raw crash log shows memory addresses. It needs to be <strong>symbolicated</strong> with the build's dSYM file to show readable function names. If the stack trace looks like gibberish, check the dSYM was uploaded for that build.</p>
      <p class="say">For any iOS bug I note the device, iOS version and build number, and attach the Console or crash log. Without those, developers can't reproduce it.</p>` },
    { q: 'How do you test app permissions?', t: ['Fundamentals', 'Android', 'iOS'], a: `
      <p>Permissions are a common source of crashes, because developers often test only the happy path where the user taps Allow.</p>
      <ul>
        <li><strong>Allow:</strong> the feature works straight away.</li>
        <li><strong>Deny:</strong> the app explains why it needs it and keeps working without the feature. No crash, no endless prompt.</li>
        <li><strong>Deny permanently:</strong> Android stops showing the prompt after repeated denials, and iOS asks only once. The app should point the user to Settings.</li>
        <li><strong>Partial grants:</strong> approximate rather than precise location, or limited photo access on iOS.</li>
        <li><strong>Revoke while running:</strong> turn the permission off in Settings, then return to the app. Android may restart the app process when you do this.</li>
        <li><strong>Timing:</strong> the prompt appears when the user needs the feature, not all at once on first launch.</li>
      </ul>
      <p>To reset quickly: <code>adb shell pm revoke</code> or <code>pm clear</code> on Android, and <code>xcrun simctl privacy booted reset all com.example.app</code> on the iOS simulator. On a real iPhone, deleting and reinstalling the app resets most prompts.</p>` },
    { q: 'How do you test an app with no network or a poor network?', t: ['Network'], a: `
      <p>Real users ride trains, walk into lifts and sit on weak café Wi-Fi. I test four situations:</p>
      <ol>
        <li><strong>No network:</strong> airplane mode before launch and mid-session. The app shows a clear message, keeps cached content, and doesn't crash or spin forever.</li>
        <li><strong>Slow network:</strong> high latency and low bandwidth. Loading indicators show, timeouts are sensible, and the user can retry.</li>
        <li><strong>Lossy network:</strong> dropped packets and failed requests. Retries happen without duplicating actions such as payments.</li>
        <li><strong>Switching:</strong> Wi-Fi to mobile data and back, during an upload or a payment.</li>
      </ol>
      <p>Tools: the Android emulator's network speed and latency settings, Network Link Conditioner on iOS, and proxies such as Charles or Proxyman that can throttle or block calls.</p>
      <p class="say">The bug I look hardest for is the double submit: the request reached the server, the response was lost, and the user taps again.</p>` },
    { q: 'What is crash reporting, and how do testers use Firebase Crashlytics?', t: ['Fundamentals', 'Release'], a: `
      <p>A crash reporting tool collects crash and error details from users' devices and groups them so the team can fix the worst first. Firebase Crashlytics is a common free option. Others include Sentry and the crash reports built into Google Play Console and the Xcode Organizer.</p>
      <p>Crashlytics groups crashes into <strong>issues</strong> by stack trace, and shows the device, OS version, app version, how many users are affected, and any custom logs or keys the app recorded.</p>
      <p>How I use it as a tester:</p>
      <ul>
        <li>Check that test builds report to a separate project or are clearly labelled, so test crashes don't mix with production.</li>
        <li>After a test session, look for crashes nobody noticed, such as background crashes.</li>
        <li>Use the breadcrumbs and custom keys to reproduce a bug.</li>
        <li>After a release, watch the <strong>crash-free users</strong> rate and new issues. A drop is a signal to pause a staged rollout.</li>
      </ul>
      <p>Also test the setup itself: force a test crash once and confirm it arrives, symbolicated.</p>` },
  ],
  intermediate: [
    { q: 'How do you choose which devices and OS versions to test on?', t: ['Devices & cloud', 'Automation strategy'], a: `
      <p>You can't test everything, so let your own users decide.</p>
      <ol>
        <li><strong>Pull analytics:</strong> Firebase or Google Analytics, Play Console and App Store Connect show your users' devices, OS versions and screen sizes. Use your users, not global figures.</li>
        <li><strong>Cover most of the traffic:</strong> pick the devices and OS versions that together cover the large majority of sessions.</li>
        <li><strong>Add the edges:</strong> the lowest OS version you support, the smallest and largest screens, a low-memory budget phone, a tablet if you support one, and the newest OS beta.</li>
        <li><strong>Add the risky manufacturers:</strong> Android brands with heavy custom skins or aggressive battery management.</li>
        <li><strong>Weight by value:</strong> if most revenue comes from iOS users, test there more deeply.</li>
      </ol>
      <p>Then tier it. Tier 1 devices get full regression on every release. Tier 2 get smoke tests. Tier 3 are covered in a device cloud now and then.</p>
      <p class="say">I build the matrix from our own analytics, cover the bulk of real users plus the edges, and review it every quarter because the mix keeps changing.</p>` },
    { q: 'What do device clouds give you, and how do the main ones compare?', t: ['Devices & cloud'], a: `
      <p>A device cloud lets you run manual and automated tests on hosted real devices, emulators and simulators without buying them all. You get wide coverage, parallel runs, video, logs and screenshots for each test.</p>
      <ul>
        <li><strong>BrowserStack</strong> (App Live, App Automate): large range of real Android and iOS devices; good for manual exploration and Appium, Espresso and XCUITest runs.</li>
        <li><strong>Sauce Labs:</strong> real devices plus emulators and simulators, strong reporting, also covers web.</li>
        <li><strong>Firebase Test Lab:</strong> Google's service. Runs Espresso and XCUITest suites, and has a <strong>Robo test</strong> for Android that crawls the app with no script. Easy to call from CI with <code>gcloud</code>.</li>
        <li><strong>AWS Device Farm:</strong> real devices in AWS, supports Appium and native frameworks, and offers private devices.</li>
      </ul>
      <p>Things to check before choosing: the devices you actually need, parallel session limits, queue times at busy hours, cost, data privacy (where the device and your test data live), and how it fits your CI.</p>
      <p>Device clouds are slower and more flaky than local emulators, so run the fast suite locally and the device spread in the cloud.</p>` },
    { q: 'Explain the Appium architecture.', t: ['Appium'], a: `
      <p>Appium is a client-server tool that speaks the W3C WebDriver protocol, the same idea as Selenium.</p>
      <ol>
        <li><strong>Client:</strong> your test code, using an Appium client library in Java, Python, JavaScript (such as WebdriverIO), C# or others. It sends HTTP requests such as "find element" or "tap".</li>
        <li><strong>Appium server:</strong> a Node.js server. It starts a session from your <strong>capabilities</strong> (platform, automation name, app path, device) and routes each command to the right driver.</li>
        <li><strong>Drivers:</strong> installed separately, one per platform:
          <ul>
            <li><strong>UiAutomator2</strong> for Android. It installs a small server app on the device that uses Google's UiAutomator framework.</li>
            <li><strong>XCUITest</strong> for iOS. It uses WebDriverAgent, built on Apple's XCTest framework.</li>
          </ul>
        </li>
        <li><strong>Device:</strong> the driver performs the action and returns the result back up the chain.</li>
      </ol>
      <pre>{ "platformName": "Android",
  "appium:automationName": "UiAutomator2",
  "appium:app": "/builds/app-debug.apk",
  "appium:deviceName": "Pixel emulator" }</pre>
      <p class="say">Appium is black box: it drives the app from outside, like a user. That's why it works across platforms and languages, and also why it is slower than in-process frameworks.</p>` },
    { q: 'What is a good locator strategy for mobile automation?', t: ['Appium', 'Automation strategy'], a: `
      <p>In order of preference:</p>
      <ol>
        <li><strong>Accessibility id:</strong> the same locator works on both platforms. On iOS it maps to the <code>accessibilityIdentifier</code>, which VoiceOver does not read aloud. On Android it maps to <code>content-desc</code>.</li>
        <li><strong>Resource id</strong> on Android. If putting a test id in <code>content-desc</code> would make TalkBack read nonsense, use the resource id instead.</li>
        <li><strong>Platform-native queries:</strong> <code>-android uiautomator</code>, <code>-ios predicate string</code> and <code>-ios class chain</code>. Fast and flexible.</li>
        <li><strong>XPath:</strong> last resort. It is slow, especially on iOS, because the whole page tree has to be built, and it breaks when the layout changes.</li>
      </ol>
      <p>Avoid locating by visible text if the app is translated or the copy changes often. Avoid index-based locators.</p>
      <p>The real fix is a team agreement: developers add stable test ids as part of building each screen, and it is in the definition of done. Then wrap locators in a page or screen object so a change is fixed in one place.</p>` },
    { q: 'How do you test deep links?', t: ['Android', 'iOS'], a: `
      <p>A deep link opens a specific screen in the app from a URL: an email, an ad, a QR code or a push notification.</p>
      <ul>
        <li><strong>Custom schemes</strong> like <code>myapp://order/123</code>. Easy, but any app can claim the same scheme.</li>
        <li><strong>Android App Links</strong> and <strong>iOS Universal Links</strong>: normal https URLs that open the app. They rely on a file on your website (<code>assetlinks.json</code> for Android, <code>apple-app-site-association</code> for iOS) that proves you own the domain.</li>
      </ul>
      <p>Cases to cover:</p>
      <ul>
        <li>App installed and closed, in the background, and already open on another screen.</li>
        <li>App not installed: the link should fall back to the website or the store.</li>
        <li>Logged out: log in, then land on the linked screen, not the home screen.</li>
        <li>Bad or expired ids, missing parameters, and links to content the user isn't allowed to see.</li>
        <li>The back button after landing.</li>
      </ul>
      <pre>adb shell am start -a android.intent.action.VIEW -d "https://example.com/order/123" com.example.app
xcrun simctl openurl booted "https://example.com/order/123"</pre>
      <p>Also check the website association files are live in each environment. A missing file silently opens links in the browser instead.</p>` },
    { q: 'How do you test push notifications?', t: ['Android', 'iOS', 'Network'], a: `
      <p>Android uses Firebase Cloud Messaging (FCM) and iOS uses the Apple Push Notification service (APNs). The app registers, gets a device token, and the backend sends to that token.</p>
      <ul>
        <li><strong>Permission:</strong> iOS and newer Android versions ask the user. Test allow, deny, and turning notifications off later in Settings.</li>
        <li><strong>App state:</strong> foreground, background and fully closed. A foreground notification often needs the app to show it itself.</li>
        <li><strong>Tap action:</strong> it opens the right screen, including when the user is logged out.</li>
        <li><strong>Content:</strong> long text, emoji, images, action buttons, grouping, sound and badge count.</li>
        <li><strong>Tokens:</strong> after reinstall, logout or switching accounts, the old user must stop getting messages.</li>
        <li><strong>Environment:</strong> iOS development builds use the APNs sandbox; TestFlight and App Store builds use production. A wrong setting means pushes silently don't arrive.</li>
      </ul>
      <p>On Android, a force-stopped app won't receive FCM messages until the user opens it again, and some manufacturers' battery savers delay or block them. Test on real devices for that. On the iOS simulator you can send a test payload with <code>xcrun simctl push booted com.example.app payload.apns</code>.</p>` },
    { q: 'How do you simulate network conditions and switching in a structured way?', t: ['Network', 'Performance'], a: `
      <p>I define a small set of named profiles and reuse them, so results are comparable between releases:</p>
      <ul>
        <li><strong>Good Wi-Fi</strong> (baseline), <strong>average 4G</strong>, <strong>poor 3G</strong> with high latency, <strong>lossy</strong> with dropped packets, and <strong>offline</strong>.</li>
      </ul>
      <p>Tools:</p>
      <ul>
        <li>Android emulator network settings, or <code>adb emu network speed</code> and <code>adb emu network delay</code>.</li>
        <li>Network Link Conditioner on iOS (on a Mac, and in the device's Developer settings).</li>
        <li>Charles or Proxyman to throttle, add latency, return errors or block a single endpoint.</li>
        <li>A device cloud's network shaping for real devices.</li>
      </ul>
      <p>What I check on each profile: time to first useful screen, whether spinners and skeletons appear, timeouts and retry behaviour, image sizes and caching, and how much data a session uses.</p>
      <p>Then I test transitions: Wi-Fi drop mid-upload, captive portal Wi-Fi with no real internet, and resume after a lift ride. Offline-first apps also need sync and conflict tests when two devices change the same data.</p>
      <p class="say">Blocking one endpoint with a proxy finds more bugs than turning the whole network off, because real failures are usually partial.</p>` },
    { q: 'What are cold, warm and hot app starts, and how do you measure startup time?', t: ['Performance', 'Android', 'iOS'], a: `
      <ul>
        <li><strong>Cold start:</strong> the app process isn't running. The OS creates the process and the app loads everything. Slowest, and the one users judge you on.</li>
        <li><strong>Warm start:</strong> the process still exists but the screen has to be recreated, for example after the system reclaimed memory or the user backed out.</li>
        <li><strong>Hot start:</strong> the app was in the background and just comes back to the front. Fastest.</li>
      </ul>
      <p><strong>Measuring on Android:</strong></p>
      <pre>adb shell am force-stop com.example.app
adb shell am start -W -n com.example.app/.MainActivity
# read TotalTime from the output; repeat several times</pre>
      <p>Logcat also prints a "Displayed" line with the time to first frame. For repeatable numbers use the Jetpack Macrobenchmark library, and watch Android vitals in Play Console for real users.</p>
      <p><strong>Measuring on iOS:</strong> the App Launch template in Instruments, <code>XCTApplicationLaunchMetric</code> in an XCTest performance test, and launch time in the Xcode Organizer for real users.</p>
      <p>Always measure release builds on a real, mid-range device, take the median of several runs, and track the trend per build. Debug builds and flagship phones lie.</p>` },
    { q: 'How do you test accessibility in a mobile app?', t: ['Fundamentals', 'Android', 'iOS'], a: `
      <p>Start with the screen readers, because they find the most real problems:</p>
      <ul>
        <li><strong>TalkBack</strong> on Android and <strong>VoiceOver</strong> on iOS. Complete the key journeys without looking at the screen. Every control has a meaningful label, the focus order makes sense, and pop-ups and errors are announced.</li>
        <li><strong>Text size:</strong> Android font size and display size, iOS Dynamic Type including the larger accessibility sizes. Text should wrap or scroll, not get cut off or overlap.</li>
        <li><strong>Touch targets:</strong> big enough to tap. Platform guidance is around 48 dp on Android and 44 pt on iOS.</li>
        <li><strong>Colour and contrast:</strong> meaning is not carried by colour alone, and contrast is readable, including in dark mode.</li>
        <li><strong>Other settings:</strong> reduce motion, bold text, Switch Access or Switch Control, landscape lock.</li>
      </ul>
      <p>Tools help with the basics: Accessibility Scanner on Android, Accessibility Inspector in Xcode, Espresso accessibility checks, and the accessibility audit in XCUITest. They don't replace a person using a screen reader.</p>
      <p class="say">I test the top journeys with TalkBack and VoiceOver every release, and automate the checks a tool can catch, such as missing labels and small targets.</p>` },
    { q: 'Espresso and XCUITest or Appium: how do you choose?', t: ['Appium', 'Automation strategy', 'Android'], a: `
      <p><strong>Espresso</strong> (Android) and <strong>XCUITest</strong> (iOS) are the platform frameworks. Espresso runs inside the app's process and waits for the UI thread and registered idling resources on its own, so tests are fast and stable. XCUITest runs in a separate runner process and drives the app through accessibility, which is still fast and well supported by Apple.</p>
      <ul>
        <li><strong>Pros:</strong> speed, stability, first-class support in Android Studio and Xcode, run with the developers' build.</li>
        <li><strong>Cons:</strong> one platform each, written in Kotlin, Java or Swift, and they usually live in the app's repo.</li>
      </ul>
      <p><strong>Appium</strong> drives both platforms from outside the app.</p>
      <ul>
        <li><strong>Pros:</strong> one language and framework for Android and iOS, testers can own it, black box against the real build, works with device clouds.</li>
        <li><strong>Cons:</strong> slower, more moving parts, more waits and more flakiness.</li>
      </ul>
      <p>My usual answer: if developers write UI tests, use Espresso and XCUITest for most screen-level tests. Use Appium for a smaller set of cross-platform end-to-end journeys that a separate QA team owns.</p>
      <p class="say">It's less about which tool is better and more about who writes and fixes the tests. Pick the tool that fits the people.</p>` },
  ],
  advanced: [
    { q: 'Why are mobile UI tests flaky, and how do you fix them?', t: ['Appium', 'Automation strategy'], a: `
      <p>Common causes:</p>
      <ul>
        <li><strong>Timing:</strong> animations, network calls and lazy loading. Fixed sleeps are too short on a slow device and waste time on a fast one.</li>
        <li><strong>Device state:</strong> leftover data, system dialogs, keyboards, low storage, a notification over the button.</li>
        <li><strong>Test data:</strong> shared accounts, data changed by another test, real backends that are slow or down.</li>
        <li><strong>Infrastructure:</strong> emulator boot problems, device cloud queues, Appium session drops.</li>
        <li><strong>Brittle locators</strong> such as XPath and indexes.</li>
      </ul>
      <p>Fixes:</p>
      <ol>
        <li>Wait for a condition, never a fixed time. Use Espresso idling resources so the framework waits for you.</li>
        <li>Turn off animations on test devices.</li>
        <li>Start each test from a known state: fresh install or cleared data, and deep link straight to the screen under test.</li>
        <li>Create test data through APIs and give each test its own. Mock the backend for screen-level tests.</li>
        <li>Grant permissions up front, for example <code>appium:autoGrantPermissions</code> on Android.</li>
        <li>Record video and logs for every failure, and track flaky tests by name. Quarantine them and fix them, don't just retry them.</li>
      </ol>
      <p class="say">A retry hides flakiness; it doesn't fix it. I allow one retry to keep the pipeline moving, but every retry is logged and the worst offenders get fixed first.</p>` },
    { q: 'How do you investigate memory, CPU and battery problems in a mobile app?', t: ['Performance', 'Android', 'iOS'], a: `
      <p>First I reproduce the problem with a repeatable journey on a real, mid-range device, using a release-like build. Then I profile.</p>
      <p><strong>Android:</strong></p>
      <ul>
        <li><strong>Android Studio Profiler:</strong> CPU (method traces, thread activity), memory (heap dumps, allocations), and energy.</li>
        <li><strong>LeakCanary</strong> in debug builds to catch leaked activities and fragments.</li>
        <li><code>adb shell dumpsys meminfo com.example.app</code> for memory, <code>dumpsys gfxinfo</code> for janky frames, <code>dumpsys batterystats</code> and Battery Historian for battery use.</li>
      </ul>
      <p><strong>iOS:</strong></p>
      <ul>
        <li><strong>Xcode Instruments:</strong> Time Profiler for CPU, Allocations and Leaks for memory, Energy Log, Network, and Hangs.</li>
        <li>The Xcode memory graph debugger to find retain cycles.</li>
        <li>MetricKit and the Xcode Organizer for real-user data on battery, hangs and memory.</li>
      </ul>
      <p>A useful leak test: repeat one journey many times, such as opening and closing a screen, and watch whether memory returns to a baseline or keeps climbing. For battery, look for work that keeps going in the background: location updates, wake locks, polling and timers.</p>
      <p>Compare every result with the previous release. Profiling numbers mean little on their own.</p>` },
    { q: 'What are OWASP MASVS and MASTG, and what security issues do you test for?', t: ['Security'], a: `
      <p><strong>MASVS</strong> (Mobile Application Security Verification Standard) says what a secure mobile app should do. <strong>MASTG</strong> (Mobile Application Security Testing Guide) explains how to test it. MASVS groups controls into areas such as storage, cryptography, authentication, network, platform interaction, code quality, resilience and privacy.</p>
      <p>The issues I check most often:</p>
      <ul>
        <li><strong>Insecure storage:</strong> tokens, passwords or personal data in plain text in SharedPreferences, UserDefaults, SQLite files, logs or caches. Secrets belong in the Android Keystore or the iOS Keychain.</li>
        <li><strong>Leaks:</strong> sensitive screens visible in the app switcher snapshot, data copied to the clipboard, data in device backups, secrets in logcat.</li>
        <li><strong>Network:</strong> plain HTTP, weak TLS, no certificate pinning where the risk justifies it.</li>
        <li><strong>Authentication:</strong> session expiry, logout really clears the token, biometrics backed by the Keystore or Keychain rather than a simple yes or no flag.</li>
        <li><strong>Platform:</strong> exported Android components, unvalidated deep links, WebViews with JavaScript bridges.</li>
        <li><strong>Hard-coded secrets</strong> in the app package. Anyone can decompile an APK with tools like jadx.</li>
      </ul>
      <p>Tools: MobSF for static scans, a proxy for traffic, Frida and objection for runtime checks on a test device.</p>` },
    { q: 'What is certificate pinning, and how do you test an app that uses it?', t: ['Security', 'Network'], a: `
      <p>Normally an app trusts any certificate signed by a trusted certificate authority. With <strong>pinning</strong>, the app only trusts a specific certificate or public key for its own servers. That stops an attacker who has installed their own CA on the device, or a compromised CA, from reading the traffic.</p>
      <p>It also stops testers using Charles or Proxyman. Modern Android apps already ignore user-installed CAs by default, so even without pinning you need a test build that trusts your proxy.</p>
      <p>How I handle it:</p>
      <ul>
        <li>Ask for a <strong>test build</strong> where pinning is off and the proxy CA is trusted. On Android this is often a debug-only network security config. Never ship that to production.</li>
        <li>On the <strong>release build</strong>, test the pinning itself: with a proxy in the middle, requests must fail safely and not fall back to an insecure connection.</li>
        <li>Check the <strong>rotation plan</strong>: a backup pin exists, and the team knows what happens when the server certificate or key changes. A bad rotation can lock every user out until they update.</li>
        <li>Use Frida or objection to show that pinning can be bypassed on a rooted or jailbroken device. It raises the bar, but the server must still validate everything.</li>
      </ul>
      <p class="say">Pinning protects users but it is also an outage risk, so I test the certificate rotation, not just the pin.</p>` },
    { q: 'How do you test an app store release and manage staged rollouts?', t: ['Release'], a: `
      <p><strong>Before submission:</strong></p>
      <ul>
        <li>Test the exact signed release build that will be uploaded, from the store's test channel: TestFlight, or a Play testing track. Not a debug build.</li>
        <li><strong>Upgrade test:</strong> install the current live version, create data, then update. Users don't do fresh installs, and data migrations break here.</li>
        <li>Smoke test against production config: real endpoints, analytics, crash reporting, push in the production environment.</li>
        <li>Check store requirements: privacy details, permission explanation strings, required account deletion, screenshots and release notes.</li>
      </ul>
      <p><strong>Staged rollout:</strong></p>
      <ul>
        <li>Google Play lets you release to a percentage of users and increase it step by step, or halt it.</li>
        <li>The App Store's <strong>phased release</strong> spreads automatic updates over several days and can be paused. Users can still update by hand.</li>
      </ul>
      <p>Agree go and no-go rules before the rollout: crash-free users, ANR rate, error rates on key APIs, reviews and support tickets. Watch them at each step.</p>
      <p class="say">Halting a rollout stops new installs but doesn't remove the build from people who already have it. So the real safety net is feature flags and a fast fix, not the rollout alone.</p>` },
    { q: 'How do feature flags change mobile testing?', t: ['Release', 'Automation strategy'], a: `
      <p>On mobile you can't roll back a release quickly, so teams use feature flags or remote config (such as Firebase Remote Config or LaunchDarkly) to turn features on and off without a new build.</p>
      <p>That helps, but it adds testing work:</p>
      <ul>
        <li><strong>Both states:</strong> every flagged feature must work with the flag on and off, and the app must not crash if the flag flips mid-session.</li>
        <li><strong>Defaults:</strong> test with no network on first launch. The app uses the built-in defaults, and they must be safe.</li>
        <li><strong>Combinations:</strong> don't test every combination. Test what will actually be live together, plus flags that touch the same screens.</li>
        <li><strong>Old app versions:</strong> a flag turned on for everyone also reaches older builds. Target flags by app version when old builds can't support the feature.</li>
        <li><strong>Kill switch:</strong> prove that turning a feature off really stops it, including any background work.</li>
      </ul>
      <p>For automation, let tests set flag values through a test override, not the live config service, so runs are repeatable.</p>
      <p>Also track flag debt. Remove a flag and its old code path once the feature is fully live, or the test matrix keeps growing.</p>` },
    { q: 'How do you handle backward compatibility, old OS versions and forced updates?', t: ['Release', 'Android', 'iOS'], a: `
      <p>Three different problems:</p>
      <p><strong>1. Old OS versions.</strong> Android's <code>minSdk</code> and the iOS deployment target set the lowest supported OS. Code that uses newer APIs must check the version first, or it crashes only on older phones. Keep at least one device or emulator on the lowest supported version in every regression run. When <code>targetSdk</code> is raised, re-test permissions, background work and notifications, because behaviour changes are tied to it.</p>
      <p><strong>2. Old app versions against a new backend.</strong> Many users don't update for months. Backend changes must stay compatible with every app version still supported: no removed fields, no changed meanings, versioned APIs. I keep the last few released builds installable and run a smoke test against the new backend before it deploys.</p>
      <p><strong>3. Forced updates.</strong> When an old version must stop working, the app checks a minimum supported version from the server and blocks or nags the user. Test:</p>
      <ul>
        <li>Soft prompt (dismissable) and hard block (not dismissable).</li>
        <li>The store link opens the right listing.</li>
        <li>What happens offline, when the check can't run.</li>
        <li>The check itself was shipped in old builds. You can't force-update a version that has no check.</li>
      </ul>
      <p>On Android, the Play In-App Updates API can also prompt or force an update inside the app.</p>` },
    { q: 'How would you build a mobile test strategy for a brand-new app?', t: ['Automation strategy', 'Fundamentals'], a: `
      <ol>
        <li><strong>Understand the risk:</strong> who the users are, what the critical journeys are (sign-up, login, payment), which platforms come first, and any regulation or security needs.</li>
        <li><strong>Tech choices:</strong> native, cross-platform or hybrid decides the tools.</li>
        <li><strong>Test pyramid:</strong> plenty of unit tests, component and API tests, a set of Espresso and XCUITest screen tests, and a small set of end-to-end journeys in Appium or Maestro.</li>
        <li><strong>Device matrix:</strong> from market research at first, then from your own analytics after launch. Emulators in CI, a device cloud for the spread, a few real devices in the office.</li>
        <li><strong>Non-functional:</strong> startup time, memory and battery budgets, poor network, accessibility, security against MASVS.</li>
        <li><strong>Manual and exploratory:</strong> interruptions, gestures, real-world use, and new features before they are automated.</li>
        <li><strong>Pipeline:</strong> every pull request builds and runs fast tests; nightly runs the device spread; release builds go to TestFlight and a Play track.</li>
        <li><strong>Release and production:</strong> staged rollouts, feature flags, crash reporting, and agreed go and no-go rules.</li>
      </ol>
      <p class="say">I start from the risks and the critical journeys, push most testing down to fast layers, and treat crash reporting and staged rollouts as part of testing, because on mobile production is where the long tail of devices shows up.</p>` },
    { q: 'Where do Detox and Maestro fit compared with Appium?', t: ['Automation strategy', 'Appium'], a: `
      <p><strong>Detox</strong> is a grey-box framework for React Native apps. It is built into a test build of the app and knows when the app is idle, with no pending network calls, animations or timers, so it waits on its own. That makes tests much less flaky than black-box tools. Tests are written in JavaScript, so React Native developers can own them. The cost: it targets React Native, and it needs changes to the build setup.</p>
      <p><strong>Maestro</strong> uses simple YAML flows and drives the app from outside, like Appium, but with built-in tolerance for delays and slow loads. It works with native, React Native and Flutter apps on Android and iOS. Quick to learn, quick to write, good for smoke tests and for testers who don't code much. Less suited to complex logic and data handling.</p>
      <pre>appId: com.example.app
---
- launchApp
- tapOn: "Log in"
- inputText: "test@example.com"
- assertVisible: "Welcome"</pre>
      <p><strong>Appium</strong> remains the most flexible: any language, any app type, deep device cloud support. It also needs the most work to keep stable.</p>
      <p class="say">For a React Native team I'd look at Detox first, for fast smoke flows Maestro, and Appium when I need full control, many languages, or a large existing Selenium-style framework.</p>` },
    { q: 'How do you run mobile automation in a CI/CD pipeline?', t: ['Automation strategy', 'Devices & cloud'], a: `
      <p>Split the tests by speed and run each where it gives the fastest useful answer:</p>
      <ul>
        <li><strong>Every pull request:</strong> unit tests, lint, and a small UI smoke set on one Android emulator and one iOS simulator. Aim for minutes, not an hour.</li>
        <li><strong>After merge or nightly:</strong> the full UI regression, run in parallel across the device matrix in a device cloud.</li>
        <li><strong>Release candidate:</strong> the full suite on real devices, plus upgrade tests, then upload to TestFlight and a Play testing track.</li>
      </ul>
      <p>Practical points:</p>
      <ul>
        <li>iOS builds need macOS runners and code signing. Tools such as fastlane manage certificates, profiles and uploads.</li>
        <li>Android emulators on Linux runners need hardware acceleration, or they are painfully slow.</li>
        <li>Build the app once and pass the same artifact through every stage, so you test what you ship.</li>
        <li>Shard tests across devices to keep run time down.</li>
        <li>Publish results with video, logs and screenshots for every failure, and report flaky tests separately from real failures.</li>
        <li>Mock or stub the backend for PR runs; use a stable test environment for nightly end-to-end runs.</li>
      </ul>
      <p class="say">A suite that takes too long to run won't get run. I keep the PR gate small and fast and push the device spread to nightly runs.</p>` },
  ],
};
