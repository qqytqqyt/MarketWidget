const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Config persistence (watchlist, window bounds, prefs, webull id cache)
// ---------------------------------------------------------------------------
const configPath = () => path.join(app.getPath('userData'), 'config.json');

const DEFAULT_CONFIG = {
  watchlist: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SPY'],
  alwaysOnTop: true,
  bounds: null,
  webullIds: {},
  autoStartPrompted: false,
};

let config = DEFAULT_CONFIG;
let saveTimer = null;

function loadConfig() {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
    } catch (e) {
      console.error('config save failed:', e.message);
    }
  }, 300);
}

// ---------------------------------------------------------------------------
// Yahoo Finance: cookie + crumb auth, batched quotes, search, sparklines
// ---------------------------------------------------------------------------
let yahooAuth = null; // { cookie, crumb, ts }

async function ensureYahooAuth(force = false) {
  if (!force && yahooAuth && Date.now() - yahooAuth.ts < 30 * 60 * 1000) return yahooAuth;
  const r1 = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': UA },
    redirect: 'manual',
  });
  const setCookies = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no yahoo cookie');
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie },
  });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.includes('<')) throw new Error('no yahoo crumb');
  yahooAuth = { cookie, crumb, ts: Date.now() };
  return yahooAuth;
}

const YAHOO_FIELDS = [
  'symbol', 'shortName', 'longName', 'currency', 'marketState',
  'fullExchangeName', 'quoteType',
  'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent', 'regularMarketTime',
  'preMarketPrice', 'preMarketChange', 'preMarketChangePercent', 'preMarketTime',
  'postMarketPrice', 'postMarketChange', 'postMarketChangePercent', 'postMarketTime',
].join(',');

async function fetchYahooQuotes(symbols) {
  const { cookie, crumb } = await ensureYahooAuth();
  const url =
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}` +
    `&fields=${YAHOO_FIELDS}&crumb=${encodeURIComponent(crumb)}`;
  let res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookie } });
  if (res.status === 401 || res.status === 403) {
    const auth = await ensureYahooAuth(true);
    res = await fetch(
      url.replace(/&crumb=[^&]*$/, `&crumb=${encodeURIComponent(auth.crumb)}`),
      { headers: { 'User-Agent': UA, Cookie: auth.cookie } }
    );
  }
  if (!res.ok) throw new Error(`yahoo quote http ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const q of data?.quoteResponse?.result ?? []) out[q.symbol.toUpperCase()] = q;
  return out;
}

async function yahooSearch(query) {
  const url =
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}` +
    `&quotesCount=8&newsCount=0&listsCount=0`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`yahoo search http ${res.status}`);
  const data = await res.json();
  return (data.quotes ?? [])
    .filter((q) => q.symbol)
    .map((q) => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      exchange: q.exchDisp || q.exchange || '',
      type: q.quoteType || q.typeDisp || '',
    }));
}

async function fetchSpark(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=1d&interval=5m&includePrePost=true`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`yahoo chart http ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) return null;
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter((v) => v != null);
  return { closes, prevClose: result.meta?.chartPreviousClose ?? null };
}

// ---------------------------------------------------------------------------
// Webull: symbol -> tickerId resolution + batched realtime (overnight session)
// ---------------------------------------------------------------------------
const webullMisses = new Map(); // symbol -> ts of failed lookup (retry hourly)

async function resolveWebullId(symbol) {
  if (config.webullIds[symbol]) return config.webullIds[symbol];
  const missedAt = webullMisses.get(symbol);
  if (missedAt && Date.now() - missedAt < 60 * 60 * 1000) return null;
  try {
    const url =
      `https://quotes-gw.webullfintech.com/api/search/pc/tickers` +
      `?keyword=${encodeURIComponent(symbol)}&pageIndex=1&pageSize=10`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    const data = await res.json();
    const hit = (data?.data ?? []).find(
      (d) => d.symbol === symbol && d.regionCode === 'US' && d.template === 'stock'
    ) || (data?.data ?? []).find((d) => d.symbol === symbol);
    if (hit) {
      config.webullIds[symbol] = hit.tickerId;
      saveConfig();
      return hit.tickerId;
    }
  } catch {}
  webullMisses.set(symbol, Date.now());
  return null;
}

async function fetchWebullQuotes(symbols) {
  const idMap = {}; // tickerId -> symbol
  for (const s of symbols) {
    const id = await resolveWebullId(s);
    if (id) idMap[id] = s;
  }
  const ids = Object.keys(idMap);
  if (!ids.length) return {};
  const url =
    `https://quotes-gw.webullfintech.com/api/bgw/quote/realtime` +
    `?ids=${ids.join(',')}&includeSecu=1&delay=0&more=1`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`webull http ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const q of Array.isArray(data) ? data : []) {
    const sym = idMap[q.tickerId];
    if (sym) out[sym] = q;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge both sources into the shape the renderer consumes
// ---------------------------------------------------------------------------
function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function mergeQuote(symbol, y, w) {
  const q = {
    symbol,
    name: y?.shortName || y?.longName || w?.name || symbol,
    currency: y?.currency || w?.currencyCode || 'USD',
    exchange: y?.fullExchangeName || w?.disExchangeCode || '',
    marketState: y?.marketState || null,
    regular: null,
    pre: null,
    post: null,
    overnight: null,
  };

  if (y?.regularMarketPrice != null) {
    q.regular = {
      price: y.regularMarketPrice,
      change: y.regularMarketChange ?? null,
      changePct: y.regularMarketChangePercent ?? null,
      time: y.regularMarketTime ?? null,
    };
  } else if (w && num(w.close) != null) {
    q.regular = {
      price: num(w.close),
      change: num(w.change),
      changePct: num(w.changeRatio) != null ? num(w.changeRatio) * 100 : null,
      time: null,
    };
  }

  if (y?.preMarketPrice != null) {
    q.pre = {
      price: y.preMarketPrice,
      change: y.preMarketChange ?? null,
      changePct: y.preMarketChangePercent ?? null,
      time: y.preMarketTime ?? null,
    };
  }
  if (y?.postMarketPrice != null) {
    q.post = {
      price: y.postMarketPrice,
      change: y.postMarketChange ?? null,
      changePct: y.postMarketChangePercent ?? null,
      time: y.postMarketTime ?? null,
    };
  }

  // Webull flags the Blue Ocean 24h session; pPrice/pChange carry that quote.
  if (w && w.overnight === 1 && num(w.pPrice) != null) {
    q.overnight = {
      price: num(w.pPrice),
      change: num(w.pChange),
      changePct: num(w.pChRatio) != null ? num(w.pChRatio) * 100 : null,
    };
  }

  // Yahoo unavailable: fall back to Webull's extended-session quote.
  if (!y && w && num(w.pPrice) != null && !q.overnight) {
    q.post = {
      price: num(w.pPrice),
      change: num(w.pChange),
      changePct: num(w.pChRatio) != null ? num(w.pChRatio) * 100 : null,
      time: null,
    };
  }

  return q;
}

async function fetchAllQuotes() {
  const symbols = config.watchlist;
  if (!symbols.length) return { quotes: [], errors: [] };
  const errors = [];
  const [yahoo, webull] = await Promise.all([
    fetchYahooQuotes(symbols).catch((e) => (errors.push(`yahoo: ${e.message}`), {})),
    fetchWebullQuotes(symbols).catch((e) => (errors.push(`webull: ${e.message}`), {})),
  ]);
  const quotes = symbols.map((s) => mergeQuote(s, yahoo[s], webull[s]));
  return { quotes, errors };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let win = null;

// Chromium's SetZOrderLevel path silently fails to apply WS_EX_TOPMOST on
// some Windows 11 builds (observed on 26100/24H2: setAlwaysOnTop no-ops and
// isAlwaysOnTop() stays false, while a direct SetWindowPos works). Fall back
// to calling user32 directly when Electron's call doesn't stick.
let nativeSetTopmost = null;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const SetWindowPos = user32.func(
      'bool __stdcall SetWindowPos(intptr hWnd, intptr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'
    );
    const HWND_TOPMOST = -1n, HWND_NOTOPMOST = -2n;
    const SWP_NOSIZE_NOMOVE_NOACTIVATE = 0x13;
    nativeSetTopmost = (hwnd, onTop) =>
      SetWindowPos(hwnd, onTop ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE_NOMOVE_NOACTIVATE);
  } catch (e) {
    console.error('koffi unavailable, native topmost fallback disabled:', e.message);
  }
}

function applyAlwaysOnTop() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(config.alwaysOnTop);
  if (nativeSetTopmost && win.isAlwaysOnTop() !== config.alwaysOnTop) {
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
    nativeSetTopmost(hwnd, config.alwaysOnTop);
  }
}

function validBounds(b) {
  if (!b) return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      b.x + b.width > a.x + 20 && b.x < a.x + a.width - 20 &&
      b.y + 20 > a.y && b.y < a.y + a.height - 20
    );
  });
  return onScreen ? b : null;
}

function createWindow() {
  const bounds = validBounds(config.bounds);
  win = new BrowserWindow({
    width: bounds?.width ?? 390,
    height: bounds?.height ?? 540,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 320,
    minHeight: 220,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: config.alwaysOnTop,
    skipTaskbar: false,
    title: 'Market Widget',
    // dev-only: packaged builds get the icon from the exe resources
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, 'build', 'icon.png') }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const persistBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    config.bounds = win.getBounds();
    saveConfig();
  };
  win.on('moved', persistBounds);
  win.on('resized', persistBounds);

  // The alwaysOnTop constructor option is unreliable here — assert it
  // explicitly after load and reassert on visibility changes.
  win.webContents.once('did-finish-load', applyAlwaysOnTop);
  win.on('show', applyAlwaysOnTop);
  win.on('restore', applyAlwaysOnTop);

  if (process.env.MW_DEBUG) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        const h = win.getNativeWindowHandle();
        console.log('MW_DEBUG hwnd=', h.readBigUInt64LE(0).toString(),
          'isAlwaysOnTop=', win.isAlwaysOnTop(),
          'configAlwaysOnTop=', config.alwaysOnTop);
        win.setAlwaysOnTop(true);
        console.log('MW_DEBUG after explicit set: isAlwaysOnTop=', win.isAlwaysOnTop());
      }, 3000);
    });
  }

  // Optional screenshot hook for automated verification
  if (process.env.MW_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          win.show();
          win.focus();
          win.moveTop();
          if (process.env.MW_SCRIPT) {
            const script = fs.readFileSync(process.env.MW_SCRIPT, 'utf8');
            await win.webContents.executeJavaScript(script);
          }
          await new Promise((r) => setTimeout(r, 500));
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.MW_SHOT, img.toPNG());
          console.log('screenshot saved:', process.env.MW_SHOT);
        } catch (e) {
          console.error('screenshot failed:', e.message);
        }
        if (process.env.MW_SHOT_EXIT) app.quit();
      }, parseInt(process.env.MW_SHOT_DELAY || '8000', 10));
    });
  }
}

// ---------------------------------------------------------------------------
// Auto-start (launch at Windows login)
// ---------------------------------------------------------------------------
// getLoginItemSettings only reports openAtLogin=true when the registry
// command matches execPath + these exact args, so set and get must agree.
const AUTOSTART_ARGS = ['--autostart'];

function getAutoStart() {
  return app.getLoginItemSettings({ args: AUTOSTART_ARGS }).openAtLogin;
}

function setAutoStart(enabled) {
  // Only meaningful for an installed build; in dev this would register
  // the bare electron.exe, so skip.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: AUTOSTART_ARGS });
  }
  return getAutoStart();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('state:get', () => ({
  watchlist: config.watchlist,
  alwaysOnTop: config.alwaysOnTop,
  autoStart: getAutoStart(),
  devMode: !app.isPackaged,
  // Ask once, only in installed builds where auto-start actually works.
  askAutoStart: app.isPackaged && !config.autoStartPrompted,
}));

ipcMain.handle('autostart:set', (_e, enabled) => {
  config.autoStartPrompted = true;
  saveConfig();
  return setAutoStart(enabled);
});

ipcMain.handle('watchlist:add', (_e, symbol) => {
  symbol = String(symbol || '').trim().toUpperCase();
  if (symbol && !config.watchlist.includes(symbol)) {
    config.watchlist.push(symbol);
    saveConfig();
  }
  return config.watchlist;
});

ipcMain.handle('watchlist:remove', (_e, symbol) => {
  config.watchlist = config.watchlist.filter((s) => s !== symbol);
  saveConfig();
  return config.watchlist;
});

ipcMain.handle('quotes:fetch', () => fetchAllQuotes());

ipcMain.handle('symbols:search', async (_e, q) => {
  try {
    return await yahooSearch(q);
  } catch {
    return [];
  }
});

ipcMain.handle('spark:fetch', async (_e, symbol) => {
  try {
    return await fetchSpark(symbol);
  } catch {
    return null;
  }
});

ipcMain.handle('window:pin', (_e, value) => {
  config.alwaysOnTop = !!value;
  saveConfig();
  if (win) {
    applyAlwaysOnTop();
    if (config.alwaysOnTop) win.moveTop();
  }
  return config.alwaysOnTop;
});

ipcMain.on('window:ctl', (_e, action) => {
  if (!win) return;
  if (action === 'close') win.close();
  if (action === 'minimize') win.minimize();
});

// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    loadConfig();
    createWindow();
  });
}

app.on('window-all-closed', () => app.quit());
