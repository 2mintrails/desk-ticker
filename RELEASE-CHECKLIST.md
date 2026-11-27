# Desk Ticker: checklist before going live

Run through this before any change reaches `main` (which is what the phone loads).
Written 26 Nov 2026 after a bullion card that looked fine in testing came out cut off on the iPhone.

## 1. Agree it first
- [ ] Mockup shown and approved before building (layout, wording, what's removed).
- [ ] Anything that changes how a gesture works (swipe, tap, press-and-hold) is called out.

## 2. Build on the preview branch, not main
- [ ] Work is pushed to `preview`. Pages publishes only from `main`, so nothing reaches the phone yet.
- [ ] Version bumped in `<meta name="ticker-version">`.
- [ ] Server changes (`server/worker.js`) deploy straight to Cloudflare on push to `main`: say so, and get a go-ahead first.

## 3. Automatic UI check must pass (runs by itself on every push to `preview`)
`UI check` in GitHub Actions opens the app with **live data**, in **Safari's engine (WebKit)**, and steps through **every slide** (one job per theme, side by side: about 5 minutes) in:
- every theme: Ambient, Swiss, Retro, Calm, Anime, and the winter themes (until 6 Jan 2027)
- Shivam's iPhone only: 396×859 portrait and 859×396 landscape (other sizes dropped 27 Nov 2026 to keep the check to a few minutes)

It fails on: text cut off by its card, text off the screen, text too long for its line, a page crash, and any script error.
Problems already known and parked are listed in `KNOWN` in `tools/ui-check.mjs`: they are reported as KNOWN but don't fail the check.
To re-run just a few themes or sizes: run the workflow by hand with `looks` / `sizes` filled in.
- [ ] `UI check` is green on `preview`, **run during market hours** (9:15 AM–3:30 PM IST): the stock tiles carry more live lines then, and an after-hours run can pass while they overflow (27 Nov 2026).
- [ ] Screenshots (the `ui-shots` artifact) of the changed slide checked by eye in at least the phone's current theme.

## 4. Test with real-looking data
- [ ] Real data, not just a mock: every line the card can show (e.g. "vs yesterday", "no change", long names, big numbers).
- [ ] The card has the most lines it can show (e.g. "vs yesterday" present).
- [ ] Edge states: market open and closed, holiday, empty lists, very long headline, Hindi text.
- [ ] New code never runs before something it needs is defined (no `const`/`let` used before its line: it gives a white screen).

## 5. Go live
- [ ] Merge `preview` into `main`, wait for Pages to publish (about 1 minute).
- [ ] Tell Shivam to reload the app, and what to look at.
- [ ] Rollback point noted (last good commit) in case something slips through.
