/**
 * The inspector's browser assets, kept as string constants so the server needs no static-file
 * plugin and the image needs no bundled front-end.
 *
 * `INSPECTOR_JS` is served from its own route (`/app.js`) so the Content-Security-Policy can stay
 * `script-src 'self'` with no inline-script exception. It builds the DOM with `textContent` only —
 * never `innerHTML` — so a stored value that happens to contain markup is shown as text and can
 * never execute.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Autocosm · Storage Inspector</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0b0f14; color: #d7dde5;
  }
  header {
    padding: 12px 18px; border-bottom: 1px solid #1e2733;
    display: flex; align-items: center; gap: 12px; position: sticky; top: 0; background: #0b0f14; z-index: 2;
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .02em; }
  header .tag { font-size: 11px; color: #7d8aa0; border: 1px solid #26313f; border-radius: 999px; padding: 1px 8px; }
  header #user:empty { display: none; }
  header #user { color: #9fb3c8; }
  .spacer { flex: 1; }
  .switch { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #b7c1d0; cursor: pointer; user-select: none; }
  .switch input { accent-color: #d98b2b; width: 14px; height: 14px; margin: 0; }
  #io-status { font-size: 11px; color: #7d8aa0; min-width: 2ch; }
  main { display: grid; grid-template-columns: 220px 1fr; min-height: calc(100vh - 49px); }
  nav { border-right: 1px solid #1e2733; padding: 12px; overflow-y: auto; }
  nav button {
    display: block; width: 100%; text-align: left; margin: 0 0 4px; padding: 6px 10px;
    background: transparent; color: #b7c1d0; border: 1px solid transparent; border-radius: 6px; cursor: pointer;
    font: inherit;
  }
  nav button:hover { background: #131a22; }
  nav button.active { background: #16202b; border-color: #2a3a4c; color: #eaf0f7; }
  section { padding: 16px 18px; overflow-x: auto; }
  .bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .bar h2 { font-size: 14px; margin: 0; color: #eaf0f7; }
  .muted { color: #7d8aa0; font-size: 12px; }
  .banner { background: #2a1417; border: 1px solid #5b2530; color: #f3b9c1; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; }
  .row { border: 1px solid #1e2733; border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
  .row .keys { display: flex; gap: 16px; padding: 8px 12px; background: #101720; flex-wrap: wrap; }
  .row .keys span { font-size: 12px; }
  .row .keys b { color: #8fb3ff; font-weight: 600; }
  .row pre { margin: 0; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; color: #cfe6d4; font-size: 12.5px; }
  button.more {
    margin-top: 4px; padding: 8px 14px; background: #16202b; color: #eaf0f7;
    border: 1px solid #2a3a4c; border-radius: 6px; cursor: pointer; font: inherit;
  }
  button.more[disabled] { opacity: .5; cursor: default; }
  .empty { color: #7d8aa0; padding: 24px 0; }
</style>
</head>
<body>
<header>
  <h1>Autocosm · Storage Inspector</h1>
  <span class="tag">read-only data</span>
  <span class="tag" id="world"></span>
  <span class="tag" id="user"></span>
  <span class="spacer"></span>
  <label class="switch" title="When on, the think job writes raw Azure OpenAI request/response bodies to its logs. Debug only; applies on the next think run.">
    <input type="checkbox" id="io" />
    <span>Log OpenAI I/O</span>
  </label>
  <span id="io-status"></span>
</header>
<main>
  <nav id="tables" aria-label="Tables"></nav>
  <section id="content">
    <p class="empty">Select a table to inspect its rows.</p>
  </section>
</main>
<script src="/app.js"></script>
</body>
</html>`;

export const INSPECTOR_JS = String.raw`(() => {
  'use strict';
  const nav = document.getElementById('tables');
  const content = document.getElementById('content');
  let current = null;
  let continuation = null;

  const el = (tag, props, ...kids) => {
    const node = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const kid of kids) node.append(kid);
    return node;
  };

  const banner = (message) => {
    const b = el('div', { class: 'banner', text: message });
    content.prepend(b);
  };

  async function getJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const code = body && body.error ? body.error.code + ': ' + body.error.message : 'HTTP ' + res.status;
      throw new Error(code);
    }
    return body;
  }

  function renderRow(row) {
    const keys = el('div', { class: 'keys' },
      el('span', {}, el('b', { text: 'PK ' }), el('span', { text: String(row.partitionKey ?? '') })),
      el('span', {}, el('b', { text: 'RK ' }), el('span', { text: String(row.rowKey ?? '') })),
    );
    if (row.rv !== undefined) keys.append(el('span', {}, el('b', { text: 'rv ' }), el('span', { text: String(row.rv) })));
    if (row.timestamp) keys.append(el('span', { class: 'muted', text: row.timestamp }));
    const payload = row.record !== undefined ? row.record : row.raw;
    const pre = el('pre', { text: JSON.stringify(payload, null, 2) });
    return el('div', { class: 'row' }, keys, pre);
  }

  async function loadPage(table, token) {
    const q = new URLSearchParams();
    if (token) q.set('continuation', token);
    const page = await getJson('/api/tables/' + encodeURIComponent(table) + (q.toString() ? '?' + q : ''));
    continuation = page.continuation || null;
    const list = document.getElementById('rows');
    if (page.rows.length === 0 && !list.hasChildNodes()) {
      list.append(el('p', { class: 'empty', text: 'This table is empty.' }));
    }
    for (const row of page.rows) list.append(renderRow(row));
    const count = document.getElementById('count');
    count.textContent = list.querySelectorAll('.row').length + ' row(s)' + (continuation ? ' (more available)' : '');
    const more = document.getElementById('more');
    more.disabled = !continuation;
    more.style.display = continuation ? 'inline-block' : 'none';
  }

  async function selectTable(table, button) {
    current = table;
    continuation = null;
    for (const b of nav.querySelectorAll('button')) b.classList.toggle('active', b === button);
    content.replaceChildren();
    const bar = el('div', { class: 'bar' },
      el('h2', { text: table }),
      el('span', { class: 'muted', id: 'count', text: 'loading…' }),
    );
    const more = el('button', { class: 'more', id: 'more', text: 'Load more' });
    more.style.display = 'none';
    more.addEventListener('click', () => {
      more.disabled = true;
      loadPage(current, continuation).catch((e) => banner(e.message));
    });
    content.append(bar, el('div', { id: 'rows' }), more);
    try { await loadPage(table, null); } catch (e) { banner(e.message); }
  }

  async function init() {
    try {
      const health = await getJson('/api/health').catch(() => null);
      const worldTag = document.getElementById('world');
      if (health && health.version) worldTag.textContent = 'v' + health.version;
      const { tables } = await getJson('/api/tables');
      for (const table of tables) {
        const button = el('button', { text: table });
        button.addEventListener('click', () => selectTable(table, button).catch((e) => banner(e.message)));
        nav.append(button);
      }
    } catch (e) {
      banner('Could not load tables: ' + e.message);
    }
  }

  async function initControls() {
    const me = await getJson('/api/me').catch(() => null);
    if (me && me.user) document.getElementById('user').textContent = me.user;
    const io = document.getElementById('io');
    const ioStatus = document.getElementById('io-status');
    const refreshIo = async () => {
      try {
        const s = await getJson('/api/settings');
        io.checked = !!s.logOpenAiIo;
        ioStatus.textContent = io.checked ? 'on' : 'off';
      } catch {
        ioStatus.textContent = '—';
      }
    };
    io.addEventListener('change', async () => {
      io.disabled = true;
      ioStatus.textContent = 'saving…';
      try {
        const res = await fetch('/api/settings/openai-logging', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: io.checked }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const body = await res.json();
        io.checked = !!body.logOpenAiIo;
        ioStatus.textContent = (io.checked ? 'on' : 'off') + ' · applies next think run';
      } catch (e) {
        banner('Could not update logging: ' + e.message);
        await refreshIo();
      } finally {
        io.disabled = false;
      }
    });
    await refreshIo();
  }

  init();
  initControls().catch(() => {});
})();`;
