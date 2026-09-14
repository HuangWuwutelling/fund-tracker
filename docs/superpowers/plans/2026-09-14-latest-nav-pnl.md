# 「最新净值日盈亏」改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「当日盈亏」从"按推算发布日筛选、QDII 写死 T+2"改为"永远展示每只基金最新一对已发布 NAV 的涨跌、并把 NAV 归属日直接标在界面上"，彻底移除对基金类型和披露延迟的任何假设。

**Architecture:** 新增两个纯函数模块——`navPair.ts`（取"可用于配对计算"的 NAV 序列与最新一对）与 `navFreshness.ts`（观测法判断"本次刷新是否有了新净值"，只对比上次看到的最新 NAV 日，不推算发布日）。`calculator.ts` 的 `calcDailyPnl` 被 `calcLatestNavPnl` 取代并删掉 `todayStr` 参数，`reportGenerator` 的今日格改为同一函数以保证 Dashboard / 日历口径不漂移。新鲜度集合存在 Zustand store 里，只被 Dashboard 顶部卡片用来显示"净值待更新"标签。`tradingDays.ts`（`addTradingDays` + `getPublishDate`）整体删除。

**Tech Stack:** React 18 + TypeScript 5.6（`strict` + `noUnusedLocals` + `noUncheckedIndexedAccess`）、Vite 6、Zustand 5、Ant Design 5、dayjs、Vitest 3（本计划新增）。

## Global Constraints

- 纯前端，无后端；所有持久化走 `localStorage`，key 前缀 `fund-tracker:`（见 `src/utils/storage.ts`）。
- `tsconfig.app.json` 的 `include` 是 `["src"]` 且开启 `noUnusedLocals` / `noUnusedParameters` / `noUncheckedIndexedAccess` → **测试文件会被 `npm run build` 类型检查**，任何未使用的 import / 变量都会让构建失败。数组下标访问必须用 `!` 或显式判空。
- 测试环境必须是 `node`（两个新模块都是纯函数，不碰 DOM / localStorage）。
- 测试从 `vitest` 显式 import `describe/it/expect`，**不启用 globals**，因此不需要改 `tsconfig` 的 `types`。
- 中文市场配色：红涨绿跌，用 `pnlColor()`（`src/utils/formatter.ts`）。
- 文案统一用 `LATEST_NAV_PNL_LABEL = '最新净值日盈亏'`（`src/types/index.ts` 导出），不要在任何 UI 里再出现 "T+2"、"QDII 延迟" 这类发布节奏假设。
- 所有 `git commit` 用中文正文 + 传统 commit 前缀（`feat:` / `fix:` / `refactor:` / `chore:`），与本仓库既有历史一致。
- 本计划**不**触碰 `chineseHolidays.isNonTradingDay` 对调休补班周末的判定（该处依赖尚未实现的 `TRANSFER_WORKDAYS` 数据，见文末 Non-goals）。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `package.json` | 修改 | 加 `vitest` devDependency 与 `test` / `test:watch` 脚本 |
| `vite.config.ts` | 修改 | 从 `vitest/config` 取 `defineConfig`，加 `test` 段 |
| `CLAUDE.md` | 修改 | 把"No test runner is configured"改成 Vitest 说明 |
| `src/utils/navPair.ts` | 新建 | 唯一一处决定"哪些 NAV 记录可以参与配对"的地方（美股节假日复制 NAV 的剔除） |
| `src/utils/navPair.test.ts` | 新建 | 上者的单测 |
| `src/utils/navFreshness.ts` | 新建 | 观测法新鲜度：对比上次看到的 NAV 日，不推算发布日 |
| `src/utils/navFreshness.test.ts` | 新建 | 上者的单测 |
| `src/utils/storage.ts` | 修改 | 新增 `getSeenNavMap` / `saveSeenNavMap`（`seen-nav` key，不参与导出/导入） |
| `src/stores/index.ts` | 修改 | 新增 `freshNavFundIds` / `navRefreshedAt` / `recordNavFreshness()` |
| `src/App.tsx` | 修改 | 刷新循环结束后调用 `recordNavFreshness()` |
| `src/utils/calculator.ts` | 修改 | 删 `calcDailyPnl`，加 `calcLatestNavPnl`；`calcFundSummary` 去 `todayStr`、去 `isDailyPnlToday` |
| `src/utils/reportGenerator.ts` | 修改 | `buildAttributionMap` 改用 `usableNavSeries`；今日格改用 `calcLatestNavPnl`；`perFund` 加 `navDate` 去 `isPending` |
| `src/types/index.ts` | 修改 | 加 `LATEST_NAV_PNL_LABEL` |
| `src/pages/Dashboard.tsx` | 修改 | 卡片/列改为"最新净值日盈亏" + 净值日分桶；删 `hasQdii`/`hasNonQdii` |
| `src/pages/FundDetail.tsx` | 修改 | 同口径改名 + 去掉 T+2 文案与 `isNonTradingDay`/`today` import |
| `src/components/HoldingsSummary.tsx` | 修改 | 分组聚合改为净值日分桶；删休市文案分支 |
| `src/components/ReturnCalendar.tsx` | 修改 | `perFund` 明细展示 NAV 归属日；去掉 T+2 文案 |
| `src/utils/tradingDays.ts` | **删除** | 全部职责已被 `navPair.ts` + `navFreshness.ts` 取代 |
| `src/utils/chineseHolidays.ts` | 修改 | 仅更新过期注释（行为不变） |
| `src/utils/usHolidays.ts` | 修改 | 仅更新过期注释（行为不变） |

**为什么拆两个新文件而不是塞进 `calculator.ts`：** `navPair` 是"数据可用性"规则（哪些记录能配对），`navFreshness` 是"观测基线"规则（比上次多了什么），两者被完全不同的调用方使用——`navPair` 被计算层用（每只基金每次渲染都要），`navFreshness` 只在刷新结束时跑一次。混在一起会让 `calculator.ts` 继续膨胀且把 localStorage 概念漏进纯计算模块。

**任务依赖顺序：** 1 → 2 → 3 → 4 → 5 → 6，**串行**，每个任务一个提交，每个提交构建都是绿的。

Task 5 把"计算层"与"UI"合在同一个任务、同一个提交里（Step 1-11 改计算层，Step 12-23 改 UI，Step 24 才提交）。这是刻意的：`calcFundSummary` 的签名变化会让三处 UI 调用点编译失败，中途提交会留下一个红色构建，既无法 bisect 也会让 reviewer 把"构建失败"误报成缺陷。类型报错在 Task 5 内部充当"把所有调用点逼出来"的清单，但不跨越提交边界。

---

### Task 1: 引入 Vitest 并跑通第一个测试

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Modify: `CLAUDE.md:15`（`No test runner is configured.` 那行）
- Create: `src/utils/navPair.ts`（本任务只建文件骨架 + 一个占位实现，Task 2 填内容）
- Create: `src/utils/navPair.test.ts`（本任务只放一个 smoke test，Task 2 扩充）

**Interfaces:**
- Consumes: 无
- Produces: `npm run test` 命令可用；`vite.config.ts` 里 `test.environment = 'node'`、`test.include = ['src/**/*.test.ts']`

- [ ] **Step 1: 安装 Vitest**

```bash
npm install -D vitest
```

Expected: `package.json` 的 `devDependencies` 里出现 `"vitest"`，`npm install` 无 peer dependency 报错（Vitest 3 支持 Vite 6）。

- [ ] **Step 2: 加测试脚本**

修改 `package.json` 的 `scripts` 段，改成：

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

（保留你仓库里现有的 `dev` / `build` / `preview` 三条不动，只追加 `test` 与 `test:watch`。）

- [ ] **Step 3: 配置 Vitest**

把 `vite.config.ts` 整体替换为：

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/fund-tracker/',
  test: {
    // 纯函数单测，不碰 DOM / localStorage —— 用 node 环境，省掉 jsdom 依赖
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

> `defineConfig` 从 `vitest/config` 导入而不是 `vite`：这样 `test` 字段才有类型。`vite` 的 `defineConfig` 会把它当成未知字段静默丢弃。

- [ ] **Step 4: 写一个必然失败的 smoke test**

创建 `src/utils/navPair.ts`：

```ts
import type { Fund, NavRecord } from '../types';

/** 占位实现——Task 2 替换为真实逻辑 */
export function usableNavSeries(_fund: Fund, navHistory: NavRecord[]): NavRecord[] {
  return navHistory;
}
```

创建 `src/utils/navPair.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { usableNavSeries } from './navPair';
import type { Fund, NavRecord } from '../types';

function fund(name: string, type: Fund['type'] = 'qdii'): Fund {
  return { id: 'f1', name, platformId: 'p1', type, currentNav: 1, navDate: '' };
}

function nav(date: string, value: number): NavRecord {
  return { date, nav: value, accNav: value };
}

describe('usableNavSeries', () => {
  it('按日期升序返回', () => {
    const out = usableNavSeries(fund('测试基金', 'index'), [
      nav('2026-09-11', 1.5),
      nav('2026-09-10', 1.4),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-10', '2026-09-11']);
  });
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL —— `AssertionError`，`expected [ '2026-09-11', '2026-09-10' ] to deeply equal [ '2026-09-10', '2026-09-11' ]`（占位实现没排序）。

- [ ] **Step 6: 让测试通过（最小排序实现）**

把 `src/utils/navPair.ts` 改成：

```ts
import type { Fund, NavRecord } from '../types';

/** 占位实现——Task 2 补上美股节假日过滤 */
export function usableNavSeries(_fund: Fund, navHistory: NavRecord[]): NavRecord[] {
  return [...navHistory].sort((a, b) => a.date.localeCompare(b.date));
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npm run test`
Expected: PASS —— `1 passed (1)`。

- [ ] **Step 8: 更新 CLAUDE.md**

把 `CLAUDE.md` 里这两行：

```
No test runner is configured. Verification is manual via the dev server.
```

替换为：

```
`npm run test` 跑 Vitest 单测（纯函数 utils，node 环境）。UI 交互仍需 `npm run dev` 手工验证。
```

同时在 Quick Commands 的代码块里追加：

```bash
npm run test             # Vitest 单测（src/**/*.test.ts）
```

- [ ] **Step 9: 确认类型检查不被测试文件破坏**

Run: `npm run build`
Expected: 构建成功，`dist/` 生成。若报 `Cannot find module 'vitest'`，说明 `npm install -D vitest` 没装成功，回到 Step 1。

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json vite.config.ts CLAUDE.md src/utils/navPair.ts src/utils/navPair.test.ts
git commit -m "chore(test): 引入 Vitest（node 环境，src/**/*.test.ts）"
```

---

### Task 2: `navPair.ts` —— 唯一一处"NAV 可配对性"规则

**Files:**
- Modify: `src/utils/navPair.ts`
- Modify: `src/utils/navPair.test.ts`

**Interfaces:**
- Consumes: `isUsHoliday(date: string): boolean`、`isUsTrackedQdii(fundName: string): boolean`（均已存在于 `src/utils/usHolidays.ts:64` 与 `:107`）
- Produces:
  - `usableNavSeries(fund: Fund, navHistory: NavRecord[]): NavRecord[]` —— 按 `date` 升序，已剔除美股节假日复制 NAV
  - `latestNavPair(fund: Fund, navHistory: NavRecord[]): { curr: NavRecord; prev: NavRecord } | null` —— 不足 2 条可用记录返回 `null`

- [ ] **Step 1: 写失败测试**

把 `src/utils/navPair.test.ts` 整体替换为：

```ts
import { describe, it, expect } from 'vitest';
import { latestNavPair, usableNavSeries } from './navPair';
import type { Fund, NavRecord } from '../types';

function fund(name: string, type: Fund['type'] = 'qdii'): Fund {
  return { id: 'f1', name, platformId: 'p1', type, currentNav: 1, navDate: '' };
}

function nav(date: string, value: number): NavRecord {
  return { date, nav: value, accNav: value };
}

describe('usableNavSeries', () => {
  it('A 股 / 债券基金原样返回并按日期升序', () => {
    const out = usableNavSeries(fund('易方达蓝筹精选混合', 'mixed'), [
      nav('2026-09-11', 1.5),
      nav('2026-09-10', 1.4),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-10', '2026-09-11']);
  });

  it('美股跟踪 QDII 剔除美股节假日（2026-09-07 劳工节）的复制 NAV', () => {
    const out = usableNavSeries(fund('广发纳斯达克100ETF联接(QDII)A'), [
      nav('2026-09-04', 8.1742),
      nav('2026-09-07', 8.1747),
      nav('2026-09-08', 8.06),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-08']);
  });

  it('港股 QDII 不套用美股节假日体系', () => {
    const out = usableNavSeries(fund('华夏恒生ETF联接(QDII)C'), [
      nav('2026-09-04', 1.1),
      nav('2026-09-07', 1.2),
      nav('2026-09-08', 1.3),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-07', '2026-09-08']);
  });
});

describe('latestNavPair', () => {
  it('取最新的相邻一对，且跳过被过滤的复制 NAV', () => {
    const pair = latestNavPair(fund('广发纳斯达克100ETF联接(QDII)A'), [
      nav('2026-09-04', 8.1742),
      nav('2026-09-07', 8.1747),
      nav('2026-09-10', 8.0487),
      nav('2026-09-11', 8.1177),
    ]);
    expect(pair?.curr.date).toBe('2026-09-11');
    expect(pair?.prev.date).toBe('2026-09-10');
  });

  it('0 条或 1 条可用记录返回 null', () => {
    expect(latestNavPair(fund('易方达蓝筹精选混合', 'mixed'), [])).toBeNull();
    expect(latestNavPair(fund('易方达蓝筹精选混合', 'mixed'), [nav('2026-09-11', 1)])).toBeNull();
  });

  it('过滤后只剩 1 条也返回 null', () => {
    // 9/7 是美股劳工节会被剔除，可用记录只剩 9/8 一条
    expect(
      latestNavPair(fund('广发纳斯达克100ETF联接(QDII)A'), [
        nav('2026-09-07', 8.1747),
        nav('2026-09-08', 8.06),
      ])
    ).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL —— `latestNavPair is not a function`（`navPair.ts` 还没导出它），以及"美股跟踪 QDII 剔除…"用例失败（占位实现没过滤）。

- [ ] **Step 3: 实现**

把 `src/utils/navPair.ts` 整体替换为：

```ts
import type { Fund, NavRecord } from '../types';
import { isUsHoliday, isUsTrackedQdii } from './usHolidays';

/**
 * 返回"可用于配对计算"的 NAV 序列（按日期升序）。
 *
 * 唯一的过滤：跟踪美股市场的 QDII 剔除美股节假日的「复制 NAV」记录
 * （如 2026-09-07 美股劳工节，基金公司当天不发 NAV，用上一交易日净值填充）。
 * 不剔除时，节假日次日的真实涨跌会被摊成两天：9/4 → 9/7(=9/4) → 9/8 会把
 * 9/8 的全部涨跌只归到 9/8 那一天，而 9/8 的 attribution 本该是 9/4 → 9/8 的合计。
 *
 * 港股 / 日股 QDII、A 股基金不套用美股节假日体系，原样返回。
 *
 * 注意：localStorage 里的 navHistory 始终保持原始记录——FundDetail 的净值曲线仍应
 * 展示这些空档日；只在"配对计算"时跳过。所以本函数返回的是**新数组**，不修改入参。
 */
export function usableNavSeries(fund: Fund, navHistory: NavRecord[]): NavRecord[] {
  const sorted = [...navHistory].sort((a, b) => a.date.localeCompare(b.date));
  return isUsTrackedQdii(fund.name) ? sorted.filter((r) => !isUsHoliday(r.date)) : sorted;
}

/**
 * 最新一对可用 NAV：curr = 最新的已发布净值，prev = 前一期。
 *
 * 这是"最新净值日盈亏"的数据源。它**不判断今天、不推算发布日、不看基金类型**——
 * 只问"这只基金现在能拿到的最后两期净值是哪两期"。理由：QDII 的披露延迟按基金 /
 * 按市场浮动（普遍 1 个交易日，法规上限 2 个交易日，见《QDII 基金运作指引》），
 * 任何写死的常数都会在部分基金上错位一天，把涨幅显示成跌幅。
 *
 * 排序依赖：`usableNavSeries` 已升序，因此取尾部两个即最新一对；相邻性即"上一期"，
 * 中间不会有被跳过的记录。
 *
 * 可用记录不足 2 条返回 null（新基金 / 净值尚未拉到 / 过滤后只剩 1 条）。
 */
export function latestNavPair(
  fund: Fund,
  navHistory: NavRecord[]
): { curr: NavRecord; prev: NavRecord } | null {
  const usable = usableNavSeries(fund, navHistory);
  if (usable.length < 2) return null;
  return { curr: usable[usable.length - 1]!, prev: usable[usable.length - 2]! };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS —— `6 passed (6)`。

> 若"9/7 劳工节"用例失败，说明 `usHolidays.ts` 的年份表没覆盖 2026。用
> `node -e "console.log(new Date('2026-09-07T00:00:00').getDay())"`（应输出 `1`，周一）
> 确认 2026-09-07 确实是 9 月第一个周一，然后检查 `usHolidays.ts` 里 2026 年的
> 劳工节条目。**不要**改用例去迁就实现。

- [ ] **Step 5: Commit**

```bash
git add src/utils/navPair.ts src/utils/navPair.test.ts
git commit -m "feat(calculator): 新增 navPair，统一 NAV 可配对性规则（含美股节假日过滤）"
```

---

### Task 3: `navFreshness.ts` —— 观测法新鲜度

**Files:**
- Create: `src/utils/navFreshness.ts`
- Create: `src/utils/navFreshness.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，不 import storage，保持可测）
- Produces:
  - `type SeenNavMap = Record<string, string>` —— `fundId → 上次刷新看到的最新 NAV 归属日`
  - `isNewlyPublished(previousSeen: string | undefined, latestNavDate: string | undefined): boolean`
  - `computeFreshness(funds: Fund[], latestDateOf: (fund: Fund) => string | undefined, previousSeen: SeenNavMap): { fresh: Set<string>; nextSeen: SeenNavMap }`

- [ ] **Step 1: 写失败测试**

创建 `src/utils/navFreshness.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { computeFreshness, isNewlyPublished } from './navFreshness';
import type { Fund } from '../types';

function fund(id: string): Fund {
  return { id, name: `基金${id}`, platformId: 'p1', type: 'index', currentNav: 1, navDate: '' };
}

describe('isNewlyPublished', () => {
  it('NAV 日前进 → true', () => {
    expect(isNewlyPublished('2026-09-10', '2026-09-11')).toBe(true);
  });

  it('NAV 日不变 → false', () => {
    expect(isNewlyPublished('2026-09-11', '2026-09-11')).toBe(false);
  });

  it('无基线（首次观测 / 新添加的基金）→ true', () => {
    expect(isNewlyPublished(undefined, '2026-09-11')).toBe(true);
  });

  it('完全没有 NAV → false（哪怕无基线）', () => {
    expect(isNewlyPublished('2026-09-10', undefined)).toBe(false);
    expect(isNewlyPublished(undefined, undefined)).toBe(false);
  });
});

describe('computeFreshness', () => {
  it('NAV 日前进的基金进 fresh，基线被更新', () => {
    const funds = [fund('a'), fund('b')];
    const latest: Record<string, string> = { a: '2026-09-14', b: '2026-09-11' };
    const { fresh, nextSeen } = computeFreshness(funds, (f) => latest[f.id], {
      a: '2026-09-11',
      b: '2026-09-11',
    });
    expect([...fresh]).toEqual(['a']);
    expect(nextSeen).toEqual({ a: '2026-09-14', b: '2026-09-11' });
  });

  it('首次观测（无任何基线）全部视为 fresh', () => {
    const { fresh, nextSeen } = computeFreshness([fund('a')], () => '2026-09-14', {});
    expect([...fresh]).toEqual(['a']);
    expect(nextSeen).toEqual({ a: '2026-09-14' });
  });

  it('拿不到 NAV 的基金不 fresh，且旧基线被保留', () => {
    const { fresh, nextSeen } = computeFreshness([fund('a')], () => undefined, { a: '2026-09-11' });
    expect(fresh.size).toBe(0);
    expect(nextSeen).toEqual({ a: '2026-09-11' });
  });

  it('已移除的基金从基线中剔除', () => {
    const { nextSeen } = computeFreshness([], () => undefined, { gone: '2026-09-11' });
    expect(nextSeen).toEqual({});
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL —— `Failed to resolve import "./navFreshness"`。

- [ ] **Step 3: 实现**

创建 `src/utils/navFreshness.ts`：

```ts
import type { Fund } from '../types';

/** fundId → 上次刷新时观测到的最新 NAV 归属日（YYYY-MM-DD） */
export type SeenNavMap = Record<string, string>;

/**
 * 判断某只基金"本次刷新是否拿到了新一期净值"。
 *
 * 用**观测法**而不是推算发布日：对照上次刷新时看到的最新 NAV 日，日期前进了就是有新数据。
 * 这样不需要知道基金类型、不需要知道它是 A 股还是 QDII、不需要知道它跟踪哪个市场——
 * 只要基金公司发布了新净值就一定能被观测到，没发布就一定观测不到。
 *
 *   - 无基线（首次观测 / 新添加的基金）：视为有新数据，避免首屏整块显示"待更新"
 *   - 完全没有 NAV：false（无数据 ≠ 有新数据）
 *
 * 注意这不影响盈亏数字本身——数字永远是最新一对 NAV 的涨跌。本函数只驱动
 * "本轮刷新有没有新东西"这一个 UI 提示。
 */
export function isNewlyPublished(
  previousSeen: string | undefined,
  latestNavDate: string | undefined
): boolean {
  if (!latestNavDate) return false;
  if (!previousSeen) return true;
  return latestNavDate > previousSeen;
}

/**
 * 对全部基金做一次新鲜度判定，同时算出"下次比较用"的基线。
 *
 * @param funds         当前基金列表（基线以它为准，已移除的基金会被剔除）
 * @param latestDateOf  取某只基金最新可用 NAV 的归属日（无则返回 undefined）
 * @param previousSeen  上次刷新保存的基线
 * @returns fresh       本次有新净值的 fundId 集合
 * @returns nextSeen    下次刷新写入的基线
 */
export function computeFreshness(
  funds: Fund[],
  latestDateOf: (fund: Fund) => string | undefined,
  previousSeen: SeenNavMap
): { fresh: Set<string>; nextSeen: SeenNavMap } {
  const fresh = new Set<string>();
  const nextSeen: SeenNavMap = {};

  for (const fund of funds) {
    const latest = latestDateOf(fund);
    // 拿不到 NAV 时保留旧基线——否则临时拉取失败会让下次刷新误报"有新净值"
    if (latest) nextSeen[fund.id] = latest;
    else if (previousSeen[fund.id]) nextSeen[fund.id] = previousSeen[fund.id]!;
    if (isNewlyPublished(previousSeen[fund.id], latest)) fresh.add(fund.id);
  }

  return { fresh, nextSeen };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS —— `14 passed (14)`（6 个来自 Task 2 + 8 个本任务）。

- [ ] **Step 5: Commit**

```bash
git add src/utils/navFreshness.ts src/utils/navFreshness.test.ts
git commit -m "feat(calculator): 新增 navFreshness 观测法基线，替代按基金类型推算发布日"
```

---

### Task 4: 接通观测基线（storage + store + App 刷新钩子）

**Files:**
- Modify: `src/utils/storage.ts`（在 `--- Nav History (per fund) ---` 段之后插入新段）
- Modify: `src/stores/index.ts`
- Modify: `src/App.tsx:148-151`

**Interfaces:**
- Consumes: `computeFreshness`、`SeenNavMap`（Task 3）；`latestNavPair`（Task 2）
- Produces:
  - `storage.getSeenNavMap(): SeenNavMap`、`storage.saveSeenNavMap(map: SeenNavMap): void`
  - store 上新增 `freshNavFundIds: Set<string>`、`navRefreshedAt: string | null`、`recordNavFreshness(): void`

- [ ] **Step 1: storage 增加观测基线读写**

在 `src/utils/storage.ts` 里，找到 `--- Nav History (per fund) ---` 段落末尾的 `removeAllNavHistory` 函数（第 114-121 行），在它**之后**插入：

```ts
// --- Seen NAV baseline (观测法新鲜度基线) ---
// key 故意不叫 `nav:*`：importAllData 会清理所有 `nav:` 前缀的残留 key，
// 而这份基线是**设备本地观测**而非用户数据，不参与 exportAllData / importAllData
// （换设备 / 导入备份后没有基线 → 首次观测全部视为"有新净值"，一次刷新后自愈）。
export function getSeenNavMap(): Record<string, string> {
  return getItem<Record<string, string>>('seen-nav', {});
}

export function saveSeenNavMap(map: Record<string, string>): void {
  setItem('seen-nav', map);
}
```

同时把 `ExportData` 接口上方的 import 行确认无需改动（`getSeenNavMap` 只用 `Record<string,string>`，无需新类型）。

- [ ] **Step 2: store 加新鲜度状态与 action**

在 `src/stores/index.ts` 里，把 import 段（第 1-9 行）改为：

```ts
import { create } from 'zustand';
import type { Platform, Fund, Transaction, DcaPlan, DailySnapshot, Settings, NavRecord } from '../types';
import * as storage from '../utils/storage';
import { generateSnapshot } from '../utils/snapshot';
import { getPlanDueDates } from '../utils/calculator';
import { latestNavPair } from '../utils/navPair';
import { computeFreshness } from '../utils/navFreshness';
import { today } from '../utils/formatter';
import { getFundTypeFromName } from '../api/fundApi';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
```

在 interface `FundTrackerState` 里，找到 `// Actions - Refresh trigger` 那组（第 62-64 行），在它**之前**插入：

```ts
  // Actions - Nav freshness (观测法：不推算发布日，只对比"上次刷新看到的最新 NAV 日")
  /** 本次刷新中"最新 NAV 日较上次前进"的基金 id 集合；未刷新过时为空集 */
  freshNavFundIds: Set<string>;
  /** 最近一次刷新完成时间（ISO 字符串）；null = 本次会话还没跑过刷新 */
  navRefreshedAt: string | null;
  /** 刷新结束后调用：对比并更新本地观测基线，产出 freshNavFundIds */
  recordNavFreshness: () => void;

```

在 store 初始状态里（第 73-79 行的 `export const useStore = create<...>` 对象开头），把 `settings:` 那一行后面追加：

```ts
  freshNavFundIds: new Set<string>(),
  navRefreshedAt: null,
```

在 `// --- Refresh trigger ---` 段（第 282-287 行）**之后**插入新实现：

```ts
  // --- Nav freshness ---
  recordNavFreshness: () => {
    const { funds, getNavHistory } = get();
    const { fresh, nextSeen } = computeFreshness(
      funds,
      // "最新 NAV 日"与盈亏数字同源：都走 latestNavPair，避免两处对"最新"的定义漂移
      (fund) => latestNavPair(fund, getNavHistory(fund.id))?.curr.date,
      storage.getSeenNavMap()
    );
    storage.saveSeenNavMap(nextSeen);
    set({ freshNavFundIds: fresh, navRefreshedAt: new Date().toISOString() });
  },
```

最后在 `importData` 的 `set({...})` 之后追加基线重置（因为导入会换掉整批基金，旧基线无意义）：

```ts
    // 导入后基金集合已变，旧观测基线作废——重置为空，让下一次刷新重新建立
    set({ freshNavFundIds: new Set<string>(), navRefreshedAt: null });
    // 导入后立刻补定投记录（页面 mount 的自动记录早已跑过，导入不会重跑它）
    return get().settings.dcaAutoRecord ? get().autoRecordDcaPlans() : 0;
```

（即把原来那行 `return get().settings.dcaAutoRecord ? ... : 0;` 之前插入重置。）

- [ ] **Step 3: App.tsx 刷新循环结束后打点**

在 `src/App.tsx` 里，找到第 144-149 行：

```ts
    const confirmedCount = autoConfirmPending();
    if (refreshGenerationRef.current !== myGen) return;
    if (confirmedCount > 0) {
      message.success(`已自动确认 ${confirmedCount} 笔历史交易`);
    }
    const updatedFunds = useStore.getState().funds;
```

在 `message.success` 块与 `const updatedFunds` 之间插入：

```ts
    // 所有 updateNavHistory 都已完成 → 用刚写入的 navHistory 对比上次观测基线。
    // 必须放在循环之后：freshness 读的就是 navHistory，提前调用会看到旧数据。
    useStore.getState().recordNavFreshness();
    if (refreshGenerationRef.current !== myGen) return;
```

- [ ] **Step 4: 确认既有测试仍通过 + 类型检查**

Run: `npm run test && npm run build`
Expected: `14 passed (14)`；构建成功（此时 UI 还没改，`calcFundSummary` 签名未变，所以构建应通过）。

- [ ] **Step 5: Commit**

```bash
git add src/utils/storage.ts src/stores/index.ts src/App.tsx
git commit -m "feat(store): 刷新后记录 NAV 观测基线，产出 freshNavFundIds"
```

---

### Task 5: 核心语义切换 + UI 对齐（计算层与 UI 同一个提交）

**Files:**
- Modify: `src/utils/calculator.ts:2, 117-157, 435-468`
- Modify: `src/utils/reportGenerator.ts:2, 7, 9, 88-110, 134-165, 245-275, 288-352`
- Modify: `src/types/index.ts:60`（在 `FUND_TYPE_LABELS` 之前新增常量）
- Modify: `src/pages/Dashboard.tsx`
- Modify: `src/pages/FundDetail.tsx`
- Modify: `src/components/HoldingsSummary.tsx`
- Modify: `src/components/ReturnCalendar.tsx`

**Interfaces:**
- Consumes: `latestNavPair`、`usableNavSeries`（Task 2）
- Produces:
  - `calcLatestNavPnl(fund: Fund, navHistory: NavRecord[], fundTransactions: Transaction[]): { pnl: number | null; currDate: string; prevDate: string }`
  - `calcFundSummary(fund: Fund, transactions: Transaction[], navHistory: NavRecord[]): { shares: number; cost: number; marketValue: number; totalReturn: number; returnRate: number; dailyPnl: number | null; currNavDate: string; prevNavDate: string; xirr: number; dividend: number }` —— **去掉了 `todayStr` 参数与 `isDailyPnlToday` 字段**
  - `DailyReturn.perFund[]` 元素：`{ fundId: string; fundName: string; returnAmount: number; navDate: string; noNav?: boolean }` —— **`isPending` 改名为 `noNav`，新增 `navDate`**
  - `generateDailyReturns(funds, transactions)` 签名不变
  - `LATEST_NAV_PNL_LABEL = '最新净值日盈亏'`（`src/types/index.ts` 导出）

> ⚠️ 本任务分两段：**Step 1-9 改计算层，Step 10 之后改 UI**。中间构建会失败是正常的，
> **不要**在中途提交、也不要在中途把 UI 改成临时兼容——类型报错正是用来把所有调用点逼出来的。
> 唯一的 commit 在最后一步。`npx tsc -b` 可以在中途随时查看还剩哪些文件没跟上。

- [ ] **Step 1: calculator 换 import**

把 `src/utils/calculator.ts` 第 1-4 行：

```ts
import type { Transaction, Fund, NavRecord, DcaPlan } from '../types';
import { findPublishedNavPair } from './tradingDays';
import { lookupNavForDate } from './navLookup';
import dayjs from 'dayjs';
```

改为：

```ts
import type { Transaction, Fund, NavRecord, DcaPlan } from '../types';
import { latestNavPair } from './navPair';
import { lookupNavForDate } from './navLookup';
import dayjs from 'dayjs';
```

- [ ] **Step 2: 用 `calcLatestNavPnl` 替换 `calcDailyPnl`**

把 `src/utils/calculator.ts` 第 117-157 行整段（`calcDailyPnl` 的 JSDoc + 函数体）替换为：

```ts
/**
 * 计算单只基金"最新净值日"的盈亏。
 *
 * 取该基金最新一对可用 NAV（curr = 最新已发布，prev = 前一期），算出
 * `curr.nav − prev.nav` 对应的份额损益。**不对发布节奏做任何假设**——不判断基金类型、
 * 不推算发布日，数字永远精确对应它自己的 NAV 归属日（由 currDate 返回，UI 负责展示）。
 *
 * 为什么不再按"发布日 === 今天"筛选：QDII 的披露延迟按基金 / 按市场浮动（普遍 1 个
 * 交易日，法规上限 2 个交易日），任何写死的常数都会在部分基金上错位一天。实测 2026-09-14
 * （周一）晚：全部 6 只 QDII 的最新 NAV 都归属 9/11，而 `+2 交易日` 模型预测 9/10 —— 都不符，
 * 结果把广发纳指100 的 +0.857% 显示成 −1.089%（符号都反了）。
 * 取"最新已发布的一对"则与渠道 App（支付宝 / 天天基金 / 蛋卷）口径一致。
 *
 * 返回 pnl = null 只表示"可用 NAV 不足 2 条"（新基金 / 净值未拉到），UI 显示 "—"。
 */
export function calcLatestNavPnl(
  fund: Fund,
  navHistory: NavRecord[],
  fundTransactions: Transaction[]
): { pnl: number | null; currDate: string; prevDate: string } {
  const pair = latestNavPair(fund, navHistory);
  if (!pair) return { pnl: null, currDate: '', prevDate: '' };

  const shares = calcShares(fundTransactions);
  // sharesBefore 必须锚在这一对 NAV 的日期上，而不是"今天"：
  // 这一对 NAV 可能归属 3 天前，用今天的份额做拆分基准会把今天买入的份额错误地
  // 摊进"上一个净值日 → 最新净值日"的涨跌里（多算半段）。
  // 用 `< pair.curr.date` 而非 `<= pair.prev.date`：与改造前 A 股的行为完全一致
  // （原实现是 `t.date < todayStr`，而 todayStr 就是 A 股的 curr NAV 日），
  // 保证只改 QDII 口径、不动 A 股语义。
  const sharesBefore = calcShares(fundTransactions.filter((t) => t.date < pair.curr.date));

  return {
    pnl: calcDailyPnlBySegments(pair.prev.nav, pair.curr.nav, sharesBefore, shares),
    currDate: pair.curr.date,
    prevDate: pair.prev.date,
  };
}
```

- [ ] **Step 3: `calcFundSummary` 去掉 `todayStr`**

把 `src/utils/calculator.ts` 第 435-468 行整段替换为：

```ts
/**
 * 计算基金汇总信息。
 *
 * 不再接收 `todayStr`：盈亏取的是"最新一对已发布 NAV"，与今天是哪天无关，
 * 传入今天反而会诱导调用方以为这里有"今天"的口径。UI 若需要知道"今天是否非交易日"，
 * 自己调 `isNonTradingDay()`。
 */
export function calcFundSummary(
  fund: Fund,
  transactions: Transaction[],
  navHistory: NavRecord[]
) {
  const fundTransactions = onlyConfirmed(transactions).filter((t) => t.fundId === fund.id);
  const shares = calcShares(fundTransactions);
  const cost = calcCost(fundTransactions);
  const marketValue = calcMarketValue(shares, fund.currentNav);
  const totalReturn = calcReturn(marketValue, cost);
  const returnRate = calcReturnRate(totalReturn, cost);
  const latest = calcLatestNavPnl(fund, navHistory, fundTransactions);
  const xirr = calcXIRR(fundTransactions, marketValue);
  const dividend = calcDividendTotal(fundTransactions);

  return {
    shares,
    cost,
    marketValue,
    totalReturn,
    returnRate,
    dailyPnl: latest.pnl,
    currNavDate: latest.currDate,
    prevNavDate: latest.prevDate,
    xirr,
    dividend,
  };
}
```

- [ ] **Step 4: reportGenerator 换 import**

把 `src/utils/reportGenerator.ts` 第 2 行与第 7 行改为：

```ts
import { calcShares, calcLatestNavPnl, calcDailyPnlBySegments, onlyConfirmed, isInPlanWindow } from './calculator';
```

```ts
import { latestNavPair, usableNavSeries } from './navPair';
```

（第 7 行原本是 `import { getPublishDate } from './tradingDays';`，整行替换掉。第 9 行的 `import { isUsHoliday, isUsTrackedQdii } from './usHolidays';` 现在只有 `buildAttributionMap` 用 —— 改完后两个都不再被本文件直接引用，**一并删除第 9 行**。）

- [ ] **Step 5: `buildAttributionMap` 改用 `usableNavSeries`**

把 `src/utils/reportGenerator.ts` 第 136-152 行的循环体开头：

```ts
  for (const fund of funds) {
    const hist = getNavHistory(fund.id);
    if (hist.length < 2) continue;
    const sorted = [...hist].sort((a, b) => a.date.localeCompare(b.date));
```

以及第 149-151 行：

```ts
    const usable = isUsTrackedQdii(fund.name)
      ? sorted.filter((r) => !isUsHoliday(r.date))
      : sorted;
```

替换为：

```ts
  for (const fund of funds) {
    // 可用性规则（含美股节假日复制 NAV 的剔除）统一收敛在 usableNavSeries，
    // 与 latestNavPair 共用同一份判断，避免"日历不算、卡片算"的口径分叉。
    const usable = usableNavSeries(fund, getNavHistory(fund.id));
    if (usable.length < 2) continue;
```

（原第 142-148 行那段解释美股节假日剔除的注释保留，但把"仅跟踪美股指数的 QDII 才应用此过滤"这句挪进 `navPair.ts` 的文档——本文件里删掉重复部分即可。）

- [ ] **Step 6: `DailyReturn` 类型改字段**

把 `src/utils/reportGenerator.ts` 第 88-110 行的 `DailyReturn` 接口替换为：

```ts
export interface DailyReturn {
  date: string;
  /** 当天总收益（仅含价格变动 × 份额，不扣除当日净投入；当日投入见 Dashboard 顶部 StatCard） */
  totalReturn: number;
  /**
   * 各基金贡献的收益。
   * - 历史格：`navDate === date`（归属日就是这一天）
   * - 今日格：`navDate` 是该基金**最新已发布 NAV 的归属日**，可能早于 `date`
   *   （A 股通常当天，QDII 常落后 1 个交易日）。UI 用它把口径写在界面上。
   */
  perFund: {
    fundId: string;
    fundName: string;
    returnAmount: number;
    navDate: string;
    /**
     * 仅"今日"行可能为 true：该基金可用 NAV 不足 2 期，returnAmount 强制为 0。
     * UI 渲染时区别于"持平=0"——显示 "— 无净值数据"。
     * 历史日的 perFund 永远是 false（归属已确定，一定有成对的 NAV）。
     */
    noNav?: boolean;
  }[];
  /**
   * 仅"今日"行可能为 true：**有持仓**的基金全部没有可用 NAV 对（数据未拉到 / 刷新失败）。
   * UI 用灰格 + "净值待更新"提示。历史格永远是 false。
   */
  isPending?: boolean;
}
```

- [ ] **Step 7: 历史格的 `perFund` 补 `navDate`**

把 `src/utils/reportGenerator.ts` 第 291-305 行的历史格 `perFund` 改为：

```ts
    const perFund = funds.map((fund) => {
      const attr = dayAttrs?.get(fund.id);
      // 无 attr：当天该基金没有 NAV 变化（节假日 / QDII 复制 NAV 被过滤）→ 0 涨跌。
      // navDate 留空，UI 不显示归属日标签（没变化谈不上归属哪天）。
      if (!attr) return { fundId: fund.id, fundName: fund.name, returnAmount: 0, navDate: '' };
      const timeline = sharesTimeline.get(fund.id);
      const sharesAfter = getSharesAsOf(timeline, snap.date);
      if (sharesAfter <= 0) {
        return { fundId: fund.id, fundName: fund.name, returnAmount: 0, navDate: '' };
      }
      // 按子时段拆分：shares_before = snap.date 之前的累计份额（不含当日交易）
      // 避免买入/卖出日过度计入新份额（参见 calcDailyPnlBySegments 注释）
      const sharesBefore = getSharesAsOf(timeline, attr.prev.date);
      return {
        fundId: fund.id,
        fundName: fund.name,
        returnAmount: calcDailyPnlBySegments(attr.prev.nav, attr.curr.nav, sharesBefore, sharesAfter),
        navDate: attr.curr.date,
      };
    });
```

- [ ] **Step 8: 今日格改用 `calcLatestNavPnl`**

在 `src/utils/reportGenerator.ts` 第 272-273 行：

```ts
  const attributionMap = buildAttributionMap(funds);
  const sharesTimeline = buildSharesTimeline(funds, confirmed);
  const result: DailyReturn[] = [];
```

之后追加为：

```ts
  const attributionMap = buildAttributionMap(funds);
  const sharesTimeline = buildSharesTimeline(funds, confirmed);

  // 按基金预分桶 confirmed 交易——今日格要按 fund 调 calcLatestNavPnl，
  // 它内部用 calcShares 算份额，与 calcFundSummary 完全同源，
  // 保证「日历今日格合计 === Dashboard 卡片数字」这个来之不易的不变量继续成立。
  const txsByFund = new Map<string, Transaction[]>();
  for (const tx of confirmed) {
    const arr = txsByFund.get(tx.fundId);
    if (arr) arr.push(tx);
    else txsByFund.set(tx.fundId, [tx]);
  }

  const result: DailyReturn[] = [];
```

然后把第 311-352 行（`// 今天格：...` 到 `result.push({ date: todayStr, ... });` 与 `result.sort`）整段替换为：

```ts
  // 今天格：旁路 attribution map，直接取每只基金"最新一对已发布 NAV"（同 Dashboard 口径）
  // 即便 today 不在 snapshots 列表也照常生成——避免"关闭自动刷新 → today 显示 ¥0"的退化
  // 但如果 today 是非交易日（周末 / 节假日），今天格不生成——与历史格一致
  //
  // 与历史格的区别：历史格回答"9/1 那天赚了多少"（navDate === date）；
  // 今天格回答"现在屏幕上这只基金最近一期净值赚了多少"（navDate 可能 < date）。
  // 两者都是"净值的真实归属日"口径，所以合计值天然可比、不需要凑发布节奏。
  if (funds.length > 0 && !isNonTradingDay(todayStr)) {
    const perFund = funds.map((fund) => {
      const daily = calcLatestNavPnl(fund, getNavHistory(fund.id), txsByFund.get(fund.id) ?? []);
      return {
        fundId: fund.id,
        fundName: fund.name,
        returnAmount: daily.pnl ?? 0,
        navDate: daily.currDate,
        // pnl=null → 该基金可用 NAV 不足 2 期，UI 渲染时与"持平=0"区分
        noNav: daily.pnl === null,
      };
    });
    const totalReturn = perFund.reduce((sum, p) => sum + p.returnAmount, 0);

    // 只看"有持仓"的基金：所有持有基金都没有可用 NAV 对才标 pending
    // 排除空持仓（已清仓）基金——它们的净值缺失不应阻塞持仓基金的显示
    const heldFundIds = new Set(
      funds
        .filter((f) => {
          const timeline = sharesTimeline.get(f.id);
          return !!timeline && timeline.length > 0 && timeline[timeline.length - 1]!.cumShares > 0;
        })
        .map((f) => f.id)
    );
    const isPending =
      heldFundIds.size > 0 &&
      perFund.filter((p) => heldFundIds.has(p.fundId)).every((p) => p.noNav);

    result.push({ date: todayStr, totalReturn, perFund, isPending });
    result.sort((a, b) => a.date.localeCompare(b.date));
  }

  return result;
```

（注意：原第 354 行的 `return result;` 已被上面这段收尾，删掉重复的那个。）

- [ ] **Step 9: 更新 `generateDailyReturns` 的文档注释**

把第 219-241 行的 JSDoc 中"**今天格**：**完全旁路 attribution map，直接调 calcDailyPnl per fund**…"这一段的前两句改为：

```ts
 * - **今天格**：**完全旁路 attribution map，直接取每只基金最新一对已发布 NAV**
 *   （`calcLatestNavPnl`）。这确保 Calendar 今日格 ≡ Dashboard 顶部卡片（共用同一份
 *   "最新已发布 NAV 对"），解决之前几个修复 commit 反复踩的"两边口径漂移"问题。
 *   注意今天格的 `navDate` 可能早于 `date`（A 股当天发布、QDII 常落后 1 个交易日），
 *   UI 必须把 `navDate` 展示出来，不要假装它就是"今天的"。
```

并把"**isPending 判定**：只看有持仓（shares>0）的基金——全部的"今日 NAV 都未发布"才视为待刷新。"改为：

```ts
 * **isPending 判定**：只看有持仓（shares>0）的基金——全部**没有可用 NAV 对**才视为待更新。
```

- [ ] **Step 10: 跑测试确认没打坏纯函数**

Run: `npm run test`
Expected: PASS —— `14 passed (14)`（本任务不新增测试；两个新模块的测试已覆盖取数逻辑）。

- [ ] **Step 11: 确认 UI 调用点是唯一剩余报错**

Run: `npx tsc -b`
Expected: **FAIL**，且报错**只**出现在这四个文件里：`src/pages/Dashboard.tsx`、`src/pages/FundDetail.tsx`、`src/components/HoldingsSummary.tsx`、`src/components/ReturnCalendar.tsx`。典型报错：

```
src/pages/Dashboard.tsx(38,7): error TS2554: Expected 3 arguments, but got 4.
src/pages/FundDetail.tsx(99,13): error TS2353: Object literal may only specify known properties, and 'isDailyPnlToday' does not exist in type...
```

若报错涉及 `src/utils/` 下的文件，说明计算层没改干净，**先回去修 Step 1-9**，不要继续往下。

---

**以下 Step 12 起是 UI 段（同一任务、同一提交，不要中途 commit）**

- [ ] **Step 12: 加统一标签常量**

在 `src/types/index.ts` 的 `FUND_TYPE_LABELS` 声明**之前**插入：

```ts
/**
 * 「当日盈亏」的新名字。取的是每只基金**最新已发布净值日**的涨跌，
 * 不同基金的这个日期可能不同（A 股通常为今天，QDII 常落后 1 个交易日），
 * 所以标题必须带"净值日"三个字，不能再叫"当日"。
 */
export const LATEST_NAV_PNL_LABEL = '最新净值日盈亏';
```

- [ ] **Step 13: Dashboard —— import 与 summaries**

把 `src/pages/Dashboard.tsx` 第 19 行：

```ts
import { FUND_TYPE_LABELS, FUND_TYPE_COLORS, FUND_TYPE_STRIPE_COLORS } from '../types';
```

改为：

```ts
import { FUND_TYPE_LABELS, FUND_TYPE_COLORS, FUND_TYPE_STRIPE_COLORS, LATEST_NAV_PNL_LABEL } from '../types';
```

把第 24 行：

```ts
  const { funds, transactions, platforms, dcaPlans, getNavHistory, settings } = useStore();
```

改为：

```ts
  const { funds, transactions, platforms, dcaPlans, getNavHistory, settings, freshNavFundIds, navRefreshedAt } = useStore();
```

删掉第 31-34 行（`hasQdii` / `hasNonQdii` 及其注释）——新文案不再按基金类型细分，留着会触发 `noUnusedLocals`：

```ts
  // 用户持仓基金中是否含 QDII——用于"今日休市"文案区分
  // （调休补班日 QDII 不发 NAV，但 A 股照常；用 isNonTradingDay 统一判定调休为非交易日后，文案需细分）
  const hasQdii = funds.some((f) => f.type === 'qdii');
  const hasNonQdii = funds.some((f) => f.type !== 'qdii');
```

把第 35-40 行改为：

```ts
  const summaries = useMemo(() => {
    return funds.map((fund) => ({
      fund,
      ...calcFundSummary(fund, transactions, getNavHistory(fund.id)),
    }));
  }, [funds, transactions, getNavHistory]);
```

- [ ] **Step 14: Dashboard —— totals 改为分桶**

把第 42-72 行的 `totals` useMemo 整段替换为：

```ts
  // 衍生统计：memoize 避免每次渲染重算 + 重复 getNavHistory 调用
  const totals = useMemo(() => {
    const totalValue = summaries.reduce((sum, s) => sum + s.marketValue, 0);
    const totalCost = summaries.reduce((sum, s) => sum + s.cost, 0);
    const totalReturn = totalValue - totalCost;
    const totalReturnRate = totalCost > 0 ? (totalReturn / totalCost) * 100 : 0;

    // 最新净值日盈亏：汇总所有"有可用 NAV 对"的基金。
    // 不做任何发布节奏假设——数字就是各基金最新一对已发布 NAV 的涨跌；
    // 因为不同基金的最新净值日可能不同（A 股今天、QDII 常落后 1 个交易日），
    // 按 currNavDate 分桶展示，把口径直接写在卡片上而不是藏进 tooltip。
    let totalDailyPnl: number | null = null;
    const bucketCount = new Map<string, number>();
    let noNavCount = 0;
    for (const s of summaries) {
      if (s.dailyPnl === null) {
        noNavCount++;
        continue;
      }
      totalDailyPnl = (totalDailyPnl ?? 0) + s.dailyPnl;
      bucketCount.set(s.currNavDate, (bucketCount.get(s.currNavDate) ?? 0) + 1);
    }
    const navDateBuckets = [...bucketCount.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => b.date.localeCompare(a.date));

    return {
      totalValue,
      totalCost,
      totalReturn,
      totalReturnRate,
      totalDailyPnl,
      navDateBuckets,
      noNavCount,
      coveredCount: summaries.length - noNavCount,
    };
  }, [summaries]);

  // 本轮刷新是否"一无所获"：跑过刷新、但没有一只基金拿到新净值。
  // 非交易日不算（休市时本来就该没有新净值，提示反而误导）。
  const freshNavCount = funds.filter((f) => freshNavFundIds.has(f.id)).length;
  const showStaleTag =
    navRefreshedAt !== null &&
    freshNavCount === 0 &&
    totals.coveredCount > 0 &&
    !isNonTradingDay(todayStr);
```

- [ ] **Step 15: Dashboard —— 表格列**

把第 179-226 行（`当日盈亏` 列的整个对象）替换为：

```tsx
    {
      title: LATEST_NAV_PNL_LABEL,
      dataIndex: 'dailyPnl',
      key: 'dailyPnl',
      width: 150,
      align: 'right' as const,
      sorter: (a: typeof summaries[0], b: typeof summaries[0]) => (a.dailyPnl ?? 0) - (b.dailyPnl ?? 0),
      render: (_v: number | null, record: typeof summaries[0]) => {
        if (record.dailyPnl === null) {
          return (
            <Tooltip title="该基金可用净值不足 2 期，暂时算不出涨跌">
              <span style={{ color: '#999' }}>—</span>
            </Tooltip>
          );
        }
        // 净值日永远显示出来——这是本改造的核心：用户能看到 A 股是 09-14、QDII 是 09-11，
        // 不需要 App 去猜哪只基金延迟几天。
        return (
          <Tooltip title={`净值 ${record.currNavDate} vs ${record.prevNavDate}`}>
            <div>
              <span style={{ color: pnlColor(record.dailyPnl), fontWeight: 500 }}>
                {formatMoney(record.dailyPnl)}
              </span>
              <div style={{ fontSize: 11, color: '#999' }}>净值 {record.currNavDate.slice(5)}</div>
            </div>
          </Tooltip>
        );
      },
    },
```

- [ ] **Step 16: Dashboard —— 卡片**

把第 337-384 行（`<Tooltip title={...}>` 到它对应的 `</Tooltip>`，即卡片内除 `styles` 之外的整个 body）替换为：

```tsx
            <Tooltip
              title={
                totals.totalDailyPnl === null
                  ? '尚无基金有可用净值对'
                  : '各基金「最新已发布净值日」的盈亏合计。不同基金的净值日可能不同（A 股通常为今天，QDII 常落后 1 个交易日），卡片下方标出分布。'
              }
            >
              <div style={{ color: '#666', fontSize: 13, marginBottom: 8 }}>
                ⚡ {LATEST_NAV_PNL_LABEL}{isNonTradingDay(todayStr) ? '（休市）' : ''}
              </div>
              <div
                style={{
                  color: totals.totalDailyPnl !== null ? pnlColor(totals.totalDailyPnl) : '#999',
                  fontSize: 30,
                  fontWeight: 700,
                  lineHeight: 1.2,
                  fontFamily: 'DIN, "Helvetica Neue", Arial, sans-serif',
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 4,
                }}
              >
                {totals.totalDailyPnl !== null && totals.totalDailyPnl > 0 && <ArrowUpOutlined style={{ fontSize: 18 }} />}
                {totals.totalDailyPnl !== null && totals.totalDailyPnl < 0 && <ArrowDownOutlined style={{ fontSize: 18 }} />}
                <span>
                  {totals.totalDailyPnl === null
                    ? '—'
                    : `${totals.totalDailyPnl >= 0 ? '+' : ''}¥${formatMoney(totals.totalDailyPnl)}`}
                </span>
              </div>
              {(totals.coveredCount > 0 || isNonTradingDay(todayStr)) && (
                <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
                  {isNonTradingDay(todayStr) && <span style={{ marginRight: 6 }}>下次开盘自动刷新</span>}
                  {showStaleTag && (
                    <Tag style={{ marginRight: 6 }}>净值待更新</Tag>
                  )}
                  {totals.navDateBuckets.length > 0 &&
                    totals.navDateBuckets
                      .map((b) => `净值日 ${b.date.slice(5)} ×${b.count} 只`)
                      .join(' · ')}
                </div>
              )}
            </Tooltip>
```

> 注意 `showStaleTag` 里的 `Tag` 已由第 2 行的 `antd` import 提供，无需新增 import。

- [ ] **Step 17: Dashboard —— 确认 import 无冗余**

Run: `npx tsc -b`

（`tsconfig.app.json` 已设 `noEmit: true`，`tsc -b` 只做类型检查、不产出文件。）

Expected: `Dashboard.tsx` **不报错**。第 7 行的 `today` 仍被 `todayStr = today()`（第 30 行）使用，第 8 行的 `isNonTradingDay` 仍被 Step 5 的卡片文案与 `showStaleTag` 使用 —— **两处 import 都保留，不要删**。只剩 `FundDetail.tsx` / `HoldingsSummary.tsx` / `ReturnCalendar.tsx` 的报错（由本任务后续步骤修）。

- [ ] **Step 18: FundDetail**

把 `src/pages/FundDetail.tsx` 第 13-18 行的 import 段改为（去掉 `today`、`isNonTradingDay`，加 `LATEST_NAV_PNL_LABEL`）：

```ts
import { calcFundSummary, calcSharesFromAmount, calcShares, calcCost, onlyConfirmed } from '../utils/calculator';
import { pnlColor, formatDate, formatMoney, formatPercent } from '../utils/formatter';
import { lookupNavForDate } from '../utils/navLookup';
import InitialPositionModal from '../components/InitialPositionModal';
import { FUND_TYPE_LABELS, FUND_TYPE_COLORS, TRANSACTION_TYPE_LABELS, TX_TYPE_COLORS, FREQUENCY_LABELS, LATEST_NAV_PNL_LABEL } from '../types';
```

把第 95-101 行改为：

```ts
  const summary = useMemo(
    () =>
      fund
        ? calcFundSummary(fund, transactions, navHistory)
        : { shares: 0, cost: 0, marketValue: 0, totalReturn: 0, returnRate: 0, dailyPnl: null, currNavDate: '', prevNavDate: '', xirr: 0, dividend: 0 },
    [fund, transactions, navHistory]
  );
```

把第 486-515 行（`<Col xs={12} sm={12} md={8}>` 里那张「当日盈亏」卡）替换为：

```tsx
        <Col xs={12} sm={12} md={8}>
          <Card>
            <Tooltip
              title={
                summary.dailyPnl === null
                  ? '该基金可用净值不足 2 期，暂时算不出涨跌'
                  : `净值 ${summary.currNavDate} vs ${summary.prevNavDate}`
              }
            >
              <Statistic
                title={LATEST_NAV_PNL_LABEL}
                value={summary.dailyPnl ?? '—'}
                precision={2}
                valueStyle={{ color: summary.dailyPnl !== null ? pnlColor(summary.dailyPnl) : undefined }}
              />
              {summary.dailyPnl !== null ? (
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>净值 {summary.currNavDate}</div>
              ) : (
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>暂无净值数据</div>
              )}
            </Tooltip>
          </Card>
        </Col>
```

- [ ] **Step 19: HoldingsSummary —— import 与接口**

把 `src/components/HoldingsSummary.tsx` 第 4-7 行改为：

```ts
import type { Platform, Fund } from '../types';
import { FUND_TYPE_LABELS, FUND_TYPE_COLORS, LATEST_NAV_PNL_LABEL } from '../types';
import { formatMoney, formatPercent, pnlColor } from '../utils/formatter';
```

把第 16-20 行改为（删掉 `isDailyPnlToday`）：

```ts
  dailyPnl: number | null;
  currNavDate: string;
  prevNavDate: string;
```

把 `GroupRow` 接口（第 32-38 行）的尾部三行：

```ts
  /** null = 该组所有成员今日 NAV 均未发布 */
  dailyPnl: number | null;
  dailyPnlUpdatedCount: number;
  dailyPnlPendingCount: number;
```

改为：

```ts
  /** null = 该组没有任何成员有可用 NAV 对 */
  dailyPnl: number | null;
  /** 净值归属日 → 该日期的成员数，如 { '2026-09-14': 2, '2026-09-11': 1 } */
  navDateCounts: Record<string, number>;
  /** 可用净值不足 2 期的成员数 */
  noNavCount: number;
```

- [ ] **Step 20: HoldingsSummary —— 聚合与列**

删掉第 59-60 行：

```ts
  const today = todayStr();
  const isNonTrading = isNonTradingDay(today);
```

把第 82-85 行（`dailyPnl` 等的初始化）改为：

```ts
          dailyPnl: null,
          navDateCounts: {},
          noNavCount: 0,
```

把第 91-97 行改为：

```ts
      // dailyPnl 聚合：null-aware —— 只有有可用 NAV 对的成员才贡献数字
      if (s.dailyPnl !== null) {
        row.dailyPnl = (row.dailyPnl ?? 0) + s.dailyPnl;
        row.navDateCounts[s.currNavDate] = (row.navDateCounts[s.currNavDate] ?? 0) + 1;
      } else {
        row.noNavCount += 1;
      }
```

把第 191-241 行（`当日盈亏` 列）替换为：

```tsx
    {
      title: LATEST_NAV_PNL_LABEL,
      key: 'dailyPnl',
      width: 160,
      align: 'right',
      sorter: (a, b) => (a.dailyPnl ?? 0) - (b.dailyPnl ?? 0),
      render: (_, r) => {
        if (r.dailyPnl === null) {
          return (
            <Tooltip title="该分组下所有基金的可用净值都不足 2 期">
              <span style={{ color: '#999' }}>—</span>
            </Tooltip>
          );
        }
        const dates = Object.keys(r.navDateCounts).sort((a, b) => b.localeCompare(a));
        return (
          <Tooltip
            title={`净值日 ${dates.map((d) => `${d} ×${r.navDateCounts[d]} 只`).join(' · ')}`}
          >
            <div>
              <span style={{ color: pnlColor(r.dailyPnl) }}>{formatMoney(r.dailyPnl)}</span>
              <div style={{ fontSize: 11, color: '#999' }}>
                {dates.length === 1 ? `净值 ${dates[0]!.slice(5)}` : `净值日 ${dates.length} 个`}
              </div>
            </div>
          </Tooltip>
        );
      },
    },
```

- [ ] **Step 21: ReturnCalendar**

把 `src/components/ReturnCalendar.tsx` 第 23-29 行的 `PeriodDetailRow` 改为：

```ts
interface PeriodDetailRow {
  fundId: string;
  fundName: string;
  returnAmount: number;
  /** 该行收益对应的 NAV 归属日；'' = 无归属日（当天没有 NAV 变化） */
  navDate?: string;
  /** 仅"今日"行可能为 true：该基金可用 NAV 不足 2 期 */
  noNav?: boolean;
}
```

把第 60-82 行（基金列与收益列的 render）改为：

```tsx
          {
            title: '基金',
            dataIndex: 'fundName',
            key: 'fundName',
            render: (_, r) => (
              <NavLink onClick={() => navigate(`/funds/${r.fundId}`)}>
                {r.fundName}
                {r.noNav && (
                  <Tag color="default" style={{ marginLeft: 6, fontSize: 11 }}>
                    无净值数据
                  </Tag>
                )}
                {!r.noNav && r.navDate && r.navDate !== dateLabel && (
                  <Tag color="blue" style={{ marginLeft: 6, fontSize: 11 }}>
                    净值 {r.navDate.slice(5)}
                  </Tag>
                )}
              </NavLink>
            ),
          },
          {
            title: '收益',
            dataIndex: 'returnAmount',
            key: 'returnAmount',
            align: 'right' as const,
            render: (v, r) =>
              r.noNav ? (
                <span style={{ color: '#999' }}>—</span>
              ) : (
                <span style={{ color: pnlColor(v) }}>{formatMoney(v)}</span>
              ),
          },
```

把第 211-223 行的 `formatTooltip` 里 `c.pending` 分支的文案改为：

```tsx
            : c.pending
            ? `${c.key}：净值待更新`
```

把第 226-242 行（`selected &&` 块）改为：

```tsx
      {selected && (
        // 仅当所有基金都没有可用 NAV 对时才显示整格提示；只要有任一基金有数据，
        // 就走明细面板（每个基金单独标 noNav / 净值日，让 A 股能看到自己的涨跌）
        selected.perFund.every((p) => p.noNav) ? (
          <div style={{ marginTop: 16, padding: 12, background: '#fafafa', borderRadius: 6, color: '#999', fontSize: 13 }}>
            {isNonTradingDay(selected.date)
              ? `${selected.date}：休市`
              : `${selected.date}：暂无可用的净值对，请在基金列表刷新净值`}
          </div>
        ) : (
          <PeriodDetail
            dateLabel={selected.date}
            total={selected.totalReturn}
            perFund={selected.perFund}
          />
        )
      )}
```

- [ ] **Step 22: 构建恢复绿色**

Run: `npm run build`
Expected: PASS。若报某个 import 未使用（`noUnusedLocals`），按报错逐个删掉对应 import 行。

- [ ] **Step 23: 跑全量测试**

Run: `npm run test`
Expected: PASS —— `14 passed (14)`。

- [ ] **Step 24: Commit（计算层 + UI 一个提交，构建必须是绿的）**

```bash
git add src/utils/calculator.ts src/utils/reportGenerator.ts src/types/index.ts \
        src/pages/Dashboard.tsx src/pages/FundDetail.tsx \
        src/components/HoldingsSummary.tsx src/components/ReturnCalendar.tsx
git commit -m "feat(calculator,ui): 当日盈亏改为「最新净值日盈亏」，界面上标出各自净值日

计算层：
- calcDailyPnl（按 publishDate === today 筛选）→ calcLatestNavPnl（取最新一对已发布 NAV）
- calcFundSummary 去掉 todayStr 参数与 isDailyPnlToday 字段
- buildAttributionMap 改用 usableNavSeries，与 navPair 共享可用性规则
- DailyReturn.perFund 的 isPending → noNav，新增 navDate
- 今日格用 txsByFund + calcLatestNavPnl，保持「日历今日格 ≡ Dashboard 卡片」不变量

UI：
- 卡片/表格标题统一用 LATEST_NAV_PNL_LABEL
- Dashboard 卡片按净值日分桶（净值日 09-14 ×2 只 · 净值日 09-11 ×1 只）
- 表格列在数字下方显示该基金自己的净值日，不再靠推算
- 移除所有 T+2 假设文案与「净值更新中」误导标签
- 删除 Dashboard 的 hasQdii/hasNonQdii（新文案不再按类型细分）"
```

---

### Task 6: 删除 `tradingDays.ts`、清理过期注释、手工验收

**Files:**
- Delete: `src/utils/tradingDays.ts`
- Modify: `src/utils/chineseHolidays.ts:73-82`
- Modify: `src/utils/usHolidays.ts:60-63`

**Interfaces:**
- Consumes: 无
- Produces: 无（收尾任务）

- [ ] **Step 1: 确认没有残留引用**

Run: `rg -n "tradingDays|addTradingDays|getPublishDate|findPublishedNavPair|calcDailyPnl\b|isDailyPnlToday" src`
Expected: 无输出（`calcDailyPnlBySegments` 不算，它名字里有 `calcDailyPnl` 前缀但匹配词边界 `\b` 后不成立 —— 若 `rg` 仍列出 `calcDailyPnlBySegments`，说明用词边界没生效，改成 `"calcDailyPnl\("` 再跑）。

若仍有引用，**停下**，说明任务 5/6 漏改了，回到对应任务补。

- [ ] **Step 2: 删除文件**

```bash
git rm src/utils/tradingDays.ts
```

- [ ] **Step 3: 更新 `chineseHolidays.ts` 的过期论证**

把 `src/utils/chineseHolidays.ts` 第 73-82 行（`isNonTradingDay` 的 JSDoc）替换为：

```ts
/**
 * 判断指定日期（YYYY-MM-DD）是否为 A 股 / QDII 非交易日。
 *
 * - 已收录年份（2025、2026）：精确判定（周末 ∪ 工作日法定节假日）
 * - 未收录年份：退化为「仅按周末判定」——与未引入本工具前一致
 *
 * 已知不准确之处（**故意保留**）：调休补班日（周六 / 周日上班，A 股照常开市）
 * 这里也返回 true。原因：本表没有实现 TRANSFER_WORKDAYS（补班日）数据，
 * 只靠周末判定必然把补班日误判为休市。
 *
 * 影响范围被刻意限制在"日历格子的休市着色"，**不影响盈亏数字**：
 * 盈亏取的是每只基金最新一对已发布 NAV（见 utils/navPair.ts），与交易日无关。
 * 修这个需要先补一份准确的补班日表，属于独立任务。
 */
```

- [ ] **Step 4: 更新 `usHolidays.ts` 的过期注释**

把 `src/utils/usHolidays.ts` 第 60-63 行里那句：

```
 * A 股 / QDII T+2 发布日等其他场景仍走 chineseHolidays。
```

替换为：

```
 * A 股 / QDII 的"休市日"判定等其他场景仍走 chineseHolidays。
```

（该文件顶部关于 `isUsTrackedQdii` 关键词启发式的说明保留不动。）

- [ ] **Step 5: 构建 + 测试**

Run: `npm run test && npm run build`
Expected: `14 passed (14)`；构建成功。

- [ ] **Step 6: 手工验收（dev server）**

Run: `npm run dev`，按下面的清单逐项确认。开着 devtools 的 Network 面板确认 `pingzhongdata` 请求成功。

- [ ] **QA-1** Dashboard 持仓表「最新净值日盈亏」列：QDII 行下方小字显示 `净值 09-11`（写本计划时的真实值；实际按当天最新已发布 NAV 日），且数字为正（`+0.857%` 对应广发纳指100 若 NAV 仍是 8.0487 → 8.1177）。A 股基金显示 `净值 <今天或最近交易日>`。
- [ ] **QA-2** 同一列 A 股与 QDII 的净值日**不同**，且各自与天天基金 / 支付宝上该基金的"最新净值日期"一致。这是本改造的核心验收点。
- [ ] **QA-3** 顶部 ⚡ 卡片标题为「最新净值日盈亏」，数字下方小字形如 `净值日 09-14 ×3 只 · 净值日 09-11 ×2 只`，分桶计数之和等于持仓基金总数减去 `—` 的行数。
- [ ] **QA-4** 收益日历「日」Tab 点今天格：明细表中 QDII 行带蓝色 `净值 09-11` 标签，A 股行不带标签（因为 `navDate === dateLabel`）；该格合计与 QA-3 的卡片数字**完全相等**。
- [ ] **QA-5** 切到周末（月视图里找上周六）：格子显示"休市"，不出现"净值更新中"，且昨天之前的正常交易日格子数字与改造前一致（历史格算法未变，这是回归检查）。
- [ ] **QA-6** 持仓汇总表最后一列标题为「最新净值日盈亏」；某分组内混合了 A 股与 QDII 时，小数行显示 `净值日 2 个`，hover tooltip 列出两个日期与各只数。
- [ ] **QA-7** 基金详情页「最新净值日盈亏」卡片下方显示 `净值 2026-09-XX`，tooltip 为 `净值 X vs Y`，**不出现任何 T+2 字样**。
- [ ] **QA-8** 全仓库搜索 `rg -n "T\+2|T\+1" src` 应只在 `navPair.ts` / `navFreshness.ts` / `calculator.ts` 的解释性注释里出现，不在任何 UI 字符串里。

- [ ] **Step 7: Commit**

```bash
git add src/utils/chineseHolidays.ts src/utils/usHolidays.ts
git commit -m "refactor(utils): 删除 tradingDays，清理过期的 T+2 注释"
```

---

## Self-Review

**1. Spec coverage**

| 设计决定 | 落地任务 |
|---|---|
| Route 1：取最新一对已发布 NAV，不假设延迟 | Task 2（`latestNavPair`）+ Task 5 Step 2 |
| 改名「最新净值日盈亏」 | Task 5 Step 12（常量）+ Step 15/16/18/20/21 |
| 新鲜度用观测法重建 | Task 3（`computeFreshness`）+ Task 4（storage/store/App 接线）+ Task 5 Step 14/16（卡片标签） |
| 引入 Vitest | Task 1 |
| `tradingDays.ts` 整体删除 | Task 6 Step 2 |
| 从"发布日对齐"改为"归属日对齐"，UI 标出日期 | Task 5 Step 6/7/8（`navDate`）+ Task 5 Step 15/18/20/21 |
| Dashboard 卡片按净值日分桶 | Task 5 Step 14/16 |
| 美股节假日复制 NAV 过滤下沉为共享规则 | Task 2（`usableNavSeries`）+ Task 5 Step 5 |
| 日历今日格 ≡ Dashboard 卡片（口径不漂移） | Task 5 Step 8（`txsByFund` + 同一个 `calcLatestNavPnl`） |
| 更新过期 T+2 注释 | Task 6 Step 3/4 |
| **Non-goal：** `isNonTradingDay` 的调休补班误判 | 不修，Task 6 Step 3 把理由写进代码注释 |
| **Non-goal：** 货币基金（无 `Data_netWorthTrend`） | 不涉及 |

**2. Placeholder scan**

已扫描：无 TBD / TODO / "类似 Task N" / "适当处理错误"。所有代码步骤都给出了可直接粘贴的完整代码块；所有验证步骤都给了命令与预期输出。Task 5 Step 11 记录了「此刻 UI 调用点是唯一剩余报错」这一中间态——它不是遗漏，而是刻意让类型系统当调用点清单；Task 5 Step 24 才提交，提交时构建必须是绿的。

**3. Type consistency**

- `SeenNavMap` 在 Task 3 定义为 `Record<string, string>`；Task 4 的 `storage.getSeenNavMap(): Record<string, string>` 与 `saveSeenNavMap(map: Record<string, string>)` 用字面量而非 import 类型（storage 层不依赖 utils 模块，避免循环 import）——两者结构相同，赋值兼容。✓
- `computeFreshness` 的第三参数在 Task 4 传 `storage.getSeenNavMap()` 返回的 `Record<string,string>`，而形参是 `SeenNavMap` = `Record<string,string>`。✓
- `calcLatestNavPnl` 返回 `{ pnl, currDate, prevDate }`；Task 5 Step 3 的 `calcFundSummary` 读 `.pnl` / `.currDate` / `.prevDate`，Task 5 Step 8 的今日格读同样的三个字段。✓
- `calcFundSummary` 新签名 3 参数在 Task 5 Step 3 定义，Task 5 Step 13（Dashboard）与 Step 18（FundDetail）都以 3 参数调用。✓
- `DailyReturn.perFund[].noNav` / `.navDate` 在 Task 5 Step 6 定义，Task 5 Step 21 的 `PeriodDetailRow` 用同名可选字段 `noNav?` / `navDate?` 接收（可选是因为 Month/Year Tab 的 `perFund` 只有 `{fundId, fundName, returnAmount}`）。✓
- `LATEST_NAV_PNL_LABEL` 在 Task 5 Step 12 定义于 `src/types/index.ts`，在 Step 13/18/19 三处 import。✓
- `freshNavFundIds` / `navRefreshedAt` 在 Task 4 Step 2 定义，Task 5 Step 13 从 store 解构、Step 14 使用。✓
- 函数名一致性检查：`latestNavPair`（Task 2 定义 / Task 4、5 使用）、`usableNavSeries`（Task 2 定义 / Task 5 使用）、`computeFreshness`（Task 3 定义 / Task 4 使用）、`isNewlyPublished`（Task 3 定义+单测）、`calcLatestNavPnl`（Task 5 定义 / Task 5 使用）、`recordNavFreshness`（Task 4 定义 / Task 4 使用）——无命名漂移。✓
