# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 基金投资记录 (Fund Investment Tracker)

A personal fund investment tracking web application for consolidating investments across multiple direct-sales platforms (南方基金, 摩根, 广发基金, extensible). Pure frontend, deployed on GitHub Pages, with localStorage for persistence.

## Quick Commands

```bash
npm install              # Install dependencies
npm run dev              # Start Vite dev server (HMR enabled)
npm run build            # Type-check + production build (outputs to dist/)
npm run preview          # Preview the production build
```

No test runner is configured. Verification is manual via the dev server.

## Tech Stack

- **React 18 + TypeScript 5.6 + Vite 6** — SPA foundation
- **Ant Design 5** — UI components (Chinese locale via `antd/locale/zh_CN`)
- **ECharts** (via `echarts-for-react`) — pie/line/bar charts
- **Zustand 5** — state management (single store, no slices)
- **React Router 6** — routing with `BrowserRouter` + `basename="/fund-tracker"` for GitHub Pages
- **uuid** — IDs for transactions and DCA plans
- **dayjs** — date handling (AntD's bundled dayjs)

## High-Level Architecture

**Pure frontend, no backend.** All state lives in browser localStorage under the `fund-tracker:` prefix. Cross-origin API calls to fund data providers use script-tag injection (JSONP-style) because the upstream APIs don't support CORS.

### Data Flow

1. User adds a fund → `fetchFundWithHistory()` calls `pingzhongdata` API via `<script>` tag → reads global vars (`fS_name`, `Data_netWorthTrend`) → saves fund + full NAV history to localStorage
2. Auto-refresh on app load (`App.tsx`) → loops through all funds → refreshes NAV + generates daily snapshot
3. User records transactions → recalculates holdings via `utils/calculator.ts` → snapshots generated for portfolio trend

### Key Architectural Decisions

- **Fund ID = fund code** (e.g., `"160140"`). Codes are unique across companies, so no separate UUID needed for funds.
- **`var` globals from injected scripts** — the `pingzhongdata` API sets `var` declarations on `window`. In ES module strict mode these are non-configurable, so cleanup uses `= undefined` (NOT `delete`). See `src/api/fundApi.ts:122-124`.
- **Cost basis on partial sells** — uses proportional cost basis (not LIFO/FIFO). See `calcCost()` in `src/utils/calculator.ts`.
- **`today()` in formatter uses local time** — NOT `toISOString()` which gives UTC and breaks before 08:00 in UTC+8.
- **Chinese market colors** — red = gain, green = loss (opposite of Western convention). Helper: `pnlColor()` in `src/utils/formatter.ts`.

## Source Structure

```
src/
├── api/fundApi.ts            # All external API calls (script-tag injection)
├── components/Layout.tsx     # App shell (Sider + Header + Outlet)
├── pages/
│   ├── Dashboard.tsx         # Stat cards, pie/line charts, holdings table
│   ├── FundList.tsx          # Add/query/delete funds + autocomplete search
│   ├── FundDetail.tsx        # Per-fund NAV chart, transactions, add tx modal
│   ├── Transactions.tsx      # Global transaction list + add/edit modal
│   ├── DcaPlans.tsx          # DCA (定投) plan CRUD
│   ├── Reports.tsx           # Weekly/monthly report tabs
│   └── Settings.tsx          # Platform CRUD, theme toggle, import/export
├── stores/index.ts           # Zustand store (single file, all state + actions)
├── types/index.ts            # All TypeScript interfaces + label maps
└── utils/
    ├── calculator.ts         # Shares/cost/market value/return calculations
    ├── formatter.ts          # Money/percent/date formatting + pnlColor
    ├── reportGenerator.ts    # Weekly + monthly report generation
    ├── snapshot.ts           # Daily portfolio snapshot generation
    └── storage.ts            # localStorage wrapper with versioning
```

## Storage Layout

All keys prefixed with `fund-tracker:`:
- `version` — schema version (currently `1`)
- `platforms` — `Platform[]`
- `funds` — `Fund[]`
- `transactions` — `Transaction[]`
- `dca-plans` — `DcaPlan[]`
- `snapshots` — `DailySnapshot[]`
- `settings` — `Settings`
- `nav:{fundCode}` — `NavRecord[]` (one entry per fund)

Export/import bundles all of the above including NAV histories into a single JSON file (Settings → 数据管理).

## External APIs

The `pingzhongdata` API at `fund.eastmoney.com/pingzhongdata/{code}.js` loads a script that sets globals:
- `fS_name` — fund name
- `fS_code` — fund code
- `Data_netWorthTrend` — array of `{x: timestamp_ms, y: nav}` for full history

The `fundcode_search.js` API returns all ~8000 funds as a JS array assigned to `window.r` — used for code/name/pinyin autocomplete search.

Both APIs do NOT support CORS, so script-tag injection is the only option. Referrer must be `no-referrer` to avoid blocks.

## Deployment

GitHub Actions workflow at `.github/workflows/deploy.yml` builds and deploys `dist/` to GitHub Pages on push to `main`. `vite.config.ts` sets `base: '/fund-tracker/'` to match the repo name.

## Known Quirks / Gotchas

- The `pingzhongdata` script also sets ~25 other globals (`ishb`, `Data_fundSharesPositions`, etc.) — cleanup must clear all of them or subsequent calls see stale data. See `loadPingzhongScript()` in `fundApi.ts`.
- `removeFund()` regenerates today's snapshot because historical snapshots would otherwise show stale data.
- DCA plans store `dayOfMonth` for monthly frequency — used by `reportGenerator.ts` to compute expected DCA executions per week.
- Biweekly DCA frequency checks week parity from `startDate` (not just "every other week from today").
- `Form.Item` with `Select` that has `showSearch` and is bound to form state has known issues with `form.setFieldsValue()` triggering re-renders — `Transactions.tsx` and `FundList.tsx` use `Form.useWatch` or onChange handlers to work around this.

## Design Document

Full spec with data models, calculation formulas, and feature descriptions is at `docs/superpowers/specs/2026-08-27-fund-tracker-design.md`.