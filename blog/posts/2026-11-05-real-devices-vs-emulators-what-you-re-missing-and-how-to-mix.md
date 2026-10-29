---
title: Real devices vs emulators: what you miss and how to mix them
date: 2026-11-05
summary: Emulators are fast and cheap, but they miss real hardware, networks, interruptions and OEM quirks. A practical way to split testing between the two.
tags: Mobile testing, Test strategy
linkedin: |
  Emulators and simulators are brilliant for fast feedback. They're also very good at hiding the bugs your users will actually hit.

  What they miss: real CPU and GPU performance on cheaper phones, thermal throttling, real camera, biometrics and Bluetooth, flaky mobile networks, interruptions like calls and notifications, and manufacturers' own tweaks to Android, such as aggressive battery savers that kill background work.

  A practical split: run most automated tests on emulators in CI for speed, run a smoke suite on a small set of real devices before release, and choose those devices from your analytics, not from what's on the team's desks.

  Include at least one low-end Android phone. It's usually where the performance bugs live.

  How do you choose which real devices to test on?
---
Emulators (Android) and simulators (iOS) make mobile testing fast: no hardware to manage, quick resets, easy to run in CI. But your users don't run your app on an emulator. Here's what emulators miss, and a practical way to mix them with real devices.

## What emulators and simulators miss

**Real performance.** An emulator runs on a powerful laptop or CI machine. A budget Android phone has a much slower CPU and GPU and less memory. Scrolling that's smooth on an emulator can stutter on a real low-end device, and the operating system may kill your app in the background when memory runs low.

**Heat and battery.** Real phones slow down when they get hot and limit background work when the battery is low or battery saver is on. Emulators don't.

**Manufacturer differences.** Samsung, Xiaomi, Oppo and others modify Android. Some are aggressive about stopping background tasks, which can break notifications, uploads and alarms. An emulator runs stock Android.

**Hardware features.** Camera, real GPS movement, Bluetooth, NFC, fingerprint and face unlock, and sensors can only be partly simulated. Payment flows using NFC or biometrics need real hardware.

**Real networks.** Emulators can throttle bandwidth, but they don't reproduce a train going through a tunnel, a switch from Wi-Fi to mobile data mid-request, or a captive portal on public Wi-Fi.

**Interruptions.** Incoming calls, notifications, permission prompts mid-flow, low-storage warnings, and the app being backgrounded and restored. These cause a surprising number of real crashes.

## What emulators are great for

- Fast feedback on every pull request.
- Functional and UI logic tests across many screen sizes and OS versions.
- Easy resets to a clean state, and parallel runs.
- Early development, before features are stable enough to justify real-device time.

The goal isn't to choose one. It's to use each for what it does well.

## A practical device mix

Choose real devices from **your own analytics** (Google Play Console, App Store Connect, or your analytics tool), not from guesses. A starting point:

| Slot | What to pick | Why |
|---|---|---|
| Popular Android | The most-used Android model among your users | Covers the biggest group |
| Low-end Android | An inexpensive phone with limited RAM | Finds performance and memory issues |
| Other manufacturer | A popular non-Samsung, non-Pixel brand in your market | Finds OEM battery and background quirks |
| Oldest supported Android | Your minimum supported OS version | Finds API and compatibility issues |
| Current iPhone | Recent model on the latest iOS | Covers most iOS users |
| Older or small iPhone | Oldest iOS version you support, small screen | Layout and compatibility |

That's six devices, which is enough to catch most real-device-only bugs for many apps. Revisit the list every few months as your users' devices change.

## How to split the testing

1. **Every pull request:** automated tests on emulators and simulators in CI.
2. **Daily or before release:** a smoke suite of critical journeys (sign-in, the main flow, payment) on real devices, either your own or a cloud device farm such as BrowserStack, Sauce Labs or AWS Device Farm.
3. **Before major releases:** exploratory testing on real devices, with poor network conditions, interruptions and low battery.
4. **After release:** watch crash reporting (for example Firebase Crashlytics) by device model and OS. It shows which devices to add to your mix.

## Quick checklist for real-device sessions

- [ ] Test on the slowest device in your mix, not just the newest.
- [ ] Switch between Wi-Fi and mobile data during a key action.
- [ ] Background the app mid-flow and come back after a few minutes.
- [ ] Deny a permission, then grant it later from Settings.
- [ ] Turn on battery saver and check notifications and background tasks.
- [ ] Rotate the screen and change the font size.

## Takeaway

Run most of your automation on emulators for speed, and keep a small, data-driven set of real devices for the bugs that only real hardware, networks and users reveal. Always include a low-end Android phone.
