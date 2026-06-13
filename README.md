# Market Widget

A frameless Windows desktop widget showing live share prices across **all** trading
sessions — regular hours, pre-market, after hours, and the overnight (Blue Ocean 24h)
session.

## Install

Grab the latest `Market-Widget-Setup-x.x.x.exe` from the
[**Releases page**](https://github.com/qqytqqyt/MarketWidget/releases/latest) and run
it — no other dependencies needed. On first launch the widget asks whether it should
start automatically with Windows; you can change that anytime in **Settings (⚙)**.

> Windows SmartScreen may warn because the installer is not code-signed.
> Click "More info" → "Run anyway".

## Features

- **Live quotes** refreshed every 10 seconds, batched in a single request.
- **All sessions**: the big price always shows the *most current* session
  (Overnight → Pre-Market → Live → After Hours), with a colored chip telling you
  which one it is. Secondary line shows the regular close (and stale after-hours
  price during the overnight session) for context.
- **Sparklines**: 1-day intraday chart per ticker (includes pre/post), dotted line
  marks the previous close.
- **Add tickers**: click **+**, search by symbol or company name (stocks, ETFs,
  crypto, indices, international exchanges). Arrow keys + Enter or click to add.
- **Remove tickers**: hover a card, click the **×** in its corner.
- **Widget behavior**: frameless, draggable (drag the header), resizable,
  pin-to-top toggle, position/size/watchlist persisted between runs.
- **Settings (⚙)**: launch-at-startup and always-on-top toggles.

## Data sources (free, no API key)

| Source | Used for |
|---|---|
| Yahoo Finance | regular / pre-market / after-hours quotes, ticker search, sparklines |
| Webull | overnight (Blue Ocean ATS) session price |

Notes:
- The overnight session runs Sunday 8 PM – Friday 4 AM ET (no session Friday night /
  Saturday). The overnight price appears automatically when that session is active
  and Webull flags the ticker as trading overnight.
- Quotes may be exchange-delayed (typically ≤ 15 min depending on the venue).
- These are unofficial public endpoints — if Yahoo's quote API is unavailable the
  widget automatically falls back to Webull data alone.

## Run from source

```
npm install
npm start          # or double-click "Market Widget.bat"
```

## Build / release

- `npm run dist` builds the NSIS installer into `dist/`.
- Pushing a tag like `v1.2.3` triggers the GitHub Action in
  `.github/workflows/release.yml`, which builds the installer and publishes it as a
  GitHub release automatically. Bump `version` in `package.json` to match the tag.
- `npm run icon` regenerates `build/icon.png` / `build/icon.ico` from
  `build/icon.html`.

## Config

Watchlist, window position, and preferences are stored in
`%APPDATA%\market-widget\config.json` (installed app) — delete it to reset to
defaults (AAPL, MSFT, NVDA, TSLA, SPY).
