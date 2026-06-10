# Handoff: WhitelistWeb — kid-safe site lock (Chromium MV3 extension)

## Overview

**WhitelistWeb** is a small parental-control browser extension. It blocks a child
from visiting *any* website until a parent types a password. Unlocking is
**per-site**, and the parent chooses the duration each time:

- **Allow forever** — the site is whitelisted permanently (stored in
  `chrome.storage.local`); it stays open across browser restarts until you
  remove it in Settings or hit "Lock everything now".
- **Just this time** — the site is open only for the current browsing session
  (`chrome.storage.session`); it re-locks once the browser fully closes.

"Lock everything now" in the toolbar popup wipes **both** lists, and Settings
lists every "forever" site so you can remove them individually. It is
intentionally simple — designed to stop an 8-year-old, **not** a determined
adult.

## About the files in this bundle

> **Important:** unlike a typical design handoff, the files in
> `WhitelistWeb/` are **complete, working production code**, not throwaway HTML
> mocks. The extension loads and runs as-is via `chrome://extensions → Load
> unpacked`. You can ship it directly, or treat it as a reference
> implementation to fold into a larger codebase / harden further.

It is a **Manifest V3** extension: a service-worker background script plus three
extension pages (lock screen, options, popup). No build step, no dependencies,
no bundler — plain HTML/CSS/JS. The only external resource is Google Fonts
(Baloo 2 + Nunito); see "Assets".

## Fidelity

**High-fidelity and functional.** Colors, typography, spacing, motion, and copy
are final and match the **212video** design system (see Design Tokens). The
logic implements the full spec including edge cases.

---

## File map

```
WhitelistWeb/
├── manifest.json      MV3 manifest (permissions, SW, action, options, icons, WAR)
├── background.js      Service worker: nav interception, hashing, allow-list, messaging
├── locked.html        Lock screen markup (Pip mascot + sun scene)
├── locked.css         Lock screen styles (212 visual system)
├── locked.js          Lock screen logic (reads query params, submits unlock)
├── options.html       Setup / change-password page
├── options.js         Password set + change logic (SHA-256)
├── popup.html         Toolbar popup
├── popup.js           Popup logic (status, "Lock everything now", open options)
└── icons/
    ├── icon16.png     Toolbar/menu icon (orange padlock)
    ├── icon48.png
    └── icon128.png
```

---

## Architecture & behavior

### Core flow
1. `chrome.webNavigation.onBeforeNavigate` fires for every navigation. The
   handler **ignores sub-frames** (`details.frameId !== 0`) — main frame only.
2. It only guards real web pages (`http:` / `https:`). Everything else
   (`chrome://`, `chrome-extension://`, `about:`, the new-tab page, `file:`,
   `data:`) is skipped. Because the extension's own pages are
   `chrome-extension://`, this is also what prevents it from ever blocking
   `locked.html` / `options.html`.
3. The destination hostname is turned into a **site key** via `getSiteKey()`:
   the full hostname, lowercased, with a leading `www.` stripped. So each
   subdomain is its **own** site — `m.youtube.com` and `kids.youtube.com` are
   distinct from `youtube.com` — while `www.youtube.com` collapses to
   `youtube.com` so the common bare→www redirect doesn't re-lock the page you
   just approved.
4. If the site key is **not** in either allow-list (forever or this-session),
   the tab is redirected with `chrome.tabs.update(tabId, { url: locked.html?... })`
   — before the real page renders. The original URL and key are passed as
   query params.
5. The lock screen verifies the password (via a message to the background
   worker), and on success the worker adds the site to the chosen allow-list
   (`scope: 'forever' | 'session'`) and navigates the tab to the original URL.

### Why interception goes through a cached decision
`onBeforeNavigate` cannot be awaited to *block*, and MV3 service workers can be
killed at any time. To redirect as early as possible, the worker keeps an
**in-memory cache** (`allowSet`, `passwordHash`, `cacheReady`) that is:
- warmed at top-level on worker startup (`loadCache()`),
- refreshed on `onInstalled` / `onStartup`,
- kept in sync via `chrome.storage.onChanged`.

The handler reads the cache synchronously when ready and only falls back to an
async `loadCache()` if the worker just woke. **Known limitation:** on the very
first navigation after a long idle, there is a small window where the worker is
waking; a blocked page may flash briefly before the lock screen takes over.
This is inherent to MV3 and acceptable for the threat model. Hardening it
further would require `declarativeNetRequest`, which cannot express the
per-session password flow.

### Unlock routing (avoids a re-lock race)
`locked.js` does **not** mutate storage directly. It sends
`{ type: 'unlock', scope, domain, url, password }` to the background worker. The
worker verifies the hash, updates the matching **in-memory set first**
(synchronously — `allowSet` for `forever`, `sessionSet` for `session`), persists
to the corresponding storage area, then navigates the tab. Doing the cache
update in the worker before navigation guarantees the subsequent
`onBeforeNavigate` sees the domain as allowed and does not re-lock.

### First-run / no-password handling
If no password hash exists yet:
- `onInstalled` calls `chrome.runtime.openOptionsPage()`.
- Any web navigation is redirected to `options.html?setup=1` instead of the lock
  screen. (Reasoning: with no password, the lock screen would have nothing to
  unlock against and could trap the child permanently. Steering to setup is the
  safe behavior.)

### Storage model
| Key | Area | Shape | Purpose |
|---|---|---|---|
| `passwordHash` | `chrome.storage.local` | hex string (SHA-256) | persistent password, **hash only, never plaintext** |
| `unlockedDomains` | `chrome.storage.local` | `string[]` of site keys | **forever** allow-list; persists across restarts until removed in Settings or "Lock now" |
| `sessionDomains` | `chrome.storage.session` | `string[]` of site keys | **this-session** allow-list; auto-cleared when the browser fully closes |

A navigation is allowed if its site key is in **either** list. "Lock everything
now" clears both; the Settings page can remove individual forever-sites.

### Messaging API (background `onMessage`)
- `{ type: 'unlock', domain, url, password }` → `{ ok: boolean }`. Verifies hash;
  on success adds domain, persists, navigates the sender's tab.
- `{ type: 'lockNow' }` → `{ ok: true }`. Clears the allow-list immediately.
- `{ type: 'getStatus' }` → `{ count, domains, hasPassword }`. Used by the popup.

### Password hashing
`crypto.subtle.digest('SHA-256', …)` → hex string. Implemented as `sha256()` in
both `background.js` (verify) and `options.js` (set/change). Change-password
requires re-entering the current password (hash compare) before updating.

---

## Screens / Views

### 1. Lock screen — `locked.html` / `.css` / `.js`
- **Purpose:** shown when a child hits a not-yet-unlocked site; a parent types
  the password to open it.
- **Layout:** full-viewport takeover. Fixed ambient `.scene` layer (z-index 1):
  a radial **sun** centered near the top, two `<path>` **hills** along the
  bottom (38% height), and three drifting **clouds**. Centered content column
  `.stage` (z-index 2, max-width 460px): Pip mascot → `h1` → subtitle →
  domain chip → password form.
- **Components:**
  - **Pip** — the 212 mascot, inline SVG (`viewBox -50 -52 100 104`), orange
    gradient body (`#F2683C` → `rgb(244,131,95)` top stop), ear tufts, cheek
    highlights, eyes with white catchlights, a smile, and a waving arm.
    Animations: `pipBob` (2.6s translateY ±6px) on the body group, `pipWave`
    (0.9s rotate −12°→22°, `transform-origin: 40px 6px`) on the arm. Wrapped in
    `drop-shadow(0 14px 24px rgba(0,0,0,.18))`.
  - **Heading** "This one's locked" — Baloo 2 800, `clamp(32px,5vw,48px)`,
    letter-spacing −.02em, ink `#2A2018`.
  - **Subtitle** "Ask a grown-up to open it for you." — Nunito 600,
    `clamp(17px,2.2vw,21px)`, `rgba(42,32,24,.6)`.
  - **Domain chip** — `inline-flex`, `rgba(255,255,255,.65)` bg, radius 999,
    padding 12×24, shadow `0 6px 18px rgba(60,38,20,.12)`. A small padlock SVG
    (stroke 2.4, currentColor) + the base domain in Baloo 2 600/19px
    (`white-space: nowrap`). `#domain` text is set from the `domain` query param.
  - **Password input** `#pw` — white pill, radius 999, Nunito 700/19px, centered
    text, padding 16×20, shadow `0 6px 18px rgba(60,38,20,.12)`; focus ring
    `0 0 0 4px rgba(242,104,60,.25)`. `type=password`, autofocused.
  - **Unlock button** — Baloo 2 700/21px, white text, pill, gradient
    `linear-gradient(150deg,#F2683C,#E0673C)`, shadow
    `0 8px 22px rgba(224,103,60,.42)`; `:active` scale .98.
  - **Error** `#error` — Nunito 700/15px, `#C0392B`, `role="alert"`.
- **States:**
  - Wrong password → `.shake` animation (0.42s) on `#card`, error message,
    field cleared and refocused.
  - Correct password → body gets `.unlocking` (stage fades to .55, pointer
    events off) while the worker navigates the tab away.
  - `prefers-reduced-motion` disables Pip bob/wave and cloud drift.

### 2. Options / setup — `options.html` / `options.js`
- **Purpose:** create the password on first run; change it later.
- **Layout:** centered white card (max-width 480, radius 22, shadow
  `0 6px 18px rgba(60,38,20,.10)`) on the Cream `#FBF3E7` background. Brand row:
  a 52×52 rounded-16 **212 logo tile** (orange gradient, rotated −6°, white
  "212" in Baloo 2 800) + "WhitelistWeb" heading + tagline.
- **Two sections, toggled by whether a password exists:**
  - `#setup` (no password yet): New + Confirm fields, "Save password" button.
    Validation: ≥4 chars and the two fields must match.
  - `#change` (password exists): Current + New + Confirm; current must verify
    against the stored hash, new ≥4 chars and matching.
- **Components:** labels in Baloo 2 600/14px muted; inputs radius 14, 2px
  `#F0E6D6` border, focus border `#F2683C` + ring; primary button identical to
  the lock-screen Unlock button. Status line `#msg` is teal `#1C9B8E` on success,
  `#C0392B` on error.

### 3. Popup — `popup.html` / `popup.js`
- **Purpose:** at-a-glance status + quick lock.
- **Layout:** 268px wide, Cream bg. Brand row (small 34px 212 tile + name). A
  white status card showing the **count** of unlocked domains (Baloo 2 800/34px,
  orange) and "N site(s) are unlocked this session". Below: a **"Lock everything
  now"** button (clears the allow-list via `lockNow`; momentarily shows
  "Locked ✓") and a "Settings & password" link (`chrome.runtime.openOptionsPage`).
  A `#nopw` notice appears if no password is set yet.

---

## Interactions & behavior summary
- **Navigation guard:** main-frame `http(s)` navigations to non-allowed base
  domains are redirected to the lock screen before render.
- **Unlock:** correct password → domain added to session allow-list → tab
  navigates to the original URL. Per-site, per-session.
- **Lock now:** clears all unlocked domains immediately; next click on any site
  re-prompts.
- **Session reset:** closing the browser clears `chrome.storage.session`, so the
  child starts fresh-locked every session.
- **Motion:** Pip bob/wave, cloud drift, wrong-password shake; all respect
  `prefers-reduced-motion`.

## State management
- In-memory (service worker): `allowSet: Set<string>`, `passwordHash: string|null`,
  `cacheReady: boolean`.
- Persisted: `passwordHash` (local), `unlockedDomains` (session) — see storage
  table above.
- No framework, no store library; state lives in the worker + `chrome.storage`.

---

## Design Tokens (212video system)

### Colors
| Token | Hex | Use |
|---|---|---|
| Cream (bg) | `#FBF3E7` | options/popup background |
| Ink | `#2A2018` | primary text |
| Muted ink | `#8A7A6A` | secondary text / labels |
| Faint ink | `#A89684` | placeholders |
| Surface | `#FFFFFF` | cards, pills, input |
| Primary orange | `#F2683C` → `#E0673C` | logo, buttons, Pip, accents |
| Teal (success) | `#1C9B8E` | options success message |
| Error red | `#C0392B` | error text |
| Lock-screen sky | `linear-gradient(180deg,#FFE9C7,#FFD7B0 55%,#FFC79A)` | takeover bg |
| Sun | `radial-gradient(circle,#FFF1C2,#FFD06A)` | scene |
| Hills | `#9DBE86`, `#86AC72` | scene |
| Pip top stop | `rgb(244,131,95)` | = `tint(#F2683C, 0.18)` |

### Typography
- **Display / headings / buttons:** **Baloo 2** (500–800).
- **Body / labels / meta:** **Nunito** (600–800).
- Lock heading `clamp(32px,5vw,48px)/800`, letter-spacing −.02em; subtitle
  `clamp(17px,2.2vw,21px)/600`; chip/input/button 19–21px; meta ~14px.

### Shape / shadow / motion
- Radii: cards **22**, logo tile **16**, pills/buttons/input **999**,
  options input **14**.
- Shadows: card rest `0 6px 18px rgba(60,38,20,.10)`; chip
  `0 6px 18px rgba(60,38,20,.12)`; primary button
  `0 8px 22px rgba(224,103,60,.42)`.
- Keyframes (from 212): `pipBob` 2.6s, `pipWave` 0.9s, `cloudFloat` 9s; plus a
  local `shake` 0.42s. All gated by `prefers-reduced-motion`.

---

## Assets
- **Fonts:** Baloo 2 + Nunito, loaded from **Google Fonts** via `<link>` in each
  HTML page (matches how the 212video app loads them). Rounded system fallback
  if offline. To make the extension fully self-contained/offline, self-host the
  woff2 files and swap the `<link>` for an `@font-face` block — no other change
  needed.
- **Pip mascot:** inline SVG, recreated from the 212video prototype's `Pip`
  component (`design_handoff_212_ui/ui.jsx`). Moods available there:
  happy / wave / sleepy / yawn — this extension uses **wave**.
- **Icons:** `icons/icon{16,48,128}.png`, a generated orange padlock on the
  212-orange gradient tile. Replace with your own brand icon if desired.
- **No other external assets, no CDNs beyond Google Fonts.**

---

## Loading & first-run (for testing)
1. `chrome://extensions` → enable **Developer mode** (top-right).
2. **Load unpacked** → select the `WhitelistWeb` folder.
3. The options page opens automatically — set the password (confirm field).
4. Browse: any new site (full hostname, `www.` aside) shows the lock screen
   until the password is entered. Choose **Allow forever** or **Just this time**;
   forever-sites persist across restarts, session-sites clear on browser close.

## Suggested next steps for a developer
- **Offline fonts:** self-host Baloo 2 + Nunito (removes the Google Fonts
  dependency on the kiosk/lock screen).
- **Subdomain policy:** matching is per-hostname (`getSiteKey()`, `www.`
  stripped). If you later want optional "unlock the whole domain" behavior,
  reintroduce an eTLD+1 reduction behind a setting.
- **Hardening (if needed):** combine with `declarativeNetRequest` static rules
  to eliminate the wake-up flash, keeping the password flow for the unlock step.
- **Tab coverage:** currently guards top-level navigations; consider also
  handling `chrome.tabs.onUpdated` for SPA in-place URL changes if you find
  sites that route client-side past the hostname check.
