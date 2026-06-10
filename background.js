/* WhitelistWeb — MV3 service worker
 *
 * Responsibilities:
 *   - Intercept top-level navigations and redirect to a lock screen unless the
 *     destination's site key (full hostname, www stripped) is already unlocked,
 *     either forever (chrome.storage.local) or for this session (chrome.storage.session).
 *   - Verify the password (SHA-256 hash compare) and add the site to the chosen
 *     allow-list when the lock screen asks to unlock it.
 *   - Clear both allow-lists on demand ("Lock now"); forget a single forever-site.
 *   - Steer the parent to the setup page when no password exists yet.
 *
 * Security note: this is deliberately simple. It stops an 8-year-old, not a
 * determined adult. The password is stored only as a SHA-256 hash; no plaintext.
 */

// ---- Storage keys -------------------------------------------------------
const PW_KEY = 'passwordHash';        // chrome.storage.local  -> string (hex sha256)
const ALLOW_KEY = 'unlockedDomains';  // chrome.storage.local   -> string[] (forever)
const SESSION_KEY = 'sessionDomains'; // chrome.storage.session -> string[] (this session only)

// ---- In-memory cache (fast path so the redirect happens early) ----------
let allowSet = new Set();    // forever (local)
let sessionSet = new Set();  // this session only (session)
let passwordHash = null;
let cacheReady = false;

// ---- Helpers ------------------------------------------------------------

// The key we unlock against is the FULL hostname, so each subdomain is its own
// site (kids.youtube.com is separate from youtube.com). The only exception is a
// leading "www." — it's treated as the bare domain so that the common
// "youtube.com -> www.youtube.com" redirect doesn't re-lock the page you just
// approved. e.g.
//   youtube.com       -> youtube.com
//   www.youtube.com   -> youtube.com   (www stripped)
//   m.youtube.com     -> m.youtube.com (separate site)
//   kids.youtube.com  -> kids.youtube.com (separate site)
function getSiteKey(hostname) {
  let host = (hostname || '').toLowerCase().replace(/\.+$/, '');
  if (!host) return '';
  if (host === 'localhost') return host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host; // IPv4 literal
  if (host.includes(':')) return host;                   // IPv6-ish literal
  return host.replace(/^www\./, '');                     // www. == bare domain
}

// Only guard real web pages. Everything else (chrome://, chrome-extension://,
// about:, the new-tab page, file:, data:, etc.) is left alone — this also means
// the extension never blocks its own pages, since they are chrome-extension://.
function shouldGuard(url) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  return u.protocol === 'http:' || u.protocol === 'https:';
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function loadCache() {
  const [localData, sessionData] = await Promise.all([
    chrome.storage.local.get([PW_KEY, ALLOW_KEY]),
    chrome.storage.session.get(SESSION_KEY)
  ]);
  passwordHash = localData[PW_KEY] || null;
  allowSet = new Set(localData[ALLOW_KEY] || []);
  sessionSet = new Set(sessionData[SESSION_KEY] || []);
  cacheReady = true;
}

// Warm the cache as soon as the worker spins up.
loadCache();

// Keep the in-memory cache in sync if storage changes elsewhere.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PW_KEY]) {
    passwordHash = changes[PW_KEY].newValue || null;
  }
  if (area === 'local' && changes[ALLOW_KEY]) {
    allowSet = new Set(changes[ALLOW_KEY].newValue || []);
  }
  if (area === 'session' && changes[SESSION_KEY]) {
    sessionSet = new Set(changes[SESSION_KEY].newValue || []);
  }
});

// ---- Navigation interception -------------------------------------------

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  // Main frame only. Sub-frames/iframes are ignored.
  if (details.frameId !== 0) return;

  const { tabId, url } = details;
  if (!shouldGuard(url)) return;

  if (!cacheReady) await loadCache();

  // No password configured yet -> we have nothing to unlock against, which
  // would trap the child on an un-unlockable screen. Instead, send the parent
  // to the setup page so they can create a password.
  if (!passwordHash) {
    chrome.tabs.update(tabId, { url: chrome.runtime.getURL('options.html?setup=1') });
    return;
  }

  const domain = getSiteKey(new URL(url).hostname);
  if (!domain || allowSet.has(domain) || sessionSet.has(domain)) return; // allowed forever or this session

  // Block: redirect the tab to the lock screen before the real page renders.
  const locked = chrome.runtime.getURL('locked.html')
    + '?domain=' + encodeURIComponent(domain)
    + '&url=' + encodeURIComponent(url);
  chrome.tabs.update(tabId, { url: locked });
});

// ---- First-run setup ----------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await loadCache();
  if (!passwordHash) chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(loadCache);

// ---- Messages from lock screen / popup ----------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!cacheReady) await loadCache();

    if (msg && msg.type === 'unlock') {
      // Verify against the stored hash, then unlock the site for this session
      // and navigate the tab to the originally requested URL.
      const ok = !!passwordHash && (await sha256(msg.password || '')) === passwordHash;
      if (ok && shouldGuard(msg.url)) {
        if (msg.scope === 'session') {
          // "Just this time" — clears when the browser fully closes.
          sessionSet.add(msg.domain);
          await chrome.storage.session.set({ [SESSION_KEY]: [...sessionSet] });
        } else {
          // "Allow forever" — persists until removed in Settings or "Lock now".
          allowSet.add(msg.domain);
          await chrome.storage.local.set({ [ALLOW_KEY]: [...allowSet] });
        }
        const tabId = sender.tab && sender.tab.id;
        if (tabId != null) chrome.tabs.update(tabId, { url: msg.url });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
      return;
    }

    if (msg && msg.type === 'lockNow') {
      // Full reset: wipe both the forever list and the session list.
      allowSet = new Set();
      sessionSet = new Set();
      await Promise.all([
        chrome.storage.local.set({ [ALLOW_KEY]: [] }),
        chrome.storage.session.set({ [SESSION_KEY]: [] })
      ]);
      sendResponse({ ok: true });
      return;
    }

    // Remove a single "forever" site (used by the Settings list).
    if (msg && msg.type === 'forget') {
      allowSet.delete(msg.domain);
      await chrome.storage.local.set({ [ALLOW_KEY]: [...allowSet] });
      sendResponse({ ok: true });
      return;
    }

    if (msg && msg.type === 'getStatus') {
      sendResponse({
        permanent: [...allowSet],
        session: [...sessionSet],
        count: allowSet.size + sessionSet.size,
        hasPassword: !!passwordHash
      });
      return;
    }

    sendResponse({ ok: false, error: 'unknown message' });
  })();

  return true; // keep the message channel open for the async response
});
