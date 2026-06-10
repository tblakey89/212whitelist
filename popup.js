/* WhitelistWeb — toolbar popup */

const countEl = document.getElementById('count');
const wordEl = document.getElementById('word');
const nopwEl = document.getElementById('nopw');
const lockBtn = document.getElementById('lock');

async function refresh() {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'getStatus' });
  } catch (e) {
    res = { count: 0, hasPassword: true };
  }
  const count = (res && res.count) || 0;
  countEl.textContent = count;
  wordEl.textContent = count === 1 ? 'site is' : 'sites are';
  nopwEl.hidden = !(res && res.hasPassword === false);
}

lockBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'lockNow' });
  await refresh();
  lockBtn.textContent = 'Locked \u2713';
  setTimeout(() => { lockBtn.textContent = 'Lock everything now'; }, 1200);
});

document.getElementById('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh();
