// "Use Publik models": Publik's sign-in gate as a modal. The gate itself runs in the server
// (src/publik.js, which holds the key); this shows its screens, presses its buttons, and opens the
// links it asks for (sign in, get a plan) in a new tab. onDone runs once the gate is finished or
// cancelled.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function openPublikGate({ api, onDone }) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = '<div class="modal"></div>';
  document.body.appendChild(bg);
  const modal = bg.firstElementChild;
  let timer, last = '', ended = false;
  let cur = null, link = '', linkOn = null; // the fallback link belongs to the screen it was opened from

  const finish = async (cancel) => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    bg.remove();
    if (cancel) await api('/api/publik/cancel', { method: 'POST' }).catch(() => {});
    onDone?.();
  };
  const render = (st, err = '') => {
    if (st.state !== 'gate') return finish(false);
    const s = st.screen;
    if (s) cur = s.id;
    if (s && s.id !== linkOn) link = '';
    const key = JSON.stringify([s, err, link]);
    if (key === last) return; // polling: redraw only on change
    last = key;
    modal.innerHTML = `<h2>${esc(s?.title || 'Use Publik models')}</h2>
      <p>${s ? esc(s.body) : 'Checking with Publik…'}</p>
      ${s?.note ? `<p class="faint">${esc(s.note)}</p>` : ''}
      ${link ? `<p class="faint">Nothing opened? <a href="${esc(link)}" target="_blank" rel="noopener">Open Publik</a></p>` : ''}
      <div class="error">${esc(err)}</div>
      <div class="modal-actions"><button data-esc data-cancel>Cancel</button>${(s?.buttons || []).map((b, i) =>
        `<button data-action="${esc(b.action)}"${i === 0 ? ' class="primary"' : ''}>${esc(b.label)}</button>`).join('')}</div>`;
  };

  modal.addEventListener('click', async (e) => {
    if (e.target.closest('[data-cancel]')) return finish(true);
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const a = btn.dataset.action, from = cur;
    // Open the tab inside the click, or a popup blocker eats it; it's pointed at the link after.
    const tab = a === 'sign_in' || a === 'get_plan' ? window.open('', '_blank') : null;
    btn.disabled = true;
    try {
      const st = await api('/api/publik/action', { method: 'POST', body: JSON.stringify({ action: a }) });
      if (st.open_url) {
        link = st.open_url; linkOn = from;
        if (tab) { tab.opener = null; tab.location = st.open_url; }
      } else tab?.close();
      render(st);
    } catch (err) {
      tab?.close();
      btn.disabled = false;
      modal.querySelector('.error').textContent = err.message;
    }
  });

  const poll = () => api('/api/publik').then((st) => !ended && render(st), () => {});
  api('/api/publik/start', { method: 'POST' })
    .then((st) => { render(st); timer = setInterval(poll, 2000); })
    .catch((err) => render({ state: 'gate', screen: null }, err.message));
}
