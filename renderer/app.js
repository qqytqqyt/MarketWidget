'use strict';

const QUOTE_INTERVAL = 10_000;
const SPARK_INTERVAL = 5 * 60_000;

const state = {
  watchlist: [],
  quotes: new Map(), // symbol -> merged quote
  sparks: new Map(), // symbol -> { closes, prevClose }
  cards: new Map(),  // symbol -> card element
  pinned: true,
  lastPrices: new Map(),
};

const $ = (id) => document.getElementById(id);
const listEl = $('list');

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function fmtPrice(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 1 ? 2 : a >= 0.1 ? 3 : 4;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

// ---------------------------------------------------------------------------
// Session selection
// ---------------------------------------------------------------------------
function primarySession(q) {
  if (q.overnight) {
    return { key: 'overnight', label: 'Overnight', cls: 'overnight', data: q.overnight };
  }
  if (q.marketState === 'PRE' && q.pre) {
    return { key: 'pre', label: 'Pre-Market', cls: 'pre', data: q.pre };
  }
  if (q.marketState === 'REGULAR' && q.regular) {
    return { key: 'regular', label: 'Live', cls: 'live', data: q.regular };
  }
  if (q.post && ['POST', 'POSTPOST', 'PREPRE', 'CLOSED', null].includes(q.marketState)) {
    return { key: 'post', label: 'After Hours', cls: 'post', data: q.post };
  }
  return { key: 'closed', label: 'Closed', cls: 'closed', data: q.regular ?? {} };
}

function secondaryEntries(q, primary) {
  const out = [];
  if (primary.key === 'overnight' && q.post) {
    out.push({ label: 'AH', price: q.post.price, pct: null });
  }
  if (primary.key !== 'regular' && primary.key !== 'closed' && q.regular) {
    out.push({ label: 'Close', price: q.regular.price, pct: q.regular.changePct });
  }
  if ((primary.key === 'regular' || primary.key === 'closed') && q.exchange) {
    out.push({ label: '', text: q.exchange });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Card rendering (keyed, updated in place)
// ---------------------------------------------------------------------------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function buildCard(symbol) {
  const card = el('div', 'card');
  card.dataset.symbol = symbol;

  const topLeft = el('div', 'top-left');
  topLeft.append(el('span', 'sym', symbol), el('span', 'chip closed', '—'));

  const topRight = el('div', 'top-right');
  topRight.append(el('span', 'price', '—'), el('span', 'pill flat', ''));

  const botLeft = el('div', 'bot-left');
  const canvas = el('canvas', 'spark');
  canvas.width = 64;
  canvas.height = 22;
  botLeft.append(el('span', 'nm', ''), canvas);

  const botRight = el('div', 'bot-right');

  const removeBtn = el('button', 'remove-btn');
  removeBtn.title = `Remove ${symbol}`;
  removeBtn.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  removeBtn.addEventListener('click', () => removeSymbol(symbol));

  card.append(topLeft, topRight, botLeft, botRight, removeBtn);
  return card;
}

function updateCard(symbol) {
  const card = state.cards.get(symbol);
  if (!card) return;
  const q = state.quotes.get(symbol);

  const chip = card.querySelector('.chip');
  const priceEl = card.querySelector('.price');
  const pill = card.querySelector('.pill');
  const nm = card.querySelector('.nm');
  const botRight = card.querySelector('.bot-right');

  if (!q) {
    nm.textContent = 'Loading…';
    return;
  }

  const p = primarySession(q);
  chip.textContent = p.label;
  chip.className = `chip ${p.cls}`;
  nm.textContent = q.name;

  const price = p.data.price ?? q.regular?.price;
  priceEl.textContent = fmtPrice(price);

  // flash on tick
  const prev = state.lastPrices.get(symbol);
  if (prev != null && price != null && price !== prev) {
    priceEl.classList.remove('tick-up', 'tick-down');
    void priceEl.offsetWidth;
    priceEl.classList.add(price > prev ? 'tick-up' : 'tick-down');
    setTimeout(() => priceEl.classList.remove('tick-up', 'tick-down'), 900);
  }
  if (price != null) state.lastPrices.set(symbol, price);

  const pct = p.key === 'closed' ? q.regular?.changePct : p.data.changePct;
  pill.textContent = fmtPct(pct) || '—';
  pill.className = `pill ${pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'}`;

  botRight.replaceChildren();
  for (const s of secondaryEntries(q, p)) {
    if (s.text != null) {
      botRight.append(el('span', 'lbl', s.text));
      continue;
    }
    botRight.append(el('span', 'lbl', s.label));
    botRight.append(el('span', null, fmtPrice(s.price)));
    if (s.pct != null) {
      botRight.append(el('span', s.pct >= 0 ? 'up' : 'down', fmtPct(s.pct)));
    }
  }

  drawSpark(card.querySelector('.spark'), state.sparks.get(symbol));
}

function drawSpark(canvas, spark) {
  const dpr = window.devicePixelRatio || 1;
  const w = 64, h = 22;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!spark || !spark.closes || spark.closes.length < 2) return;

  const { closes, prevClose } = spark;
  const min = Math.min(...closes, prevClose ?? Infinity);
  const max = Math.max(...closes, prevClose ?? -Infinity);
  const range = max - min || 1;
  const x = (i) => (i / (closes.length - 1)) * (w - 2) + 1;
  const y = (v) => h - 2 - ((v - min) / range) * (h - 4);

  const up = closes[closes.length - 1] >= (prevClose ?? closes[0]);
  const color = up ? '#34d399' : '#fb7185';

  if (prevClose != null) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y(prevClose));
    ctx.lineTo(w, y(prevClose));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, up ? 'rgba(52,211,153,0.25)' : 'rgba(251,113,133,0.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.moveTo(x(0), y(closes[0]));
  closes.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(closes.length - 1), h);
  ctx.lineTo(x(0), h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x(0), y(closes[0]));
  closes.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function syncList() {
  if (!state.watchlist.length) {
    listEl.replaceChildren();
    state.cards.clear();
    const empty = el('div', 'empty');
    empty.innerHTML = 'No symbols yet.<br>Click <b>+</b> to add a ticker.';
    listEl.append(empty);
    return;
  }
  const emptyMsg = listEl.querySelector('.empty');
  if (emptyMsg) emptyMsg.remove();

  for (const [sym, card] of state.cards) {
    if (!state.watchlist.includes(sym)) {
      card.remove();
      state.cards.delete(sym);
      state.quotes.delete(sym);
      state.sparks.delete(sym);
    }
  }
  for (const sym of state.watchlist) {
    let card = state.cards.get(sym);
    if (!card) {
      card = buildCard(sym);
      state.cards.set(sym, card);
    }
    listEl.append(card); // appending an existing node moves it -> keeps order
    updateCard(sym);
  }
}

// ---------------------------------------------------------------------------
// Header market state + status bar
// ---------------------------------------------------------------------------
function updateHeader() {
  const dot = $('market-dot');
  const label = $('market-label');
  const quotes = [...state.quotes.values()];
  let cls = '', text = '';
  if (quotes.some((q) => q.marketState === 'REGULAR')) {
    cls = 'live'; text = 'Open';
  } else if (quotes.some((q) => q.overnight)) {
    cls = 'ext'; text = 'Overnight';
  } else if (quotes.some((q) => q.marketState === 'PRE')) {
    cls = 'ext'; text = 'Pre-Market';
  } else if (quotes.some((q) => ['POST', 'POSTPOST'].includes(q.marketState))) {
    cls = 'ext'; text = 'After Hours';
  } else if (quotes.length) {
    text = 'Closed';
  }
  dot.className = `dot ${cls}`;
  label.textContent = text;
}

function setStatus(text, isError = false) {
  const elStatus = $('status-left');
  elStatus.textContent = text;
  elStatus.classList.toggle('error', isError);
}

// ---------------------------------------------------------------------------
// Data refresh loops
// ---------------------------------------------------------------------------
let refreshTimer = null;

async function refreshQuotes() {
  if (!state.watchlist.length) {
    setStatus('—');
    return;
  }
  try {
    const { quotes, errors } = await window.api.fetchQuotes();
    for (const q of quotes) state.quotes.set(q.symbol, q);
    for (const sym of state.watchlist) updateCard(sym);
    updateHeader();
    if (errors.length === 2) {
      setStatus('Offline — retrying', true);
    } else {
      setStatus(`Updated ${new Date().toLocaleTimeString()}`);
    }
  } catch {
    setStatus('Offline — retrying', true);
  }
}

async function refreshSpark(symbol) {
  const spark = await window.api.fetchSpark(symbol);
  if (spark) {
    state.sparks.set(symbol, spark);
    updateCard(symbol);
  }
}

function refreshAllSparks() {
  state.watchlist.forEach((sym, i) => setTimeout(() => refreshSpark(sym), i * 250));
}

function startLoops() {
  clearInterval(refreshTimer);
  refreshQuotes();
  refreshTimer = setInterval(refreshQuotes, QUOTE_INTERVAL);
  refreshAllSparks();
  setInterval(refreshAllSparks, SPARK_INTERVAL);
}

// ---------------------------------------------------------------------------
// Watchlist ops
// ---------------------------------------------------------------------------
async function addSymbol(symbol) {
  state.watchlist = await window.api.addSymbol(symbol);
  syncList();
  refreshQuotes();
  refreshSpark(symbol.toUpperCase());
}

async function removeSymbol(symbol) {
  state.watchlist = await window.api.removeSymbol(symbol);
  syncList();
}

// ---------------------------------------------------------------------------
// Search panel
// ---------------------------------------------------------------------------
const searchPanel = $('search-panel');
const searchInput = $('search-input');
const searchResults = $('search-results');
let searchDebounce = null;
let searchSel = -1;

function toggleSearch(show) {
  searchPanel.classList.toggle('hidden', !show);
  if (show) {
    searchInput.value = '';
    searchResults.replaceChildren();
    searchSel = -1;
    searchInput.focus();
  }
}

function renderResults(items) {
  searchResults.replaceChildren();
  searchSel = -1;
  for (const item of items) {
    const already = state.watchlist.includes(item.symbol.toUpperCase());
    const row = el('div', 'search-item' + (already ? ' already' : ''));
    row.append(
      el('span', 'sym', item.symbol),
      el('span', 'nm', item.name),
      el('span', 'ex', [item.exchange, item.type].filter(Boolean).join(' · '))
    );
    if (!already) {
      row.addEventListener('click', () => {
        addSymbol(item.symbol);
        toggleSearch(false);
      });
    }
    searchResults.append(row);
  }
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (!q) {
    searchResults.replaceChildren();
    return;
  }
  searchDebounce = setTimeout(async () => {
    const items = await window.api.search(q);
    if (searchInput.value.trim() === q) renderResults(items);
  }, 250);
});

searchInput.addEventListener('keydown', (e) => {
  const rows = [...searchResults.querySelectorAll('.search-item:not(.already)')];
  if (e.key === 'Escape') {
    toggleSearch(false);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!rows.length) return;
    searchSel = (searchSel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle('selected', i === searchSel));
    rows[searchSel].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    const target = rows[searchSel >= 0 ? searchSel : 0];
    if (target) target.click();
    else if (searchInput.value.trim()) {
      addSymbol(searchInput.value.trim());
      toggleSearch(false);
    }
  }
});

// ---------------------------------------------------------------------------
// Settings panel + first-run auto-start prompt
// ---------------------------------------------------------------------------
const settingsPanel = $('settings-panel');
const toggleAutostart = $('toggle-autostart');
const togglePin = $('toggle-pin');

function toggleSettings(show) {
  settingsPanel.classList.toggle('hidden', !show);
  if (show) toggleSearch(false);
}

toggleAutostart.addEventListener('change', async () => {
  toggleAutostart.checked = await window.api.setAutoStart(toggleAutostart.checked);
});

togglePin.addEventListener('change', async () => {
  state.pinned = await window.api.setPin(togglePin.checked);
  togglePin.checked = state.pinned;
  $('btn-pin').classList.toggle('active', state.pinned);
});

function showFirstRunPrompt() {
  const modal = $('firstrun-modal');
  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  $('firstrun-yes').addEventListener('click', async () => {
    toggleAutostart.checked = await window.api.setAutoStart(true);
    close();
  }, { once: true });
  $('firstrun-no').addEventListener('click', async () => {
    await window.api.setAutoStart(false);
    close();
  }, { once: true });
}

// ---------------------------------------------------------------------------
// Window controls
// ---------------------------------------------------------------------------
$('btn-add').addEventListener('click', () => {
  toggleSettings(false);
  toggleSearch(searchPanel.classList.contains('hidden'));
});
$('btn-settings').addEventListener('click', () =>
  toggleSettings(settingsPanel.classList.contains('hidden'))
);
$('btn-min').addEventListener('click', () => window.api.winCtl('minimize'));
$('btn-close').addEventListener('click', () => window.api.winCtl('close'));
$('btn-pin').addEventListener('click', async () => {
  state.pinned = await window.api.setPin(!state.pinned);
  $('btn-pin').classList.toggle('active', state.pinned);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
(async function init() {
  const s = await window.api.getState();
  state.watchlist = s.watchlist;
  state.pinned = s.alwaysOnTop;
  $('btn-pin').classList.toggle('active', state.pinned);
  togglePin.checked = state.pinned;
  toggleAutostart.checked = s.autoStart;
  if (s.devMode) {
    toggleAutostart.disabled = true;
    $('autostart-note').classList.remove('hidden');
  }
  syncList();
  startLoops();
  if (s.askAutoStart) showFirstRunPrompt();
})();
