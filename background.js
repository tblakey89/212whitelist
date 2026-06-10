/* WhitelistWeb — MV3 service worker
 *
 * Responsibilities:
 *   - Intercept top-level navigations and redirect to a lock screen
 *     unless the destination's base domain is already unlocked this session.
 *   - Verify the password (SHA-256 hash compare) and manage the session
 *     allow-list when the lock screen asks to unlock a site.
 *   - Clear the allow-list on demand ("Lock now").
 *   - Steer the parent to the setup page when no password exists yet.
 *
 * Security note: this is deliberately simple. It stops an 8-year-old, not a
 * determined adult. The password is stored only as a SHA-256 hash; no plaintext.
 */

// ---- Storage keys -------------------------------------------------------
const PW_KEY = 'passwordHash';        // chrome.storage.local  -> string (hex sha256)
const ALLOW_KEY = 'unlockedDomains';  // chrome.storage.session -> string[]

// ---- In-memory cache (fast path so the redirect happens early) ----------
let allowSet = new Set();
let passwordHash = null;
let cacheReady = false;

// Common compound public suffixes, so "foo.co.uk" groups as "foo.co.uk"
// (its eTLD+1) instead of collapsing to "co.uk". Not exhaustive, but covers
// the suffixes a kid is realistically going to hit.
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk', 'sch.uk', 'ltd.uk',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in',
  'co.za', 'org.za', 'net.za',
  'com.mx', 'com.sg', 'com.hk', 'com.tw', 'com.tr', 'com.ar',
  'com.pl', 'com.ua', 'com.sa', 'com.eg', 'com.ph', 'com.my', 'com.vn',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.id', 'co.th', 'co.il', 'org.il', 'net.il'
]);

// ---- Helpers ------------------------------------------------------------

// Reduce a hostname to its base domain (eTLD+1). e.g.
//   m.youtube.com  -> youtube.com
//   www.bbc.co.uk  -> bbc.co.uk
function getBaseDomain(hostname) {
  let host = (hostname || '').toLowerCase().replace(/\.+$/, '');
  if (!host) return '';
  if (host === 'localhost') return host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host; // IPv4 literal
  if (host.includes(':')) return host;                   // IPv6-ish literal

  const parts = host.split('.');
  if (parts.length <= 2) return host;

  const last2 = parts.slice(-2).join('.');
  if (MULTI_SUFFIXES.has(last2)) return parts.slice(-3).join('.');
  return last2;
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
    chrome.storage.local.get(PW_KEY),
    chrome.storage.session.get(ALLOW_KEY)
  ]);
  passwordHash = localData[PW_KEY] || null;
  allowSet = new Set(sessionData[ALLOW_KEY] || []);
  cacheReady = true;
}

// Warm the cache as soon as the worker spins up.
loadCache();

// Keep the in-memory cache in sync if storage changes elsewhere.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PW_KEY]) {
    passwordHash = changes[PW_KEY].newValue || null;
  }
  if (area === 'session' && changes[ALLOW_KEY]) {
    allowSet = new Set(changes[ALLOW_KEY].newValue || []);
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

  const domain = getBaseDomain(new URL(url).hostname);
  if (!domain || allowSet.has(domain)) return; // allowed this session

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
        allowSet.add(msg.domain);
        await chrome.storage.session.set({ [ALLOW_KEY]: [...allowSet] });
        const tabId = sender.tab && sender.tab.id;
        if (tabId != null) chrome.tabs.update(tabId, { url: msg.url });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
      return;
    }

    if (msg && msg.type === 'lockNow') {
      allowSet = new Set();
      await chrome.storage.session.set({ [ALLOW_KEY]: [] });
      sendResponse({ ok: true });
      return;
    }

    if (msg && msg.type === 'getStatus') {
      sendResponse({
        count: allowSet.size,
        domains: [...allowSet],
        hasPassword: !!passwordHash
      });
      return;
    }

    sendResponse({ ok: false, error: 'unknown message' });
  })();

  return true; // keep the message channel open for the async response
});
