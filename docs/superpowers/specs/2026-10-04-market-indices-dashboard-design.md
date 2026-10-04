# Market Indices on Dashboard — Design

**Date:** 2026-10-04
**Status:** Approved (brainstorming)
**Scope:** Delete HoldingsSummary; add 3 market-index cards (沪深300 / 纳斯达克100 / 标普500) to Dashboard

---

## 1. Goal

In a single PR, two related changes to `src/pages/Dashboard.tsx`:

1. **Delete** the `<HoldingsSummary summaries={summaries} platforms={platforms} />` block and the `src/components/HoldingsSummary.tsx` file (no other consumers).
2. **Add** a new row of three "market index" cards showing 名称 + 点位 + 涨跌额 + 涨跌幅 + 数据日期, refreshed alongside the existing NAV refresh flow.

No other sections change. The 4 main KPI cards, 3 secondary cards, ReturnCalendar, and Holdings List stay as-is.

---

## 2. Data Source

eastmoney push2 quote endpoint, accessed via JSONP (`<script>` tag injection — same CORS workaround already used by `loadPingzhongScript` in `src/api/fundApi.ts`):

```
https://push2.eastmoney.com/api/qt/stock/get?cb={callback}&secid={secid}&fields=f43,f44,f45,f46,f60,f169,f170,f86,f168&_={ts}
```

Fields used:

| Field | Meaning |
|---|---|
| `f43` | Current price (point value, native scale) |
| `f169` | Change amount vs previous close |
| `f170` | Change percent vs previous close |
| `f86` | Timestamp (ms) of last update — **used as the staleness gate** |

Response shape: `{ rc, rt, svr, lt, full, dlmkts, data: { f43, f44, ..., f86 } }`. `data` may be `null` for delisted / unknown codes — must be guarded.

### Index list (v1, hardcoded)

| Name | secid | Market | Date TZ |
|---|---|---|---|
| 沪深300 | `1.000300` | `CN` | `Asia/Shanghai` |
| 纳斯达克100 | `100.NDX` | `US` | `America/New_York` |
| 标普500 | `100.SPX` | `US` | `America/New_York` |

Codepoint values are raw index points (e.g., NDX ~18,300, SPX ~5,200). No FX conversion — display convention is "index = points".

---

## 3. Independent CN-US refresh (key design decision)

The two markets have different calendars (different timezones, different holidays). The design must NOT rely on a hardcoded holiday table — the API's own `f86` timestamp is the source of truth.

### Per-index cache state

```ts
interface IndexQuote {
  name: string;
  market: 'CN' | 'US';
  value: number;
  change: number;
  changePercent: number;
  /** 该市场当地的"数据日期" YYYY-MM-DD（API f86 转该市场时区） */
  date: string;
  /** 本地拉取时间戳 ms，用于"已更新于 HH:mm"显示 */
  fetchedAt: number;
}

type IndicesCache = Record<string /* spec.code */, IndexQuote>;
```

### Refresh rule

For each index, on every refresh tick:

1. **Try to fetch** via JSONP.
2. If fetch fails → silent: keep cache, surface "—网络异常" on the card.
3. **Compare** API's `data.date` with cache's `data.date`:
   - If `data.date > cache.date` → update cache (new trading day's value).
   - If `data.date <= cache.date` → no update (API returned the same / older date; market hasn't moved — either closed today, weekend, holiday, or after-hours).
4. Display cache.date verbatim (e.g., "10-04 美东" or "10-04").

This rule naturally handles every case without a holiday table:

| Scenario | Behaviour |
|---|---|
| CN 休市 (国庆), US 开盘 | CN API returns last CN trading day → cache unchanged. US API returns today's value → cache updates. |
| US 休市 (Christmas), CN 开盘 | US API returns last US trading day → cache unchanged. CN API returns today's value → cache updates. |
| Weekend | Both APIs return last Friday's data → both caches unchanged. |
| Market just opened (e.g., US at 北京 22:00) | US API returns today's pre-market / open value → cache updates. |
| Pre-market only (US 北京 21:30, regular hours not started) | US API returns pre-market tick data → cache updates (timestamp is today's). |

### Refresh cadence

Use the existing `refreshAll()` in `src/App.tsx` and the existing 30-minute periodic tick (`useEffect` with `setInterval`). Append a second loop after the fund loop:

```ts
// existing fund loop
for (const fund of funds) { /* unchanged */ }

// NEW: index loop
for (const idx of INDEX_LIST) {
  const cached = getIndexCache(idx.code);
  const data = await fetchMarketIndex(idx);
  if (!data) continue;
  if (cached && data.date <= cached.date) continue;
  updateIndex(idx.code, { ...data, fetchedAt: Date.now() });
  if (i < INDEX_LIST.length - 1) await sleep(500);
}
```

### Trade-off: wasted calls during holidays

A 7-day holiday will see ~336 wasted fetches per index (30 min × 24 h × 7 d). This is **accepted**:

- Eastmoney serves these from cache; responses are <100 ms.
- A "throttle after N consecutive no-updates" optimization is intentionally deferred to v2 — it's bug-prone and the cost is small.
- The 30-min global tick gate already skips calls when **no fund NAV** is stale; for indices, we'll always attempt (don't gate on the same `hasStale` predicate used for funds, since index holidays differ from fund NAV release schedule).

### Holiday table status

- **`src/utils/chineseHolidays.ts`** — keep. Still used by the existing 30-min tick (`hasStale` for fund NAV) and by the Dashboard's "休市" indicator on the daily P&L card.
- **`src/utils/usHolidays.ts`** — **not created**. We deliberately avoid a US holiday util; the API timestamp is authoritative.

---

## 4. Files to change / add

### Modify

| File | Change |
|---|---|
| `src/types/index.ts` | Add `IndexQuote`, `Market`, `IndexSpec` types. |
| `src/utils/storage.ts` | Add `getIndices()`, `saveIndices()`, integrate into `exportAllData` / `importAllData` (use `data.indices ?? {}` for back-compat with v0 backups). |
| `src/stores/index.ts` | Add `indices: IndicesCache` state; `updateIndex(code, quote)` action; load/save in `loadFromStorage`. (No `getIndex` needed — `indices` is a plain object on state; consumers read `useStore().indices[code]`.) |
| `src/App.tsx` | Append index loop to `refreshAll()`. Import `fetchMarketIndex`, `INDEX_LIST` from new `src/api/indexApi.ts`. |
| `src/pages/Dashboard.tsx` | Delete `<HoldingsSummary>` block + import; insert `<MarketIndices />` between the 4 main KPI cards and the 3 secondary cards. |
| `src/types/index.ts` | Update the JSDoc on `FUND_TYPE_COLORS` that mentions "HoldingsSummary" — drop the dangling reference. |

### Add

| File | Purpose |
|---|---|
| `src/api/indexApi.ts` | `fetchMarketIndex(spec)` + `INDEX_LIST` const. Reuses script-tag-injection pattern from `loadPingzhongScript`. |
| `src/components/MarketIndices.tsx` | Row of 3 AntD `Card`s reading from `useStore().indices`. |
| `docs/superpowers/specs/2026-10-04-market-indices-dashboard-design.md` | This file. |

### Delete

| File | Reason |
|---|---|
| `src/components/HoldingsSummary.tsx` | No other consumers; per user "持仓汇总（按平台 / 类型），这个删除". |

---

## 5. `src/api/indexApi.ts` — sketch

```ts
// Mirrors loadPingzhongScript's pattern (var globals on window, no delete — set to undefined).
// Eastmoney push2 supports JSONP via `cb=callbackName`; we declare window[cb] before injecting.

export type Market = 'CN' | 'US';

export interface IndexSpec {
  code: string;
  secid: string;
  name: string;
  market: Market;
}

export const INDEX_LIST: IndexSpec[] = [
  { code: 'sh000300', secid: '1.000300',  name: '沪深300',     market: 'CN' },
  { code: 'usNDX',    secid: '100.NDX',   name: '纳斯达克100', market: 'US' },
  { code: 'usSPX',    secid: '100.SPX',   name: '标普500',    market: 'US' },
];

interface IndexQuoteRaw {
  value: number;
  change: number;
  changePercent: number;
  date: string;
  fetchedAt: number;
}

const TIMEOUT_MS = 15000;
const SCRIPT_SRC = 'https://push2.eastmoney.com/api/qt/stock/get';

function loadIndexScript(secid: string, cb: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const w = window as unknown as Record<string, unknown>;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Index script timeout'));
    }, TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      try { w[cb] = undefined; } catch {}
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    w[cb] = (data: unknown) => { cleanup(); resolve(data); };

    script.onerror = () => { cleanup(); reject(new Error(`Index script failed: ${secid}`)); };

    const fields = 'f43,f169,f170,f86';
    script.src = `${SCRIPT_SRC}?cb=${cb}&secid=${encodeURIComponent(secid)}&fields=${fields}&_=${Date.now()}`;
    script.setAttribute('charset', 'utf-8');
    script.setAttribute('referrerpolicy', 'no-referrer');
    document.head.appendChild(script);
  });
}

export async function fetchMarketIndex(spec: IndexSpec): Promise<IndexQuoteRaw | null> {
  const cb = `__idxCb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    const resp = await loadIndexScript(spec.secid, cb);
    const data = (resp as { data?: Record<string, number> | null })?.data;
    if (!data) return null;

    const tz = spec.market === 'CN' ? 'Asia/Shanghai' : 'America/New_York';
    const date = dayjs(data.f86).tz(tz).format('YYYY-MM-DD');

    return {
      value: data.f43,
      change: data.f169,
      changePercent: data.f170,
      date,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    console.error('[indexApi] fetchMarketIndex failed for', spec.secid, err);
    return null;
  }
}
```

`dayjs/plugin/timezone` + `dayjs/plugin/utc` need to be extended in this file (or in App.tsx if not already present — verify during implementation).

---

## 6. `src/components/MarketIndices.tsx` — sketch

```tsx
import { useStore } from '../stores';
import { INDEX_LIST } from '../api/indexApi';
import { Card, Tooltip } from 'antd';
import { Row, Col } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
// Renders use `value.toLocaleString('en-US', { maximumFractionDigits: 2 })` —
// index points have no decimals by convention; do NOT route through `formatMoney`
// (it forces 2-decimal money formatting and prepends `¥`).
import { pnlColor } from '../utils/formatter';
import dayjs from 'dayjs';

export default function MarketIndices() {
  const { indices } = useStore();

  return (
    <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
      {INDEX_LIST.map((spec) => {
        const quote = indices[spec.code];
        const tzLabel = spec.market === 'CN' ? '' : '美东';
        return (
          <Col xs={24} sm={8} key={spec.code}>
            <Card size="small" hoverable>
              <div style={{ color: '#666', fontSize: 13, marginBottom: 6 }}>
                📊 {spec.name}
              </div>
              {quote ? (
                <>
                  <div style={{
                    fontSize: 26, fontWeight: 700, lineHeight: 1.2,
                    fontFamily: 'DIN, "Helvetica Neue", Arial, sans-serif',
                    color: pnlColor(quote.change),
                  }}>
                    {quote.change > 0 && <ArrowUpOutlined style={{ fontSize: 14 }} />}{' '}
                    {quote.change < 0 && <ArrowDownOutlined style={{ fontSize: 14 }} />}{' '}
                    {quote.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  </div>
                  <div style={{ fontSize: 12, color: pnlColor(quote.change), marginTop: 6 }}>
                    {quote.change >= 0 ? '+' : ''}{quote.change.toFixed(2)}{' '}
                    ({quote.changePercent >= 0 ? '+' : ''}{quote.changePercent.toFixed(2)}%)
                  </div>
                  <Tooltip title={`本地拉取于 ${dayjs(quote.fetchedAt).format('YYYY-MM-DD HH:mm:ss')}`}>
                    <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
                      {tzLabel} {quote.date.slice(5)}
                    </div>
                  </Tooltip>
                </>
              ) : (
                <div style={{ color: '#999', fontSize: 13, padding: '12px 0' }}>
                  —
                </div>
              )}
            </Card>
          </Col>
        );
      })}
    </Row>
  );
}
```

Styling matches the existing 4 main KPI cards (`font: 'DIN, "Helvetica Neue", Arial, sans-serif'`, `pnlColor` red-up/green-down Chinese convention, `fontSize: 26-30`). Card size is `small` to keep the row compact (not competing with the 4 main KPI cards above).

---

## 7. Storage layout

New key: `fund-tracker:indices` storing `Record<string, IndexQuote>`.

Bundled in `exportAllData` as a top-level `indices` field. `importAllData` reads `data.indices ?? {}` to keep v0 backups working (they predate this field).

---

## 8. Error / edge cases

| Case | Behaviour |
|---|---|
| First load, fetch in flight | Card shows `—` until first response. |
| Network error | Card keeps last cached value + a console log. No "—" reset — the cache is still useful. |
| API returns `data: null` (delisted / unknown) | Treat as fetch failure; keep cache. |
| API returns `data.date <= cache.date` | No update; card unchanged. (This is the holiday-weekend-after-hours path.) |
| `f86` timestamp missing or zero | Treat as fetch failure; keep cache. |
| User imports v0 backup without `indices` field | Default to `{}`; cards show `—` until first refresh. |

---

## 9. Verification — must pass before "done"

Manual in dev mode (`npm run dev`):

1. **JSONP endpoint works**: open Dashboard, DevTools → Network → `push2.eastmoney.com/...` returns 200 with `__idxCb_xxx(...)` content. (Risk: if eastmoney drops JSONP support on this endpoint, fall back to `pingzhongdata` on tracking-ETF codes `510310 / 513100 / 513500`. Trade-off: ETF NAV ≠ index, off by 1 min–1 day; clearly worse.)
2. **Display**: 3 cards visible between 4 main KPIs and 3 secondary cards. Card shows 名称 / 点位 / 涨跌 / 百分比 / 数据日期.
3. **No HoldingsSummary**: the previous "持仓汇总（按平台 / 类型）" Card is gone.
4. **Refresh**: wait one 30-min tick; on a trading day, `data.date` should advance.
5. **Holiday behaviour**: simulate by forcing `cache.date` to yesterday via localStorage edit → reload → first refresh updates to today; simulate cache-ahead of API (force cache.date = today) → reload → refresh keeps cache unchanged.
6. **Persistence**: refresh page; cards show last cached values within milliseconds, then refresh.
7. **Export/import**: Settings → 数据管理 → 导出 → 重置 → 导入 → indices restored.
8. **Theme**: cards render acceptably in both light and dark modes.

Vitest (`npm run test`): existing pure-function utils (formatter, calculator, etc.) are unaffected. No new pure utils introduced (API + storage are side-effecting). No new tests required.

---

## 10. Out of scope (deferred)

- Configurable index list (add / remove in Settings).
- Tracking ETF fallback (only if JSONP endpoint fails verification in step 9.1).
- Per-index throttle after N consecutive no-update fetches.
- US-specific holiday util (`src/utils/usHolidays.ts`).
- Sparkline of recent index values (would need history endpoint).
- Click-to-expand index detail page (parallels `FundDetail.tsx`).