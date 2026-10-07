# 市场指数 Dashboard 改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Dashboard 上加 3 张常见指数卡片（沪深300 / 纳斯达克100 / 标普500），同时删除 HoldingsSummary 组件。

**Architecture:** 新增两个模块——`src/utils/indexQuote.ts`（纯函数：API 时间戳→该市场当地日期、是否更新 cache 的判定）与 `src/api/indexApi.ts`（JSONP `<script>` 注入，仿 `loadPingzhongScript`）。持久化用新 key `fund-tracker:indices`，进 `exportAllData` / `importAllData`。`App.tsx` 的 `refreshAll` 末尾追加 index 循环，每个指数按"API 返回日期 ≤ cache 日期就跳过"决定是否更新。新组件 `src/components/MarketIndices.tsx` 插在 4 张主指标卡和 3 张次指标卡之间。`src/components/HoldingsSummary.tsx` 删除；`src/types/index.ts` 上"持仓列表 / HoldingsSummary / 报表统一口径"那句 JSDoc 同步清理。

**Tech Stack:** React 18 + TypeScript 5.6（`strict` + `noUnusedLocals` + `noUncheckedIndexedAccess`）、Vite 6、Zustand 5、Ant Design 5、dayjs + `dayjs/plugin/utc` + `dayjs/plugin/timezone`（之前未引入）、Vitest 3（已配置）。

## Global Constraints

- 纯前端，无后端；所有持久化走 `localStorage`，key 前缀 `fund-tracker:`（见 `src/utils/storage.ts`）。
- `tsconfig.app.json` 的 `include` 是 `["src"]` 且开启 `noUnusedLocals` / `noUnusedParameters` / `noUncheckedIndexedAccess` → **测试文件会被 `npm run build` 类型检查**，任何未使用的 import / 变量都会让构建失败。数组下标访问必须用 `!` 或显式判空。
- 测试环境必须是 `node`（两个新纯函数模块不碰 DOM / localStorage）。
- 测试从 `vitest` 显式 import `describe/it/expect`，**不启用 globals**。
- 中文市场配色：红涨绿跌，用 `pnlColor()`（`src/utils/formatter.ts`）。
- JSONP `<script>` 注入是项目已有的 CORS 规避方案（`loadPingzhongScript`），新 API 复用同款模式：var 全局用 `= undefined` 清，**不要 `delete`**（ES module strict mode 下非 configurable）。
- 所有 `git commit` 用中文正文 + 传统 commit 前缀（`feat:` / `fix:` / `refactor:` / `chore:`）。
- **不**为指数维护节日表。`src/utils/chineseHolidays.ts` 继续按现有职责使用；**不**新建 `usHolidays.ts`（设计文档 §3 已说明：用 API `data.date` 做判官）。
- `dayjs/plugin/timezone` + `dayjs/plugin/utc` 之前未在仓库任何文件 extend 过，本计划在 `src/utils/indexQuote.ts` 里首次 extend。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/types/index.ts` | 修改 | 新增 `Market` / `IndexQuote` / `IndexSpec` 三个类型；删除"持仓列表 / HoldingsSummary / 报表统一口径"那个 JSDoc 里的 HoldingsSummary 引用 |
| `src/utils/indexQuote.ts` | 新建 | 纯函数：`formatIndexDate`、`shouldUpdateIndexQuote`；extend dayjs timezone/utc |
| `src/utils/indexQuote.test.ts` | 新建 | 上者的单测 |
| `src/api/indexApi.ts` | 新建 | `fetchMarketIndex(spec)` + `INDEX_LIST`；JSONP `<script>` 注入，仿 `loadPingzhongScript` |
| `src/utils/storage.ts` | 修改 | 新增 `getIndices` / `saveIndices`；`exportAllData` / `importAllData` 加 `indices` 字段（兼容 v0 备份的 `data.indices ?? {}`） |
| `src/stores/index.ts` | 修改 | 新增 `indices: Record<string, IndexQuote>` state；`updateIndex(code, quote)` action；`loadFromStorage` 读 indices；清空 navHistoryCache 时不动 indices（独立 cache） |
| `src/App.tsx` | 修改 | `refreshAll` 末尾追加 index 循环（与基金循环同款节奏：每个间隔 500ms，循环结束自动跑后续的 `autoConfirmPending` / `recordNavFreshness` / `addSnapshot`） |
| `src/components/MarketIndices.tsx` | 新建 | 3 张 stat card 的 Row；读 `useStore().indices` |
| `src/pages/Dashboard.tsx` | 修改 | 删除 `import HoldingsSummary` 与 `<HoldingsSummary>` 渲染；在 4 张主指标卡之后、3 张次指标卡之前插入 `<MarketIndices />` |
| `src/components/HoldingsSummary.tsx` | **删除** | 整个文件无其他消费者 |

**为什么 `formatIndexDate` / `shouldUpdateIndexQuote` 拆独立文件而不是塞 `indexApi.ts` 或 `MarketIndices.tsx`：**

- 两者都是纯函数，独立可测；`indexApi.ts` 触碰 DOM + `<script>` 注入，在 node 测试环境跑不动，`MarketIndices.tsx` 是 React 组件，要么 jsdom 要么快照测试，引入会膨胀 vitest 配置。把这俩抽出来，Vitest 现有 `environment: 'node'` 就够用。
- 时区格式化与"是否更新 cache"是两条独立的判断规则（前者关心"API 时间戳转哪个市场日期"，后者关心"API 这次给的数据是不是新的"），未来若有别的指数数据源接入，复用它们也比把 `indexApi.ts` 拆开更省事。

**任务依赖顺序：** 1 → 2 → 3 → 4，**串行**，每个任务一个 commit，构建都是绿的。

---

### Task 1: 类型 + 纯函数模块（含测试）

**Files:**
- Modify: `src/types/index.ts`（追加 3 个类型，不动其它）
- Create: `src/utils/indexQuote.ts`
- Create: `src/utils/indexQuote.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `Market = 'CN' | 'US'`（`src/types/index.ts` 导出）
  - `IndexQuote`（`src/types/index.ts` 导出）：`{ name: string; market: Market; value: number; change: number; changePercent: number; date: string; fetchedAt: number }`
  - `IndexSpec`（`src/types/index.ts` 导出）：`{ code: string; secid: string; name: string; market: Market }`
  - `formatIndexDate(timestampMs: number, market: Market): string`（`src/utils/indexQuote.ts` 导出）—— 该市场当地日历日 YYYY-MM-DD
  - `shouldUpdateIndexQuote(cached: IndexQuote | undefined, fetched: { date: string }): boolean`（`src/utils/indexQuote.ts` 导出）—— `fetched.date > cached.date` 时返回 true（无 cache 永远 true）

- [ ] **Step 1: 加类型**

打开 `src/types/index.ts`，在文件最末尾追加（不插在中间，避开 `LATEST_NAV_PNL_LABEL` / `FUND_TYPE_*` / `TRANSACTION_TYPE_LABELS` 等既有声明——它们各自有归属段落，混着改 review 不好定位）：

```ts
/** 指数所在市场的本地时区分类。决定数据日期格式化与 TZ 显示标签。 */
export type Market = 'CN' | 'US';

/**
 * 单个指数最近一次成功拉取的快照，存进 localStorage 后下次进 app 立刻显示。
 * `date` 是该市场当地的 YYYY-MM-DD（CN = 北京，US = 美东），
 * `fetchedAt` 是本地拉取时间戳 ms —— 仅用于 UI 提示"已更新于 X 分钟前"，
 * 不参与"是不是新数据"的判定（那由 `data.date` 自己说了算，见 utils/indexQuote.ts）。
 */
export interface IndexQuote {
  name: string;
  market: Market;
  value: number;
  change: number;
  changePercent: number;
  date: string;
  fetchedAt: number;
}

/**
 * 硬编码的指数清单（v1 不做"用户自定义"）。
 * `code` 是项目内部的稳定代号（也是 localStorage 的 key），
 * `secid` 是 eastmoney push2 的 secid 编码（`{market前缀}.{指数代码}`）。
 */
export interface IndexSpec {
  code: string;
  secid: string;
  name: string;
  market: Market;
}
```

- [ ] **Step 2: 写失败测试**

创建 `src/utils/indexQuote.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { formatIndexDate, shouldUpdateIndexQuote } from './indexQuote';
import type { IndexQuote } from '../types';

describe('formatIndexDate', () => {
  it('CN: UTC 2026-10-04 01:30 = 北京 09:30 → 2026-10-04', () => {
    const ts = Date.UTC(2026, 9, 4, 1, 30, 0);
    expect(formatIndexDate(ts, 'CN')).toBe('2026-10-04');
  });

  it('CN: UTC 2026-10-04 15:59 = 北京 23:59 → 2026-10-04', () => {
    const ts = Date.UTC(2026, 9, 4, 15, 59, 0);
    expect(formatIndexDate(ts, 'CN')).toBe('2026-10-04');
  });

  it('CN: UTC 2026-10-04 16:00 = 北京 次日 00:00 → 2026-10-05', () => {
    const ts = Date.UTC(2026, 9, 4, 16, 0, 0);
    expect(formatIndexDate(ts, 'CN')).toBe('2026-10-05');
  });

  it('US: UTC 2026-10-03 13:30 = 美东 09:30 (EDT) → 2026-10-03', () => {
    // 十月美东是 EDT (UTC-4)
    const ts = Date.UTC(2026, 9, 3, 13, 30, 0);
    expect(formatIndexDate(ts, 'US')).toBe('2026-10-03');
  });

  it('US: UTC 2026-01-05 14:30 = 美东 09:30 (EST) → 2026-01-05', () => {
    // 一月美东是 EST (UTC-5)；同样的本地时间，时区偏移不同
    const ts = Date.UTC(2026, 0, 5, 14, 30, 0);
    expect(formatIndexDate(ts, 'US')).toBe('2026-01-05');
  });

  it('US: UTC 2026-10-04 04:00 = 美东 00:00 → 2026-10-04', () => {
    // 跨日的边界 —— 这是关键 case：相同 timestamp 在 CN/US 下必须得到**不同**日期
    const ts = Date.UTC(2026, 9, 4, 4, 0, 0);
    expect(formatIndexDate(ts, 'US')).toBe('2026-10-04');
    expect(formatIndexDate(ts, 'CN')).toBe('2026-10-04'); // Beijing 12:00，同日
  });
});

describe('shouldUpdateIndexQuote', () => {
  function q(date: string, market: 'CN' | 'US' = 'CN'): IndexQuote {
    return { name: 'x', market, value: 100, change: 1, changePercent: 1, date, fetchedAt: 0 };
  }

  it('无 cache → 永远 true（首次观测）', () => {
    expect(shouldUpdateIndexQuote(undefined, { date: '2026-10-04' })).toBe(true);
  });

  it('fetched.date > cached.date → true（拿到新交易日）', () => {
    expect(shouldUpdateIndexQuote(q('2026-10-03'), { date: '2026-10-04' })).toBe(true);
  });

  it('fetched.date === cached.date → false（市场没动：休市 / 周末 / 已收盘）', () => {
    expect(shouldUpdateIndexQuote(q('2026-10-04'), { date: '2026-10-04' })).toBe(false);
  });

  it('fetched.date < cached.date → false（API 返回陈旧数据，信任 cache）', () => {
    expect(shouldUpdateIndexQuote(q('2026-10-04'), { date: '2026-10-03' })).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL —— `Failed to resolve import "./indexQuote"`（文件还没建）。

- [ ] **Step 4: 实现**

创建 `src/utils/indexQuote.ts`：

```ts
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import type { IndexQuote, Market } from '../types';

// 项目此前未引入 timezone 插件；这里 extend 后全仓库共享。
dayjs.extend(utc);
dayjs.extend(timezone);

const MARKET_TZ: Record<Market, string> = {
  CN: 'Asia/Shanghai',
  US: 'America/New_York',
};

/**
 * 把 API f86 时间戳（毫秒）格式化成该市场**当地**日历日 YYYY-MM-DD。
 *
 * CN 用 Asia/Shanghai，US 用 America/New_York。这样同一 timestamp 在两个市场下可以
 * 落在不同的日期上（例如 UTC 2026-10-04 04:00 = 美东 10-04 00:00 = 北京 10-04 12:00），
 * 各自的"数据日期"由该市场开盘日说了算，跟对方无关。
 */
export function formatIndexDate(timestampMs: number, market: Market): string {
  return dayjs(timestampMs).tz(MARKET_TZ[market]).format('YYYY-MM-DD');
}

/**
 * 决定 API 这次返回的数据要不要写进 cache。
 *
 * 规则就是字面的日期比较：`fetched.date > cached.date` 才写。理由（见设计文档 §3）：
 * API 不会给我们"今天是交易日吗 / 该不该刷新"的判定——但**它返回的日期**就是权威——
 * 同一日重复拉说明市场没动（休市 / 周末 / 已收盘），cache 留旧值即可；
 * 日期前进了说明有新数据，写入。
 *
 * 无 cache 永远 true（首次观测，区别于"已知 cache 但 fetch 拿到旧日期"）。
 * 这里**不**用 `fetchedAt` 参与判定——`fetchedAt` 只是 UI 显示用，不该影响 cache 内容。
 */
export function shouldUpdateIndexQuote(
  cached: IndexQuote | undefined,
  fetched: { date: string }
): boolean {
  if (!cached) return true;
  return fetched.date > cached.date;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test`
Expected: PASS —— `19 passed (19)`（既有 17 + 本任务 2 组共 10 条新用例；实际数字按当前 main 分支为准，只要新增的 10 条全过即可）。

如果时区相关的 6 条用例失败：
- `> Timezone with TZ=...` → Node 版本过老（< 18）；检查 `node -v`，要求 ≥ 18
- 跨日那条边界用例失败 → 检查 `MARKET_TZ` 表里 US 是不是 `'America/New_York'`（不是 'America/EST'）

**不要**为了迁就实现而改用例。

- [ ] **Step 6: 构建确认**

Run: `npm run build`
Expected: PASS（仅类型检查 + 产物生成；UI 还没碰，`src/types/index.ts` 新增的 3 个类型暂未引用，无 unused 报错）。

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/utils/indexQuote.ts src/utils/indexQuote.test.ts
git commit -m "feat(index): 新增 Market/IndexQuote/IndexSpec 类型 + formatIndexDate/shouldUpdateIndexQuote 纯函数"
```

---

### Task 2: `src/api/indexApi.ts` —— JSONP 拉取

**Files:**
- Create: `src/api/indexApi.ts`

**Interfaces:**
- Consumes: `Market`、`IndexSpec`（Task 1）；`formatIndexDate`（Task 1）
- Produces:
  - `INDEX_LIST: IndexSpec[]` —— 硬编码 3 条（沪深300 / 纳斯达克100 / 标普500）
  - `fetchMarketIndex(spec: IndexSpec): Promise<{ value: number; change: number; changePercent: number; date: string; fetchedAt: number } | null>` —— 网络错 / `data: null` / `f86` 缺失统一返回 null（不抛）

> **不写单测**：本模块触碰 DOM（`document.createElement('script'）`）与 `<script>` 注入，node 环境跑不动。验证靠浏览器手动 dev tools（见 Task 4 Step 6）。

- [ ] **Step 1: 创建 `src/api/indexApi.ts`**

```ts
import type { IndexSpec, Market } from '../types';
import { formatIndexDate } from '../utils/indexQuote';

/**
 * v1 硬编码的指数清单。后续要做"用户自定义"再加 UI / 持久化。
 * - secid 是 eastmoney push2 的 secid 编码：`{market 前缀}.{指数代码}`
 * - market 前缀：CN=1., US=100.
 */
export const INDEX_LIST: IndexSpec[] = [
  { code: 'sh000300', secid: '1.000300', name: '沪深300',     market: 'CN' },
  { code: 'usNDX',    secid: '100.NDX',  name: '纳斯达克100', market: 'US' },
  { code: 'usSPX',    secid: '100.SPX',  name: '标普500',     market: 'US' },
];

/**
 * 从 API 取到的 raw 字段，已套用 TZ 转成该市场当地的日期。
 * 与 types/IndexQuote 几乎一致，少一个 `name` 与 `market`（这俩 spec 已知，
 * 不需要 API 告诉 UI；store.updateIndex 时合并）。
 */
export interface IndexQuoteRaw {
  value: number;
  change: number;
  changePercent: number;
  date: string;
  fetchedAt: number;
}

const TIMEOUT_MS = 15000;
const SCRIPT_SRC = 'https://push2.eastmoney.com/api/qt/stock/get';

/**
 * 注入一段 JSONP `<script>`，cb 回调名每次唯一，避免并发调用互相覆盖。
 * 仿 fundApi.ts 的 loadPingzhongScript：var 全局 set undefined（不是 delete），
 * script.removeChild 摘掉。**唯一差异**：pingzhongdata 用 var 声明固定名字
 * （fS_name 等），push2 是 `?cb=xxx` 把回调名传给服务端，服务端回 `xxx({...})`。
 */
function loadIndexScript(secid: string, cb: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const w = window as unknown as Record<string, unknown>;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Index script timeout: ${secid}`));
    }, TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      try { w[cb] = undefined; } catch { /* ignore */ }
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    w[cb] = (data: unknown) => { cleanup(); resolve(data); };

    script.onerror = () => {
      cleanup();
      reject(new Error(`Index script load failed: ${secid}`));
    };

    // _=Date.now() 强制绕过 CDN / 浏览器缓存，避免开发期被 304 卡住
    const fields = 'f43,f169,f170,f86';
    script.src =
      `${SCRIPT_SRC}?cb=${encodeURIComponent(cb)}` +
      `&secid=${encodeURIComponent(secid)}` +
      `&fields=${encodeURIComponent(fields)}` +
      `&_=${Date.now()}`;
    script.setAttribute('charset', 'utf-8');
    script.setAttribute('referrerpolicy', 'no-referrer');
    document.head.appendChild(script);
  });
}

/**
 * 拉一个指数的当前行情。失败统一返回 null（不抛）——App.tsx 的循环靠 null
 * 判断"是否要更新 cache"，抛错会让循环中断、影响后续指数。
 *
 * 字段映射：
 * - f43: 当前点位
 * - f169: 涨跌额
 * - f170: 涨跌幅 (%)
 * - f86: 时间戳 ms
 *
 * 失败 case：网络断 / `<script>` 注入失败 / 返回 `{ data: null }`（基金代码错或退市）/
 * `f86` 缺失或 0。统一 null 返回，让调用方静默保留旧 cache。
 */
export async function fetchMarketIndex(spec: IndexSpec): Promise<IndexQuoteRaw | null> {
  // 每次唯一回调名 —— push2 不像 pingzhongdata 用固定 var 名，必须避免并发覆盖。
  const cb = `__idxCb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    const resp = await loadIndexScript(spec.secid, cb);
    // 响应形如 { rc, rt, svr, lt, full, dlmkts, data: { f43, ..., f86 } | null }
    const data = (resp as { data?: Record<string, number> | null } | null)?.data;
    if (!data) return null;

    const tsMs = data.f86;
    if (typeof tsMs !== 'number' || tsMs <= 0) return null;

    return {
      value: data.f43 ?? 0,
      change: data.f169 ?? 0,
      changePercent: data.f170 ?? 0,
      date: formatIndexDate(tsMs, spec.market),
      fetchedAt: Date.now(),
    };
  } catch (err) {
    console.error('[indexApi] fetchMarketIndex failed for', spec.secid, err);
    return null;
  }
}
```

- [ ] **Step 2: 构建确认 + 类型检查**

Run: `npm run build`
Expected: PASS。注意此时 `INDEX_LIST` / `fetchMarketIndex` 还没有调用方，TS 严格度下"未被使用"也只在 import 缺失时触发；这里仅 export，**不**会被 `noUnusedLocals` 报。

- [ ] **Step 3: Commit**

```bash
git add src/api/indexApi.ts
git commit -m "feat(index): 新增 indexApi（push2 JSONP 拉指数点位/涨跌/数据日期）"
```

---

### Task 3: 存储 + store + App 接线

**Files:**
- Modify: `src/utils/storage.ts`
- Modify: `src/stores/index.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `fetchMarketIndex`、`INDEX_LIST`（Task 2）；`IndexQuote`（Task 1）
- Produces:
  - `storage.getIndices(): Record<string, IndexQuote>`、`storage.saveIndices(map): void`
  - `exportAllData()` 返回值新增 `indices` 字段；`importAllData` 读 `data.indices ?? {}` 兼容 v0 备份
  - store state 新增 `indices: Record<string, IndexQuote>`
  - store action 新增 `updateIndex(code: string, quote: IndexQuote): void`

- [ ] **Step 1: storage 加 indices 读写**

打开 `src/utils/storage.ts`，在第 2 行 import 段（已有 `NavRecord` import）确认无需新增类型。在文件末尾 `initStorage()` 之前追加：

```ts
// --- Indices cache ---
// 不参与 export/import 之外的"历史清理"流程（不像 navHistory 会被 importAllData 兜底删除），
// 是用户能看到的"上次看到什么"快照，导入备份后用备份里的值覆盖即可。
export function getIndices(): Record<string, IndexQuote> {
  return getItem<Record<string, IndexQuote>>('indices', {});
}

export function saveIndices(map: Record<string, IndexQuote>): void {
  setItem('indices', map);
}
```

同时更新文件顶部的 import 段，把第 1 行改为：

```ts
import type { Platform, Fund, Transaction, DcaPlan, DailySnapshot, Settings, NavRecord, IndexQuote } from '../types';
```

把第 4 行的 `CURRENT_VERSION = 2` **保持不变**（这次改动不涉及 schema 版本——indices 是新增可选字段，旧版本读不到会走 `data.indices ?? {}` 兜底）。

- [ ] **Step 2: storage.exportAllData / importAllData 加 indices 字段**

把 `ExportData` 接口（第 136-145 行）改为：

```ts
interface ExportData {
  version: number;
  platforms: Platform[];
  funds: Fund[];
  transactions: Transaction[];
  dcaPlans: DcaPlan[];
  snapshots: DailySnapshot[];
  settings: Settings;
  navHistories: Record<string, NavRecord[]>;
  /** v1 新增：指数最近一次成功拉取的快照；旧版本备份里没有此字段 */
  indices?: Record<string, IndexQuote>;
}
```

把 `exportAllData()` 第 147-164 行末尾（在 `navHistories,` 之后）追加：

```ts
    indices: getIndices(),
```

把 `importAllData()` 第 166-194 行第二段开头（`setVersion(data.version ?? CURRENT_VERSION);` 之后、`savePlatforms(data.platforms);` 之前）插入：

```ts
  // indices 是 v1 新字段；旧版本备份里 data.indices === undefined 时取空 map
  // （清空本地 indices 而不是保留——因为旧备份的语义就是"完全替换状态"）。
  saveIndices(data.indices ?? {});
```

（放在 `saveSettings(data.settings);` **之前**还是**之后**不影响，但视觉上跟现有顺序对齐更整齐——放在 `saveSettings` 之后。）

- [ ] **Step 3: store 加 indices state + updateIndex action**

打开 `src/stores/index.ts`，把第 2 行的类型导入：

```ts
import type { Platform, Fund, Transaction, DcaPlan, DailySnapshot, Settings, NavRecord } from '../types';
```

改为：

```ts
import type { Platform, Fund, Transaction, DcaPlan, DailySnapshot, Settings, NavRecord, IndexQuote } from '../types';
```

在 `interface FundTrackerState` 里，找到 `// Actions - Settings` 那组（第 56-57 行），在它**之后**插入：

```ts
  // Actions - Indices (市场指数缓存)
  indices: Record<string, IndexQuote>;
  updateIndex: (code: string, quote: IndexQuote) => void;
```

在 store 初始状态里（第 89-91 行 `export const useStore = create<...>` 对象开头，紧跟 `settings:` 那行之后）追加：

```ts
  indices: {},
```

在 store 实现段里，找到 `// --- Settings ---` 段（第 282 行附近，紧跟 `updateSettings:` 之后）插入：

```ts
  // --- Indices ---
  updateIndex: (code, quote) => {
    const indices = { ...get().indices, [code]: quote };
    storage.saveIndices(indices);
    set({ indices });
  },
```

- [ ] **Step 4: store.loadFromStorage 读 indices**

打开 `src/stores/index.ts` 里的 `loadFromStorage`。在它 `set({ ... })` 那一行的对象字面量里追加 `indices: storage.getIndices(),`。

（具体位置：`loadFromStorage` 的实现大概在 `// --- Init & Bulk ---` 段里，把所有 storage.getXxx() 列出来一起 set。在最后追加新字段。）

- [ ] **Step 5: App.tsx 在 refreshAll 末尾追加 index 循环**

打开 `src/App.tsx`，把第 14 行附近的 import：

```ts
import { fetchFundWithHistory } from './api/fundApi';
```

改为：

```ts
import { fetchFundWithHistory } from './api/fundApi';
import { fetchMarketIndex, INDEX_LIST } from './api/indexApi';
import { shouldUpdateIndexQuote } from './utils/indexQuote';
```

找到 `refreshAll` 里 fund 循环结束的位置——具体在第 141-145 行附近：

```ts
    if (refreshGenerationRef.current !== myGen) return;
    // NAV history is now fresh — try to contract auto-confirm pending transactions whose NAV is available
    // 用 useStore.getState() 读最新 transactions，避免把 transactions 加进依赖
    const confirmedCount = autoConfirmPending();
```

在 fund 循环的 `await new Promise(setTimeout(resolve, 500));` **之后**、`if (refreshGenerationRef.current !== myGen) return;` **之前**插入 index 循环：

```ts
    // --- Index 循环 ---
    // 共享同一个 500ms 节奏（与基金一致），3 条小数目 ≈ 1.5s 总耗时，对首屏可接受。
    // 设计决策：index 不接 `hasStale` 闸门（那个闸门判断的是"基金 NAV 是否过时"），
    // 也不接 chineseHolidays（A股休市时美股正常交易，反之亦然）——每个 index 自己判断。
    for (let j = 0; j < INDEX_LIST.length; j++) {
      if (refreshGenerationRef.current !== myGen) return; // superseded
      const spec = INDEX_LIST[j]!;
      try {
        const data = await fetchMarketIndex(spec);
        if (refreshGenerationRef.current !== myGen) return;
        if (!data) continue;
        // spec 已知 name + market，把 raw 合成 IndexQuote 后再走 cache 闸门
        const cached = useStore.getState().indices[spec.code];
        const newQuote: IndexQuote = {
          name: spec.name,
          market: spec.market,
          ...data,
        };
        if (shouldUpdateIndexQuote(cached, newQuote)) {
          updateIndex(spec.code, newQuote);
        }
      } catch (err) {
        console.error('[App] refreshAll index failed for', spec.secid, err);
      }
      if (j < INDEX_LIST.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
```

`updateIndex` 需要从 store 解构出来——把 `refreshAll` 的 useCallback deps（第 157 行的 `}, [funds.length, updateFund, updateNavHistory, updateTransaction, addSnapshot, autoConfirmPending]);`）里的解构对象**之前**增加 `updateIndex`，deps 数组里加上：

```ts
  const { settings, funds, refreshTrigger, loadFromStorage, updateFund, updateNavHistory, updateTransaction, addSnapshot, updateIndex } = useStore();
```

deps：

```ts
  }, [funds.length, updateFund, updateNavHistory, updateTransaction, addSnapshot, updateIndex, autoConfirmPending]);
```

`IndexQuote` 类型需要 import 到 App.tsx。把它加到 App.tsx 第 14 行附近的 import：

```ts
import { fetchMarketIndex, INDEX_LIST } from './api/indexApi';
import { shouldUpdateIndexQuote } from './utils/indexQuote';
```

改为：

```ts
import type { IndexQuote } from './types';
import { fetchMarketIndex, INDEX_LIST } from './api/indexApi';
import { shouldUpdateIndexQuote } from './utils/indexQuote';
```

（注意 `IndexQuote` 与 `fetchMarketIndex` 的引入顺序按字母序放在第 13-14 行 import 段最前面——具体位置以 `import type` 已有的分组为准。）

- [ ] **Step 6: 测试 + 构建**

Run: `npm run test && npm run build`
Expected: `npm run test` 仍 PASS（Task 3 没新增测试）；`npm run build` PASS——纯新增字段与 action，未删除任何东西，类型 / `noUnusedLocals` 都应通过。

若 `npm run build` 报 `Property 'updateIndex' does not exist on type 'FundTrackerState'`：说明 Step 3 的 interface 添加漏了，回到 Step 3 补上。

- [ ] **Step 7: Commit**

```bash
git add src/utils/storage.ts src/stores/index.ts src/App.tsx
git commit -m "feat(store,app): indices 持久化 + store action + refreshAll 追加指数循环"
```

---

### Task 4: 新组件 + Dashboard 替换 + 删除 HoldingsSummary

**Files:**
- Create: `src/components/MarketIndices.tsx`
- Modify: `src/pages/Dashboard.tsx`
- Modify: `src/types/index.ts`（清理 JSDoc 里的 HoldingsSummary 引用）
- Delete: `src/components/HoldingsSummary.tsx`

**Interfaces:**
- Consumes: `useStore().indices`、`INDEX_LIST`（Task 2）
- Produces: Dashboard 上一行 3 张 stat card 的 Row（无 → 有）+ 删除 HoldingsSummary 渲染

> 与 Task 1-3 不同，本任务**包含手动浏览器验证**（JSONP endpoint 是否真的返回 200），
> 原因是这一段是整个设计的最大风险点：push2 是否真支持 `cb=` JSONP 没法靠类型系统保证。

- [ ] **Step 1: 创建 `src/components/MarketIndices.tsx`**

```tsx
import { Card, Row, Col, Tooltip } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useStore } from '../stores';
import { INDEX_LIST } from '../api/indexApi';
import { pnlColor } from '../utils/formatter';
import type { Market } from '../types';

/** US 指数的日期前缀，明示"这是美东时区"——避免用户混淆美东 10-04 与北京 10-04 */
function tzLabel(market: Market): string {
  return market === 'US' ? '美东 ' : '';
}

/**
 * Dashboard 上的 3 张市场指数卡片。每张显示：名称 + 点位（涨跌色）+ 涨跌额/涨跌幅 +
 * 数据日期（带市场 TZ 前缀）。与 HoldingsSummary 同款红涨绿跌（pnlColor）。
 *
 * 数据流：完全被动 —— 读 `useStore().indices[spec.code]`，由 App.refreshAll 在后台更新。
 * 组件本身不发请求、不持有副作用。
 *
 * 空态：cache 没有数据 / value=0 → 显示 "—"，直到下一次 refreshAll 跑完。
 * **不**在此处触发请求，避免每次 mount 都重发——App.refreshAll 是唯一刷新入口。
 */
export default function MarketIndices() {
  const indices = useStore((s) => s.indices);

  return (
    <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
      {INDEX_LIST.map((spec) => {
        const quote = indices[spec.code];
        // value === 0 也算"没拉到"：push2 在 f43=0 时通常是 "data: null" 的退化形态
        const showQuote = quote && quote.value !== 0;

        return (
          <Col xs={24} sm={8} key={spec.code}>
            <Card size="small" hoverable>
              <div style={{ color: '#666', fontSize: 13, marginBottom: 6 }}>
                📊 {spec.name}
              </div>
              {showQuote ? (
                <>
                  <div
                    style={{
                      fontSize: 26,
                      fontWeight: 700,
                      lineHeight: 1.2,
                      fontFamily: 'DIN, "Helvetica Neue", Arial, sans-serif',
                      color: pnlColor(quote.change),
                    }}
                  >
                    {quote.change > 0 && (
                      <ArrowUpOutlined style={{ fontSize: 14, marginRight: 4 }} />
                    )}
                    {quote.change < 0 && (
                      <ArrowDownOutlined style={{ fontSize: 14, marginRight: 4 }} />
                    )}
                    {quote.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: pnlColor(quote.change),
                      marginTop: 6,
                    }}
                  >
                    {quote.change >= 0 ? '+' : ''}
                    {quote.change.toFixed(2)}{' '}
                    ({quote.changePercent >= 0 ? '+' : ''}
                    {quote.changePercent.toFixed(2)}%)
                  </div>
                  <Tooltip
                    title={`本地拉取于 ${dayjs(quote.fetchedAt).format('YYYY-MM-DD HH:mm:ss')}`}
                  >
                    <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
                      {tzLabel(quote.market)}
                      {quote.date.slice(5)}
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

- [ ] **Step 2: 修改 `src/pages/Dashboard.tsx`**

把第 10 行：

```ts
import HoldingsSummary from '../components/HoldingsSummary';
```

改为：

```ts
import MarketIndices from '../components/MarketIndices';
```

找到第 424-425 行（持仓汇总区块）：

```tsx
      {/* ===== 持仓汇总（按平台 / 类型） ===== */}
      <HoldingsSummary summaries={summaries} platforms={platforms} />
```

替换为：

```tsx
      {/* ===== 市场指数（沪深300 / 纳指100 / 标普500） ===== */}
      <MarketIndices />
```

> 注：旧注释里的"持仓汇总（按平台 / 类型）"已被替换；新注释按设计文档 §4 的命名约定写"市场指数"。

- [ ] **Step 3: 清理 `src/types/index.ts` 上的 HoldingsSummary JSDoc 引用**

打开 `src/types/index.ts`，找到第 75 行附近 `FUND_TYPE_COLORS` 的 JSDoc：

```ts
/** 基金类型 → AntD Tag 颜色（持仓列表 / HoldingsSummary / 报表统一口径） */
```

把 "HoldingsSummary /" 整段去掉，改为：

```ts
/** 基金类型 → AntD Tag 颜色（持仓列表 / 报表统一口径） */
```

> 删的是引用，不是语义——FundDetail 仍用同一份颜色，所以 JSDoc 保留"持仓列表 / 报表统一口径"已足。

- [ ] **Step 4: 删除 `src/components/HoldingsSummary.tsx`**

```bash
git rm src/components/HoldingsSummary.tsx
```

- [ ] **Step 5: 测试 + 构建**

Run: `npm run test && npm run build`
Expected: `npm run test` 仍 PASS（无新增测试）；`npm run build` PASS——Dashboard 的 import 已切到 MarketIndices，旧组件已 git rm，没有 unused import / missing module。

若 `npm run build` 报 `Cannot find module '../components/MarketIndices'`：说明 Step 1 文件没写对路径，回到 Step 1 检查。

- [ ] **Step 6: 启动 dev server，浏览器手动验收**

Run: `npm run dev`，浏览器打开 Dashboard（默认路径 `/`）。DevTools 打开 Network 面板 + Console 面板，逐项确认：

> 这一步**必须由人执行**，不能由 agent 代签。若无法执行，把清单原样交回给用户。

- [ ] **QA-1** Network 面板里能看到至少 3 个 `push2.eastmoney.com/api/qt/stock/get?...&cb=__idxCb_...&secid=...` 请求，状态码 200，Response 是 `__idxCb_xxx({...})` JSONP 形态，`data` 字段存在且含 `f43`/`f169`/`f170`/`f86`。

  **如果请求 200 但 Response 是 CORS 报错 / 空响应 / `data: null`**：
  - 这是 push2 JSONP 验证失败的信号。停下来报回控制器，不要继续走 QA-2/3。
  - 备选降级方案见设计文档 §9.1：用 pingzhongdata 拉跟踪 ETF 510310 / 513100 / 513500。

- [ ] **QA-2** Dashboard 上 4 张主指标卡之后、3 张次指标卡之前，能看到 3 张指数卡片：沪深300 / 纳斯达克100 / 标普500。

- [ ] **QA-3** 3 张卡上分别显示：点位数字（千分位带逗号、保留 2 位小数）、涨跌额（带符号）、涨跌幅（带括号 + %）、下方小字日期（CN 不带前缀 / US 带 "美东 " 前缀，格式 `MM-DD`）。

- [ ] **QA-4** 涨的点位是**红色**、跌的**绿色**、平的不上色——和 4 张主指标卡同款。

- [ ] **QA-5** "持仓汇总（按平台 / 类型）"那张表**不再存在**。

- [ ] **QA-6** Console 面板**没有** `[indexApi] fetchMarketIndex failed for ...` 报错。

- [ ] **QA-7** DevTools → Application → Local Storage → `http://localhost:5173/fund-tracker/`（或当前 dev 域名）→ `fund-tracker:indices` 这个 key 存在，内容是 3 条记录（`sh000300` / `usNDX` / `usSPX`），每条都有 `value` / `change` / `changePercent` / `date` / `fetchedAt`。

- [ ] **QA-8** F5 刷新页面：3 张卡在第一时间（localStorage 加载瞬间）就显示上次值（不是 "—"），随后 refreshAll 完成后值会被 API 校验 / 更新（如果 fetch 拿到的 `date` 等于 cache 的 `date`，肉眼上数字不变——这是预期的"市场没动"路径）。

- [ ] **QA-9** 切到 Settings → 数据管理 → 导出 → 在导出的 JSON 文件里能搜到 `indices` 字段，包含 3 条记录。删除 `fund-tracker:indices` 这个 localStorage key → 刷新页面 → 走导入流程 → 再刷新页面 → 3 张卡显示导入的值。

- [ ] **QA-10** 切深色模式（设置里切主题）：3 张卡片的边框 / 文字颜色与 Dashboard 其他卡片协调，hover 高亮仍可见。

- [ ] **Step 7: Commit**

```bash
git add src/components/MarketIndices.tsx src/pages/Dashboard.tsx src/types/index.ts
git rm src/components/HoldingsSummary.tsx
git commit -m "feat(dashboard): 用 MarketIndices 替换 HoldingsSummary，3 张指数卡入位"
```

---

## Self-Review

**1. Spec coverage**

| 设计决定 | 落地任务 |
|---|---|
| 删 HoldingsSummary.tsx | Task 4 Step 4（git rm） |
| 加 3 张指数卡（沪深300 / 纳指100 / 标普500） | Task 2 Step 1（INDEX_LIST）+ Task 4 Step 1（MarketIndices.tsx）|
| 字段：名称 + 点位 + 涨跌额 + 涨跌幅 + 日期 | Task 1 Step 1（IndexQuote 类型）+ Task 4 Step 1（卡片 JSX） |
| 位置：4 张主指标卡下方、3 张次指标卡上方 | Task 4 Step 2（Dashboard.tsx 替换） |
| 持久化 cache + 时间戳 | Task 3 Step 1-2（storage）+ Step 3-4（store）|
| 跟随现有净值刷新（refreshAll + 30 分钟 tick） | Task 3 Step 5（App.tsx 循环）|
| 数据源 push2 JSONP | Task 2 Step 1（loadIndexScript）|
| 独立 CN-US 刷新：API 日期 ≤ cache 日期就跳过 | Task 1 Step 1（`shouldUpdateIndexQuote`）+ Task 1 Step 4（实现）+ Task 3 Step 5（App.tsx 接入）|
| 不维护 usHolidays.ts | 设计文档 §3 已说明；本计划无任何调用方 |
| 不维护节日表；CN 用 Asia/Shanghai；US 用 America/New_York | Task 1 Step 1（`formatIndexDate` + 测试）+ Task 2 Step 1（`fetchMarketIndex` 调用）|
| 日期带 TZ 前缀显示（CN 无前缀 / US "美东 "） | Task 4 Step 1（`tzLabel`）|
| export/import 含 indices（v0 备份兜底） | Task 3 Step 2 |
| 类型 JSDoc 清理（"持仓列表 / HoldingsSummary / 报表统一口径" → "持仓列表 / 报表统一口径"） | Task 4 Step 3 |
| **Non-goal：** 用户可配置指数列表 | 不实现（设计文档 §10 已 deferred）|
| **Non-goal：** 跟踪 ETF fallback | 不实现；Task 4 Step 6 QA-1 是发现路径，触发后另开 PR |
| **Non-goal：** 指数级 throttle | 不实现（设计文档 §3 已接受 336 次/7 天 的浪费）|

**2. Placeholder scan**

已扫描：无 "TBD" / "TODO" / "implement later" / "类似 Task N"。所有代码步骤均给出完整代码块可粘贴；测试步骤给了命令与预期输出（vitest PASS / build PASS / 具体 QA 项）。

**3. Type consistency**

- `Market` / `IndexQuote` / `IndexSpec` 在 Task 1 Step 1 定义于 `src/types/index.ts`，Task 2（`IndexSpec` 用于 `INDEX_LIST` + `fetchMarketIndex` 形参）、Task 3（`IndexQuote` 用于 `updateIndex` 形参 + store state）、Task 4（`Market` 用于 `tzLabel` 形参）三处使用。✓
- `formatIndexDate(ts, market)` 在 Task 1 Step 4 定义为 `(number, Market) => string`；Task 2 Step 1 的 `fetchMarketIndex` 调用 `formatIndexDate(tsMs, spec.market)`——`spec.market` 已是 `Market` 类型，无须断言。✓

- `IndexQuoteRaw`（Task 2 定义）字段集是 `IndexQuote` 的子集（缺 `name` / `market`）；Task 3 Step 5 的 `App.tsx` 用 `{ name: spec.name, market: spec.market, ...data }` 合并，结构兼容。✓
- `storage.getIndices() / saveIndices()`（Task 3 Step 1）签名为 `Record<string, IndexQuote>`；`store.indices` 类型同为 `Record<string, IndexQuote>`；`exportAllData` 的 `indices` 字段是 `Record<string, IndexQuote>`，`importAllData` 读 `data.indices ?? {}` 兜底。✓
- 函数名 / 字段名一致性：`fetchMarketIndex`（Task 2 定义 / Task 3 使用）、`INDEX_LIST`（Task 2 定义 / Task 3、4 使用）、`formatIndexDate`（Task 1 定义 / Task 2 使用）、`shouldUpdateIndexQuote`（Task 1 定义 / Task 3 使用）、`updateIndex`（Task 3 定义 / Task 3 使用）——无命名漂移。✓