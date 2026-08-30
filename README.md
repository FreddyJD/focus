# Focus

A fullscreen focus browser for Windows. You set a timer and a list of sites.
While the timer runs, nothing else loads.

[![CI](https://github.com/FreddyJD/focus/actions/workflows/ci.yml/badge.svg)](https://github.com/FreddyJD/focus/actions/workflows/ci.yml)

## Install

Grab the latest installer from
[Releases](https://github.com/FreddyJD/focus/releases/latest) — download
`Focus-x.y.z-x64.exe` and run it. The app updates itself from there.

Windows SmartScreen will warn on first run, because the build is not code-signed
(a certificate costs a few hundred a year). Click **More info → Run anyway**.

## Develop

```
npm install
npm start
```

## How it works

Focus is its own browser, not a filter bolted onto Chrome. That difference is
the whole point: because every page is loaded by this app, blocking happens at
the network layer and **fails closed** — a blocked request is cancelled before
a single byte leaves your machine.

Enforcement runs at four layers, so there is no easy way around it:

| Layer | Catches |
|---|---|
| `webRequest` filter | every request, including XHR, iframes, and trackers |
| `will-navigate` | typing a URL, clicking a link |
| `will-redirect` | a site bouncing you somewhere else |
| `setWindowOpenHandler` | pop-ups and `target="_blank"` |

Matching is by hostname, not string contains. `google.com` allows
`mail.google.com` but **not** `notgoogle.com` or `google.com.evil.com` — both
are classic bypasses and both are covered by tests.

## No easy way out

There is **no close button and no minimize button** on the browser chrome, and
the app always starts fullscreen. Leaving is three deliberate steps, never one:

```
  Pause (top right)  ->  "End session"  ->  "Quit Focus"
   modal appears         back to the        app closes
   clock stops           start screen
```

**Pause** opens a modal with the time remaining. **Continue** is the primary
action on the right; **End session** is secondary on the left, so it can't be
hit by muscle memory. The modal cannot be dismissed — Esc and Enter both mean
Continue.

**End session does not close the app.** It returns you to the start screen,
which makes starting again the easiest thing to do. Only from there does
**Quit Focus** actually exit. Pausing also stops the clock, so backing out
mid-session can never be logged as a finished one.

What gets blocked during a session:

| Key | Result |
|---|---|
| `Alt+F4` | Refused, with a dialog explaining why |
| `Alt+Esc` | Swallowed (logged, does nothing) |
| `F11` | Ignored — fullscreen is not optional |
| `Ctrl+Shift+I`, `F12` | Ignored (no devtools) |
| `Alt+Tab` | **Cannot be blocked** — see below |
| `Ctrl+Alt+Del`, `Ctrl+Shift+Esc` | Not blocked, deliberately |

**About Alt+Tab, honestly:** Windows reserves it, and `globalShortcut` refuses
to register it — I verified this rather than assuming. It is not interceptable
from Electron at all. So Focus does what full-screen games do instead: the
window sits at `screen-saver` always-on-top level, and if it loses focus during
a session it takes focus straight back within ~120ms. The switch happens, but it
doesn't stick, so Alt+Tab stops being a usable way out.

Task Manager stays available on purpose. This is friction against your own
impulses, not a hostage situation — an app you genuinely cannot kill is malware.
Kiosk mode is released on quit and on crash, so you can never be locked out of
your desktop.

## Controls

- **Timer** — top right. Ring drains as the session runs.
- **Pause** — opens the paused modal: Continue, or End session. Blocking is off
  and the clock is stopped while paused, with no pretending otherwise.
- **Complete** — appears on timer hover; ends the session and shows a summary.
- `Ctrl+Shift+P` pause/resume · `Ctrl+T` new tab · `Ctrl+W` close tab ·
  `Ctrl+L` address bar · `Ctrl+R` reload

Only `Ctrl+Shift+P` is registered globally, because pausing should work when
Focus is not the front window. Everything else is scoped to the app — a global
`Ctrl+W` would close a Focus tab while you were typing in another program.

## Fullscreen

Focus runs in **kiosk mode from launch**: frameless, covering the whole display
including the taskbar, like a game. There is no OS title bar and no
File/Edit/View menu — the app draws its own top bar. Tabs and the `+` sit on the
left exactly where a browser puts them; the timer sits alone on the right.

There is no key that leaves fullscreen. `F11` is ignored. Kiosk is released on
quit and on crash, so the taskbar can never be left stranded behind an
invisible window.

Your allowlist is **locked while the timer runs**. To add a site mid-session you
must pause first. That deliberate friction is what keeps the block page from
becoming a one-click bypass.

## Sign-ins keep working

Blocking every third-party domain breaks real logins, so a small set of
auth/captcha/payment providers (Google accounts, Cloudflare, Okta, Stripe…) is
allowed **inside embedded frames only**. They can never be browsed to as pages.
See `INFRA_SUBFRAME` in `src/main/allowlist.js`.

## Blocking other applications — read this

Optional, off by default. When on, Focus watches the foreground window and
minimizes any app not on your list.

**This is friction, not a lock.** A real application lock needs a kernel driver
or Windows policy; no Electron app can do it. This will stop you drifting into
Discord out of habit. It will not stop a determined person with Task Manager.
System-critical windows (Explorer, Settings, Task Manager) are never touched, so
your machine stays usable.

## Tests

```
npm test                   # allowlist, timer, exit flow, window-lock contract
npm run test:integration   # proves blocked requests never hit the network
npm run test:security      # proves websites cannot reach the internal API
npm run test:renderer      # every UI page renders with zero console errors
npm run test:lock          # proves the window refuses to close mid-session
```

The security test is the important one. Tab views load untrusted pages, so they
get a restricted preload (`src/preload/tab.js`) that exposes the API **only** to
the app's own `blocked.html`. Without that gate, any website could call
`focusApi.pause()` and switch the blocker off from inside a page.

The renderer test exists because a single top-level `SyntaxError` silently
blanks an entire view — the app still runs, the window is just empty. That is
invisible to the other tests and easy to miss by eye.

## Design

**Monochrome by constraint.** There is one neutral ramp and no hue anywhere.
That removes the usual shortcut of "colour = meaning", so state has to be
carried by brightness, weight, elevation and motion instead:

- **Enforcing** — shield-check icon at full brightness, solid ring.
- **Paused** — everything recedes one step in brightness, and the ring
  breathes. Motion does the job the orange used to.
- **Idle** — quietest step, timer actions hidden entirely.

Structure follows Linear's tokens, extracted from their shipped stylesheets
rather than eyeballed: weights **510 / 590 / 680** (not 500/600/700), negative
tracking (`-0.011em` body, `-0.018em` headings), flat near-black surfaces, and
separators as `inset box-shadow` rather than `border` so they never affect
layout. Inter Variable is bundled locally.

Motion follows Emil Kowalski's rules:

- Custom `cubic-bezier(0.23, 1, 0.32, 1)` ease-out — the CSS built-ins are too
  weak to read as intentional. **Never `ease-in`** on UI.
- Everything under 300ms; presses get `scale(0.97)` so the UI feels like it
  heard you.
- Nothing animates from `scale(0)` — entrances start at `0.96`, because nothing
  in the real world appears out of nothing.
- Hover effects are gated behind `@media (hover: hover) and (pointer: fine)`.
- Only `transform` and `opacity` animate (GPU, no layout).

UX simplifications: the app-blocking options **collapse** until enabled, the
complete button only appears on timer hover (rare and semi-destructive, so it
shouldn't compete with the time), the address bar hides `https://`, and
`Enter` starts a session.

## Releasing

Tag a version and CI does the rest:

```
npm version patch      # or minor / major — creates the v1.0.1 tag
git push --follow-tags
```

The release workflow runs the full test suite, builds the NSIS installer, and
publishes it to GitHub Releases along with `latest.yml` — the manifest
`electron-updater` reads to find new versions.

Installed copies check for updates 8 seconds after launch and every 6 hours
after that. Downloads happen in the background, and the "restart to update"
prompt **never appears during a session** — it waits until you're idle, or until
you next open the app. An update notice that interrupted your focus would defeat
the point of the app.

## Layout

```
src/main/index.js       window, tabs, enforcement, IPC
src/main/allowlist.js   hostname matching (pure, unit-tested)
src/main/session.js     timer state machine (pure, unit-tested)
src/main/store.js       config + session history on disk
src/main/appwatcher.js  optional foreground-app nudging
src/main/watcher.ps1    Win32 foreground-window sidecar
src/main/updater.js     GitHub Releases auto-update (session-aware)
src/preload/index.js    full API — trusted UI only
src/preload/tab.js      restricted API — untrusted pages
src/renderer/          chrome, setup, paused, blocked, summary
src/renderer/base.css  design tokens (monochrome + Linear structure)
src/renderer/icons.js  stroked icon set, one 24x24 grid
```

Config lives in `%APPDATA%/Focus/focus-config.json`.
