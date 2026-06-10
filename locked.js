/* WhitelistWeb — lock screen logic */

const params = new URLSearchParams(location.search);
const domain = params.get('domain') || '';
const targetUrl = params.get('url') || '';

const domainEl = document.getElementById('domain');
const input = document.getElementById('pw');
const form = document.getElementById('form');
const errorEl = document.getElementById('error');
const card = document.getElementById('card');

domainEl.textContent = domain || 'this site';
document.title = 'Locked — ' + (domain || 'site');

// Autofocus (the autofocus attribute can be unreliable on a freshly-redirected tab)
window.addEventListener('load', () => input.focus());
input.focus();

function shake() {
  card.classList.remove('shake');
  // force reflow so the animation can re-trigger
  void card.offsetWidth;
  card.classList.add('shake');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';

  const password = input.value;
  if (!password) {
    shake();
    input.focus();
    return;
  }

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'unlock',
      domain,
      url: targetUrl,
      password
    });
  } catch (err) {
    res = null;
  }

  if (res && res.ok) {
    // The background service worker navigates this tab to the original URL.
    // Show a brief confirming state in case the navigation takes a moment.
    document.body.classList.add('unlocking');
    errorEl.textContent = '';
  } else {
    shake();
    errorEl.textContent = 'Wrong password. Try again.';
    input.value = '';
    input.focus();
  }
});
