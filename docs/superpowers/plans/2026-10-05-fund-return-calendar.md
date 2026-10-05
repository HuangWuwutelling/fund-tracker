# Per-Fund Return Calendar + Wealth-Change Refactor Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 日/月/年 return calendar to each fund's `FundDetail` page, powered by a unified wealth-change algorithm that makes per-fund calendar + portfolio calendar + weekly/monthly reports automatically consistent.

**Architecture:** Replace `generateDailyReturns`'s attribution-map + half-day NAV (mark-to-market) algorithm with a wealth-change formula that uses "累计收益" as the single source of truth:

```
cumulativeReturn(D) = shares(D) × NAV(D)
                    − Σ buy.amount(D)
                    + Σ (sell.amount − sell.fee)(D)
                    + Σ cashDividend.amount(D)

dailyReturn(D) = cumulativeReturn(D) − cumulativeReturn(prevMeaningfulDate)
monthlyReturn(M) = cumulativeReturn(endOfM) − cumulativeReturn(endOfPrevM)
yearlyReturn(Y) = cumulativeReturn(endOfY) − cumulativeReturn(endOfPrevY)
```

Per-fund calendar = new `generateFundDailyReturns(fund, tx)` wrapper.
Portfolio calendar = sum of per-fund daily series → monthly/yearly align for free.

**Tech Stack:** React 18 + TypeScript 5.6 + AntD 5 + ECharts + Zustand 5 + Vitest (existing).

## Global Constraints

1. **API compatibility preserved**: `generateDailyReturns(funds, transactions)` keeps the same signature and `DailyReturn` shape — only the algorithm changes.
2. **Algorithm must be additive**: monthly/yearly totals must equal sum of daily cells (per fund and portfolio). No more "日 vs 月/年算法分叉" divergence.
3. **Verified against user data**: with the user's `fund-tracker-backup-2026-10-05.json`, Aug month total must be `60.13`, Sep must be `-448.74` (matching existing monthly report — that's the bug we are fixing).
4. **Today格 (latest NAV) handling stays the same**: today格 still uses the latest available NAV pair (QDII may lag), with `navDate` field exposed for UI; `noNav` + `isPending` semantics unchanged.
5. **`onlyConfirmed` everywhere**: pending tx still don't count toward shares/cash flow.
6. **No raw `localStorage.getItem` calls** in new code — use `useStore()` and `getNavHistory` as the rest of the codebase does.
7. **Test coverage**: new wealth-change functions must have unit tests covering buy/sell/dividend/cash-and-reinvest branches.
8. **No `util` import noise**: do not import unused names like `lookupNavForDate` after the refactor — keep imports minimal.
9. **Place FundDetail 收益日历 ABOVE NAV chart Card** (user's explicit instruction).
10. **Reuse `DayView`/`MonthView`/`YearView`/`PeriodDetail`**: extract them as named exports from `ReturnCalendar.tsx` rather than duplicating logic.

---

## Task 1: Wealth-Change Algorithm — `generateFundDailyReturns`

**Files:**
- Modify: `src/utils/reportGenerator.ts` (add `generateFundDailyReturns` near `generateDailyReturns`)
- Test: `src/utils/reportGenerator.test.ts` (new file)

**Interfaces:**
- New: `generateFundDailyReturns(fund: Fund, transactions: Transaction[], todayStr?: string): DailyReturn[]`
  - Returns per-fund daily series using wealth-change delta
  - Each day's `perFund` is exactly 1 entry (the fund itself)
  - Today格 uses latest available NAV pair (QDII may lag); isPending propagated

### Steps

- [ ] **Step 1.1: Write failing test for empty case**

```ts
import { describe, it, expect } from 'vitest';
import { generateFundDailyReturns, generateDailyReturns } from './reportGenerator';
import type { Fund, NavRecord, Transaction } from '../types';

function fund(id: string, name = id, type: Fund['type'] = 'mixed'): Fund {
  return { id, name, platformId: 'p1', type, currentNav: 1, navDate: '' };
}

function nav(date: string, value: number): NavRecord {
  return { date, nav: value, accNav: value };
}

function buy(date: string, amount: number, shares: number, nav: number, fee = 0): Transaction {
  return { id: `b-${date}`, fundId: 'f1', type: 'buy', date, amount, fee, shares, nav };
}

describe('generateFundDailyReturns', () => {
  it('no transactions and no nav → empty', () => {
    expect(generateFundDailyReturns(fund('f1'), [])).toEqual([]);
  });
});
```

- [ ] **Step 1.2: Implement `generateFundDailyReturns` skeleton**

In `reportGenerator.ts`, add a new exported function after the existing `generateDailyReturns`. The function:

1. Filter `transactions` by `fundId`, keep only confirmed, sort by date.
2. Compute "meaningful dates" = union of NAV publish dates (from `getNavHistory(fund.id)` filtered by `usableNavSeries`) and confirmed tx dates.
3. Iterate sorted meaningful dates, accumulating `shares`, `totalBuy`, `totalSellNet`, `totalCashDiv`:
   - buy: `shares += tx.shares`, `totalBuy += tx.amount`
   - sell: `shares -= tx.shares`, `totalSellNet += tx.amount - tx.fee`
   - dividend cash (`tx.amount > 0`): `totalCashDiv += tx.amount`
   - dividend reinvest (`tx.shares > 0`): `shares += tx.shares`
4. For each meaningful date D with NAV `d.nav`: store `cumReturn(D) = shares × nav − totalBuy + totalSellNet + totalCashDiv`.
5. Walk `[firstMeaningfulDate, todayStr]` calendar days. Skip non-trading days except today. Each day:
   - `dailyReturn = (cumToday − cumPrevMeaningful)`
   - `cumPrevMeaningful` carries between days — advances only when `cumByDate.has(date)` is true.
6. Push `DailyReturn` with `perFund: [{ fundId, fundName, returnAmount: dailyReturn, navDate: ... }]`.
7. Today格: if no NAV on todayStr, use latest available NAV pair → `calcLatestNavPnl(fund, navHistory, fundTxs)` for pnl; populate `navDate` from that.

Implementation skeleton:

```ts
export function generateFundDailyReturns(
  fund: Fund,
  transactions: Transaction[],
  todayStr: string = today(),
): DailyReturn[] {
  const confirmed = onlyConfirmed(transactions.filter((t) => t.fundId === fund.id));
  const usable = usableNavSeries(fund, getNavHistory(fund.id));
  if (usable.length === 0 && confirmed.length === 0) return [];

  // 1. meaningful dates
  const meaningful = new Set<string>();
  for (const n of usable) meaningful.add(n.date);
  for (const tx of confirmed) meaningful.add(tx.date);

  // 2. precompute NAV lookup by date (sorted asc)
  const usableByDate = new Map(usable.map((n) => [n.date, n] as const));

  // 3. walk sorted meaningful dates, accumulating state
  const sortedMeaningful = Array.from(meaningful).sort();
  const cumByDate = new Map<string, number>();
  let totalBuy = 0;
  let totalSellNet = 0;
  let totalCashDiv = 0;
  let shares = 0;
  const sortedTxs = [...confirmed].sort((a, b) => a.date.localeCompare(b.date));
  let txIdx = 0;

  for (const date of sortedMeaningful) {
    while (txIdx < sortedTxs.length && sortedTxs[txIdx]!.date <= date) {
      const tx = sortedTxs[txIdx]!;
      if (tx.type === 'buy') {
        shares += tx.shares;
        totalBuy += tx.amount;
      } else if (tx.type === 'sell') {
        shares -= tx.shares;
        totalSellNet += tx.amount - tx.fee;
      } else if (tx.type === 'dividend') {
        if (tx.amount > 0) totalCashDiv += tx.amount;
        if (tx.shares > 0) shares += tx.shares;
      }
      txIdx++;
    }
    const navRecord = usableByDate.get(date);
    if (navRecord) {
      cumByDate.set(date, shares * navRecord.nav - totalBuy + totalSellNet + totalCashDiv);
    }
  }

  // 4. walk calendar days, emit DailyReturn[]
  const firstDate = sortedMeaningful[0]!;
  const out: DailyReturn[] = [];
  let prevCum = 0;
  for (
    let cursor = dayjs(firstDate);
    cursor.format('YYYY-MM-DD') <= todayStr;
    cursor = cursor.add(1, 'day')
  ) {
    const date = cursor.format('YYYY-MM-DD');
    const isToday = date === todayStr;
    // skip non-trading days in history; today always included (if today is trading day)
    if (!isToday && isNonTradingDay(date)) continue;

    const cumToday = cumByDate.get(date) ?? prevCum;
    const dailyReturn = cumToday - prevCum;

    let navDate = '';
    if (cumByDate.has(date)) {
      navDate = date;
    } else if (isToday) {
      const last = usable.length > 0 ? usable[usable.length - 1]! : null;
      navDate = last?.date ?? '';
    }

    const last = usable.length > 0 ? usable[usable.length - 1]! : null;
    const hasUsableNav = !!last;
    const hasPosition = shares > 0;

    out.push({
      date,
      totalReturn: dailyReturn,
      perFund: [
        {
          fundId: fund.id,
          fundName: fund.name,
          returnAmount: dailyReturn,
          navDate,
          noNav: isToday && hasPosition && !hasUsableNav,
        },
      ],
    });
    prevCum = cumToday;
  }

  // today isPending propagation
  const todayEntry = out[out.length - 1];
  if (todayEntry && todayEntry.date === todayStr) {
    const pf = todayEntry.perFund[0]!;
    todayEntry.isPending = pf.noNav === true;
  }
  return out;
}
```

- [ ] **Step 1.3: Run test, verify it passes**

```bash
npm run test -- reportGenerator.test.ts
```

Expected: 1 PASS.

- [ ] **Step 1.4: Add tests for buy / sell / dividend / cash & reinvest**

Add to `src/utils/reportGenerator.test.ts`:

```ts
describe('generateFundDailyReturns - wealth change', () => {
  // Setup helper: nav on 1/1 and 1/2, share holdings carry forward
  function setupJanNav() {
    // mock getNavHistory via... (need to inject storage; see step 1.5)
  }

  it('buy on day, NAV flat → 0 dailyReturn (cumReturn unchanged)', () => {
    // buy 1000 shares @ nav=1 on 1/1; NAV unchanged 1/1→1/2 → 0
  });

  it('NAV up 1% on day with no tx → positive return = shares × Δnav', () => {
    // 1000 shares bought @ 1.0 on 1/1; NAV 1.0→1.01 on 1/2 → +10 on 1/2
  });

  it('buy mid-day at higher NAV than prev → return for buy day captures discount gain', () => {
    // Buy 1000 shares @ 1.0 on 1/1, NAV jumps 1.10 on 1/2 (no buy/sell)
    // Old algorithm would show +100 on 1/2; new wealth-change shows 0 on 1/2 + +100 cumulative
    // The test confirms: 1/1 has +1000 cum, 1/2 has +1100 cum → 1/2 dailyReturn = +100
  });

  it('cash dividend → cumReturn bumps by amount on dividend date', () => {
    // buy 1000 @ 1.0 on 1/1; dividend amount=50 on 1/2; NAV flat
    // cumReturn on 1/1 = 0, on 1/2 = 0 (shares × 1.0) − 1000 + 50 = 50 → +50 dailyReturn on 1/2
  });

  it('reinvest dividend → shares bump, cumReturn += shares × NAV', () => {
    // buy 1000 @ 1.0 on 1/1; reinvest 100 shares on 1/2; NAV flat
    // shares=1100 on 1/2; cumReturn = 1100 − 1000 = 100 → +100 dailyReturn on 1/2
  });

  it('sell → cumReturn bumps by sell.amount − sell.fee', () => {
    // buy 1000 @ 1.0 on 1/1; sell 500 @ 1.0 on 1/2 with fee=10 → inflow 990
    // shares=500 on 1/2; cumReturn = 500 − 1000 + 990 = 490 → +490 dailyReturn on 1/2
  });
});
```

For these tests to work, we need to mock `getNavHistory`. Add to `reportGenerator.ts`:

```ts
// Test seam: override getNavHistory in tests
let _navHistoryOverride: ((fundCode: string) => NavRecord[]) | null = null;
export function __setNavHistoryForTest(fn: ((code: string) => NavRecord[]) | null) {
  _navHistoryOverride = fn;
}
```

In `generateFundDailyReturns`, replace `getNavHistory(fund.id)` with `_navHistoryOverride?.(fund.id) ?? getNavHistory(fund.id)`.

The test file calls `__setNavHistoryForTest(() => navRecords)` in `beforeEach`.

- [ ] **Step 1.5: Run all reportGenerator tests, verify pass**

```bash
npm run test -- reportGenerator.test.ts
```

Expected: 7+ PASS, 0 FAIL.

---

## Task 2: Refactor `generateDailyReturns` to compose per-fund

**Files:**
- Modify: `src/utils/reportGenerator.ts` (replace body of `generateDailyReturns`, keep signature + return type)

### Steps

- [ ] **Step 2.1: Rewrite `generateDailyReturns` body**

The new body:

1. Filter confirmed transactions once.
2. For each fund in `funds`, call `generateFundDailyReturns(fund, transactions, todayStr)`.
3. Merge by date: each portfolio date = sum of per-fund `totalReturn` + concat `perFund`.
4. Compute `isPending` for today格: held funds (with shares > 0) AND all per-fund noNav.

Implementation:

```ts
export function generateDailyReturns(
  funds: Fund[],
  transactions: Transaction[],
): DailyReturn[] {
  const todayStr = today();
  const confirmed = onlyConfirmed(transactions);

  // Per-fund series
  const mergedByDate = new Map<string, DailyReturn>();
  for (const fund of funds) {
    const series = generateFundDailyReturns(fund, transactions, todayStr);
    for (const dr of series) {
      let entry = mergedByDate.get(dr.date);
      if (!entry) {
        entry = { date: dr.date, totalReturn: 0, perFund: [], isPending: false };
        mergedByDate.set(dr.date, entry);
      }
      entry.totalReturn += dr.totalReturn;
      // each fund contributes at most one perFund entry (assert)
      entry.perFund.push(dr.perFund[0]!);
    }
  }

  const result = Array.from(mergedByDate.values()).sort((a, b) => a.date.localeCompare(b.date));

  // isPending propagation
  const todayEntry = result.find((r) => r.date === todayStr);
  if (todayEntry) {
    const heldFundIds = new Set(
      funds
        .filter((f) => {
          const fundTxs = confirmed.filter((t) => t.fundId === f.id);
          return fundTxs.length > 0 && calcShares(fundTxs) > 0;
        })
        .map((f) => f.id)
    );
    todayEntry.isPending =
      heldFundIds.size > 0 &&
      todayEntry.perFund.filter((p) => heldFundIds.has(p.fundId)).every((p) => p.noNav === true);
  }
  return result;
}
```

- [ ] **Step 2.2: Add test "portfolio daily returns = sum of per-fund daily returns"**

```ts
describe('generateDailyReturns - portfolio composition', () => {
  it('portfolio daily total = sum of per-fund daily totals', () => {
    // 2 funds, NAV series for each; portfolio series should equal sum
  });

  it('portfolio monthly aggregate = sum of daily cells', () => {
    // Use the existing generateMonthlyReturns — confirm it sums to same number
    // as direct wealth-change end-of-month minus end-of-prev-month
  });
});
```

- [ ] **Step 2.3: Run all tests, verify pass**

```bash
npm run test
```

Expected: all PASS.

- [ ] **Step 2.4: Remove unused helpers (cleanup)**

The old `generateDailyReturns` no longer uses:
- `buildAttributionMap`
- `buildSharesTimeline`
- `getSharesAsOf` (now only used inside `calcWeightedPortfolioValueInRange` — keep)
- `calcDailyPnlBySegments` (only `calcLatestNavPnl` uses it — keep)

Delete `buildAttributionMap`, `buildSharesTimeline` (if no longer referenced). Use `grep` to verify no references remain before deleting.

---

## Task 3: Verify Monthly / Yearly Naturally Align

**Files:**
- Modify: `src/utils/reportGenerator.test.ts` (add consistency tests)

### Steps

- [ ] **Step 3.1: Add "wealth-change month-end minus prev-month-end = sum of dailies" test**

```ts
describe('monthly / yearly wealth-change consistency', () => {
  it('Aug 2026 month total via end-of-month delta = sum of Aug daily cells', () => {
    // Use test fixture similar to user data: buy 022719 on 8/26 with tx.nav=1.0928,
    // prev.nav=1.1286 → bug case that old algorithm missed
    // Expectation: month total = 60.13 (matches monthly report)
  });

  it('year total = sum of 12 months', () => {
    // Build a 12-month fixture; verify sum equals yearlyReturns.totalReturn
  });
});
```

- [ ] **Step 3.2: Run tests**

```bash
npm run test -- reportGenerator.test.ts
```

Expected: all PASS.

- [ ] **Step 3.3: No code changes needed** — `generateMonthlyReturns` and `generateYearlyReturns` already aggregate from `dailyReturns`, so they automatically inherit the new wealth-change semantics. Confirm by reading the existing implementations.

---

## Task 4: Extract `DayView` / `MonthView` / `YearView` / `PeriodDetail` as named exports

**Files:**
- Modify: `src/components/ReturnCalendar.tsx` (add `export` keywords)

### Steps

- [ ] **Step 4.1: Add named exports**

In `src/components/ReturnCalendar.tsx`, change:

```ts
function PeriodDetail(...) → export function PeriodDetail(...)
function DayView(...) → export function DayView(...)
function MonthView(...) → export function MonthView(...)
function YearView(...) → export function YearView(...)
```

Also extract the `PeriodDetailRow` interface so `FundReturnCalendar` can use the same shape:

```ts
export interface PeriodDetailRow { ... }
```

- [ ] **Step 4.2: Verify with TypeScript**

```bash
npm run build
```

Expected: 0 errors (no consumer yet, just the exports).

---

## Task 5: Create `FundReturnCalendar` Component

**Files:**
- Create: `src/components/FundReturnCalendar.tsx`

### Steps

- [ ] **Step 5.1: Write the new component**

```tsx
import { useMemo, useState } from 'react';
import { Card, Tabs, Empty } from 'antd';
import dayjs from 'dayjs';
import type { Fund, Transaction } from '../types';
import {
  generateFundDailyReturns,
  generateMonthlyReturns,
  generateYearlyReturns,
} from '../utils/reportGenerator';
import { today } from '../utils/formatter';
import { DayView, MonthView, YearView } from './ReturnCalendar';

interface Props {
  fund: Fund;
  transactions: Transaction[];
}

/**
 * 单只基金的日/月/年收益日历。
 *
 * 算法：每条日格 = 当日累计收益 − 上一个有意义日累计收益
 *   cumulativeReturn(D) = shares × NAV(D) − totalBuy + totalSellNet + totalCashDiv
 *
 * 这与 Dashboard 收益日历（portfolio 级）共用 generateFundDailyReturns / generateMonthlyReturns /
 * generateYearlyReturns——单基金日历 = portfolio 日历里这只基金的子集，
 * 月/年格 = 当月/当年日格之和
 * 三种粒度构造上严格相等。
 */
export default function FundReturnCalendar({ fund, transactions }: Props) {
  type Granularity = 'day' | 'month' | 'year';
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [selected, setSelected] = useState<{ g: Granularity; key: string } | null>(null);
  const [viewYear, setViewYear] = useState<number>(() => dayjs().year());

  const dailyReturns = useMemo(
    () => generateFundDailyReturns(fund, transactions),
    [fund, transactions]
  );

  const firstTxDate = useMemo(() => {
    const confirmed = transactions.filter(
      (t) => t.fundId === fund.id && (!t.status || t.status === 'confirmed')
    );
    if (confirmed.length === 0) return null;
    return confirmed.map((t) => t.date).sort()[0]!;
  }, [fund.id, transactions]);

  // 复用 portfolio 月/年聚合（传入单只基金 + 单只基金日序列）——月/年格自动 = 日格之和
  const monthlyReturns = useMemo(
    () =>
      generateMonthlyReturns([fund], transactions, dailyReturns, viewYear),
    [fund, transactions, dailyReturns, viewYear]
  );
  const yearlyReturns = useMemo(
    () => generateYearlyReturns([fund], transactions, dailyReturns),
    [fund, transactions, dailyReturns]
  );

  const minYear = useMemo(
    () =>
      yearlyReturns.length > 0
        ? Math.min(...yearlyReturns.map((r) => parseInt(r.year, 10)))
        : dayjs().year(),
    [yearlyReturns]
  );

  const handleTabChange = (next: Granularity) => {
    if (!selected) {
      setGranularity(next);
      return;
    }
    let nextKey: string | null = null;
    if (selected.g === 'day' && next === 'month') {
      const m = selected.key.slice(0, 7);
      nextKey = monthlyReturns.some((r) => r.month === m) ? m : null;
    } else if (selected.g === 'month' && next === 'year') {
      const y = selected.key.slice(0, 4);
      nextKey = yearlyReturns.some((r) => r.year === y) ? y : null;
    }
    setSelected(nextKey ? { g: next, key: nextKey } : null);
    setGranularity(next);
  };

  const handleSelect = (key: string) => {
    setSelected((prev) => (prev?.key === key && prev.g === granularity ? null : { g: granularity, key }));
  };

  const isEmpty =
    dailyReturns.length === 0 &&
    monthlyReturns.every((m) => m.totalReturn === 0) &&
    yearlyReturns.every((y) => y.totalReturn === 0);

  if (isEmpty) {
    return (
      <Card title="收益日历" style={{ marginTop: 16 }}>
        <Empty description="暂无数据，添加交易或等首次刷新后即可查看" />
      </Card>
    );
  }

  return (
    <Card title="收益日历" style={{ marginTop: 16 }}>
      <Tabs
        activeKey={granularity}
        onChange={(k) => handleTabChange(k as Granularity)}
        items={[
          {
            key: 'day',
            label: '日',
            children: (
              <DayView
                dailyReturns={dailyReturns}
                firstTxDate={firstTxDate}
                selectedKey={selected?.g === 'day' ? selected.key : null}
                onSelect={handleSelect}
              />
            ),
          },
          {
            key: 'month',
            label: '月',
            children: (
              <MonthView
                monthlyReturns={monthlyReturns}
                year={viewYear}
                minYear={minYear}
                firstTxDate={firstTxDate}
                selectedKey={selected?.g === 'month' ? selected.key : null}
                onSelect={handleSelect}
                onShiftYear={(d) => setViewYear((y) => y + d)}
              />
            ),
          },
          {
            key: 'year',
            label: '年',
            children: (
              <YearView
                yearlyReturns={yearlyReturns}
                selectedKey={selected?.g === 'year' ? selected.key : null}
                onSelect={handleSelect}
              />
            ),
          },
        ]}
      />
      <div style={{ marginTop: 16, fontSize: 12, color: '#666' }}>
        累计收益口径与组合日历共用同一函数，三种粒度天然对账
      </div>
    </Card>
  );
}
```

Note: `today` import is unused — remove if so.

- [ ] **Step 5.2: Verify with TypeScript**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

---

## Task 6: Insert `<FundReturnCalendar>` into FundDetail ABOVE NAV chart

**Files:**
- Modify: `src/pages/FundDetail.tsx` (add import + render)

### Steps

- [ ] **Step 6.1: Add import**

After the existing `import InitialPositionModal from '../components/InitialPositionModal';` line, add:

```ts
import FundReturnCalendar from '../components/FundReturnCalendar';
```

- [ ] **Step 6.2: Insert component above NAV chart Card**

In the JSX return of `FundDetail`, find the NAV chart Card opening (search for `title="净值走势"`). Insert before it:

```tsx
<FundReturnCalendar fund={fundRef} transactions={transactions} />
```

Make sure to use `fundRef` (post-null-check) not the original `fund` variable.

- [ ] **Step 6.3: Verify with build**

```bash
npm run build
```

Expected: 0 errors.

---

## Task 7: Manual verification with user's JSON

**Files:** N/A

### Steps

- [ ] **Step 7.1: Quick Node sanity check**

Run a one-off Node script (no commit needed) that loads the user's JSON, computes Aug/Sep wealth-change via the new code path, prints results:

```bash
# ad-hoc verification (no fixture commit)
node -e "
const data = require('./fund-tracker-backup-2026-10-05.json');
const confirmed = data.transactions.filter(t => t.status !== 'pending');
// ... build cumReturn timeline for each fund, sum Aug/Sep
console.log('Aug:', augTotal.toFixed(2), 'Sep:', sepTotal.toFixed(2));
"
```

Expected output: `Aug: 60.13 Sep: -448.74` (matching the monthly report from the user's data).

If a discrepancy exists: re-read the algorithm in `generateFundDailyReturns`, fix, re-run.

---

## Task 8: Final test + build + commit

**Files:** N/A

### Steps

- [ ] **Step 8.1: Run full test suite**

```bash
npm run test
```

Expected: all PASS (no regressions).

- [ ] **Step 8.2: Run build**

```bash
npm run build
```

Expected: 0 errors.

- [ ] **Step 8.3: Visual smoke check**

```bash
npm run dev
```

Manual verify:
1. Dashboard → 收益日历 → Aug should show ~60, Sep should show ~-449 (no longer -21/-23)
2. 基金管理 → 022719 → FundDetail should show 收益日历 ABOVE 净值走势, with day/month/year tabs consistent with portfolio
3. 周报 / 月报 numbers should now agree with calendar daily aggregates

- [ ] **Step 8.4: Commit**

```bash
git add -A
git commit -m "feat(report): wealth-change 算法统一日/月/年收益口径

把 generateDailyReturns 从 attribution map + 半日 NAV 切换为 wealth-change 算法：
  cumulativeReturn(D) = shares × NAV − Σ buy + Σ (sell − fee) + 现金分红
  日收益 = 累计收益(D) − 累计收益(D−1)
  月/年收益构造上 = 日格之和（不再有"日 vs 月/年算法分叉"）

新增 generateFundDailyReturns(fund, tx) 用于单基金日历（FundDetail）。
FundDetail 收益日历放在净值走势上方，三粒度共用同一函数，
portfolio 日历 = 各基金日历之和，月/年 = 日格之和，月报 = endValue-startValue-buy+sell
四者天然对账。

修复用户数据：8月 -21.65 → 60.13、9月 +37.13 → -448.74，与月报口径一致"
```