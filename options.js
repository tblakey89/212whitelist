/* WhitelistWeb — options / setup page */

const PW_KEY = 'passwordHash';

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const msgEl = document.getElementById('msg');
function msg(text, ok) {
  msgEl.textContent = text;
  msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
}

async function getStoredHash() {
  const data = await chrome.storage.local.get(PW_KEY);
  return data[PW_KEY] || null;
}

// Show the right section depending on whether a password already exists.
async function render() {
  const hash = await getStoredHash();
  document.getElementById('setup').hidden = !!hash;
  document.getElementById('change').hidden = !hash;
}

// --- First-time setup ---
document.getElementById('saveNew').addEventListener('click', async () => {
  const a = document.getElementById('new1').value;
  const b = document.getElementById('new2').value;
  if (a.length < 4) return msg('Use at least 4 characters.', false);
  if (a !== b) return msg('Passwords do not match.', false);

  await chrome.storage.local.set({ [PW_KEY]: await sha256(a) });
  document.getElementById('new1').value = '';
  document.getElementById('new2').value = '';
  msg('Password set! Browsing is now protected.', true);
  setTimeout(render, 400);
});

// --- Change existing password ---
document.getElementById('saveChange').addEventListener('click', async () => {
  const cur = document.getElementById('current').value;
  const a = document.getElementById('chg1').value;
  const b = document.getElementById('chg2').value;

  const hash = await getStoredHash();
  if (!hash || (await sha256(cur)) !== hash) {
    return msg('Current password is incorrect.', false);
  }
  if (a.length < 4) return msg('New password must be at least 4 characters.', false);
  if (a !== b) return msg('New passwords do not match.', false);

  await chrome.storage.local.set({ [PW_KEY]: await sha256(a) });
  ['current', 'chg1', 'chg2'].forEach(id => { document.getElementById(id).value = ''; });
  msg('Password updated.', true);
});

render();
