# 首页快链：累计分红 / 今日投入 → 交易记录 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首页「累计分红」「今日投入」两张卡可点，跳到交易记录页并带上对应筛选，且卡片数字 ≡ 落地页列表合计。

**Architecture:** 交易记录页的**全部**筛选由 URL 持有（`useSearchParams`），筛选的解析 / 过滤 / 反向生成三个动作收进新增纯函数模块 `utils/txFilter.ts`。`status` 词汇从二值扩到三态（`''` / `pending` / `confirmed`），使「只看已确认」可表达——这是「累计分红」卡片数字能与落地页对齐的前提。

**Tech Stack:** React 18 + TypeScript 5.6 + Vite 6 + Ant Design 5 + React Router 6 + Zustand 5 + Vitest（node 环境，纯函数单测）

**设计文档:** `docs/superpowers/specs/2026-11-26-dashboard-quick-links-design.md`

## Global Constraints

- **只用 node 环境 vitest**（`vite.config.ts` 的 `include: ['src/**/*.test.ts']`、`environment: 'node'`）。不引入 jsdom / @testing-library。
- **不碰 `Transaction` 类型与任何持久化结构**。
- **不改任何金额计算口径**——只把「这笔分红值多少钱」收成**一个实现**：抽出共享的 `dividendValue(tx)`（`src/utils/calculator.ts`），三处（首页卡片的 `calcDividendTotal`、年化的 `calcXIRR`、落地页的分红统计条）都走它。**不要**把落地页改成无条件 `Math.max(...)` —— `calcDividendTotal` 是 `amount > 0` 早退结构，那会造出第三种写法，正是本计划要消灭的分叉。
- **`noUncheckedIndexedAccess: true`**（`tsconfig.app.json:18`）——判"某键是否存在"一律用 `Object.prototype.hasOwnProperty.call(...)`，不能靠索引取值判空。
- **日期用本地时区**——用 `utils/formatter.ts` 的 `today()`，**不用** `toISOString()`（那是 UTC，UTC+8 早上 8 点前会算错一天）。
- **「待确认」判定只有一个定义**——`isPendingTx()`（本计划 Task 1 抽出），任何地方判断 confirmed 都用 `!isPendingTx(tx)`，**不用** `t.status === 'confirmed'`（`Transaction.status` 是可选字段，初始持仓与旧数据没有它）。
- **`filters` 必须 memo**——本项目有 4 秒实测卡顿史；`filters` 若每次渲染新对象 → `filteredTxs` 换引用 → AntD Table 全量重渲染。
- 提交信息用中文，格式 `type(scope): 一句话 —— 说明`，body 写「为什么」不写「做了什么」。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/utils/calculator.ts` | 改 | 导出 `isPendingTx()`（`onlyConfirmed` 改用它）；导出 `dividendValue()`（分红金额的唯一实现，三处共用） |
| `src/utils/platformImport.ts` | 改 | 第 177 行 confirmed 判定改用 `isPendingTx` |
| `src/refresh/refreshCycle.ts` | 改 | 第 154 行 pending 判定改用 `isPendingTx` |
| `src/utils/calculator.test.ts` | 改 | 补 `isPendingTx` 与 `onlyConfirmed` 一致性的测试 |
| `src/utils/txFilter.ts` | **新建** | 交易记录页筛选的唯一实现：解析 / 过滤 / 反向生成 |
| `src/utils/txFilter.test.ts` | **新建** | `txFilter` 单测 |
| `src/components/InitialPositionModal.tsx` | 改 | 写入路径校验基金存在（防孤儿交易） |
| `src/pages/Transactions.tsx` | 改 | 筛选改由 URL 持有；状态 Select；日期标签；数字对齐 |
| `src/pages/Dashboard.tsx` | 改 | 两张卡可点；今日投入副标题拆分；memo deps 补 todayStr |
| `CLAUDE.md` | 改 | 补一句：`txFilter` 是交易记录页筛选的唯一实现 |

---

## Task 1: 抽出 `isPendingTx` —— 「待确认」判定只有一个定义

**Files:**
- Modify: `src/utils/calculator.ts:6-9`
- Modify: `src/utils/platformImport.ts:1`（import）与 `:177`
- Modify: `src/refresh/refreshCycle.ts:5`（import）与 `:154`
- Test: `src/utils/calculator.test.ts`（在 `onlyConfirmed` 那条 it 之后追加）

**Interfaces:**
- Consumes: 无
- Produces: `export function isPendingTx(tx: Transaction): boolean` —— `calculator.ts` 导出，返回 `tx.status === 'pending'`

**为什么:** 全项目有 3 处「confirmed 判定」写成 `t.status !== 'pending'`、8 处写成 `t.status === 'pending'`。`Transaction.status` 是**可选**字段（`types/index.ts:58`）——表单建的交易一定有（`decideNavEntry` 恒返回 `'confirmed' | 'pending'`），但**初始持仓的 tx 对象里没有这个字段**（`InitialPositionModal.tsx`），旧数据同理。`calculator.test.ts:360` 已把语义钉死："剔除 pending，保留 confirmed 与未设 status 的旧数据"。本计划 Task 2 的 `status=confirmed` 过滤必须与这条一致，否则首页「累计分红」（走 `calcDividendTotal` → `onlyConfirmed`）与落地页**依然对不上**——而那正是本设计要消灭的问题。

- [ ] **Step 1: 写失败的测试**

在 `src/utils/calculator.test.ts` 里，把 import 列表补上 `isPendingTx`（在 `onlyConfirmed,` 之后加一行 `isPendingTx,`），并在 `it('onlyConfirmed：剔除 pending，保留 confirmed 与未设 status 的旧数据', ...)` 这条之后紧接着追加：

```ts
  it('isPendingTx：只有 status === "pending" 才算待确认（未设 status = 已确认）', () => {
    expect(isPendingTx(mkTx({ id: 'a', status: 'confirmed' }))).toBe(false);
    expect(isPendingTx(mkTx({ id: 'b', status: 'pending' }))).toBe(true);
    // 未设 status —— 初始持仓与旧数据，向后兼容
    expect(isPendingTx(mkTx({ id: 'c' }))).toBe(false);
  });

  it('isPendingTx 与 onlyConfirmed 语义一致：判 confirmed 就是 !isPendingTx', () => {
    const txs = [
      mkTx({ id: 'a', date: '2026-01-05', status: 'confirmed' }),
      mkTx({ id: 'b', date: '2026-01-06', status: 'pending' }),
      mkTx({ id: 'c', date: '2026-01-07' }),
    ];
    expect(txs.filter((t) => !isPendingTx(t)).map((t) => t.id)).toEqual(
      onlyConfirmed(txs).map((t) => t.id),
    );
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/utils/calculator.test.ts`
Expected: FAIL —— `isPendingTx` 未导出（报 "does not provide an export named 'isPendingTx'" 或 `isPendingTx is not a function`）

- [ ] **Step 3: 实现 `isPendingTx`**

把 `src/utils/calculator.ts` 第 6-9 行这一段：

```ts
/** 过滤掉 pending(待确认)交易;只保留 confirmed 或未设状态的(向后兼容) */
export function onlyConfirmed(transactions: Transaction[]): Transaction[] {
  return transactions.filter((t) => t.status !== 'pending');
}
```

替换成：

```ts
/**
 * 交易是否处于「待确认」状态。
 *
 * 全项目判断「已确认」的依据都走这里 —— **不要**写 `t.status === 'confirmed'`：
 * `Transaction.status` 是可选字段，初始持仓（InitialPositionModal 建的那笔）
 * 和旧数据都没有它，用 `=== 'confirmed'` 会把它们误判成未确认。
 */
export function isPendingTx(tx: Transaction): boolean {
  return tx.status === 'pending';
}

/** 过滤掉 pending(待确认)交易;只保留 confirmed 或未设状态的(向后兼容) */
export function onlyConfirmed(transactions: Transaction[]): Transaction[] {
  return transactions.filter((t) => !isPendingTx(t));
}
```

- [ ] **Step 4: 改另外两处 confirmed 判定**

`src/utils/platformImport.ts` —— 第 1 行的 import 改成：

```ts
import type { Transaction } from '../types';
import { isPendingTx } from './calculator';
```

第 177 行：

```ts
  const ledger = transactions.filter((t) => t.fundId === fundId && t.status !== 'pending');
```

改成：

```ts
  const ledger = transactions.filter((t) => t.fundId === fundId && !isPendingTx(t));
```

`src/refresh/refreshCycle.ts` —— 在 import 区（`import { today } from '../utils/formatter';` 之后）加一行：

```ts
import { isPendingTx } from '../utils/calculator';
```

第 154 行：

```ts
    if (tx.status !== 'pending') continue;
```

改成：

```ts
    if (!isPendingTx(tx)) continue;
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/utils/calculator.test.ts src/utils/platformImport.test.ts src/refresh/refreshCycle.test.ts`
Expected: PASS —— 全部通过（`onlyConfirmed` 语义未变，只是换了写法）

- [ ] **Step 6: 提交**

```bash
git add src/utils/calculator.ts src/utils/calculator.test.ts src/utils/platformImport.ts src/refresh/refreshCycle.ts
git commit -m "refactor(tx): 「待确认」判定抽成 isPendingTx —— confirmed 只有一个定义

Transaction.status 是可选字段：表单建的交易一定有（decideNavEntry 恒返回
confirmed | pending），但初始持仓的 tx 对象里没有这个字段，旧数据同理。
所以判 confirmed 只能是 t.status !== 'pending'，不是 === 'confirmed'。

全项目有 3 处 confirmed 判定各写一遍（calculator / platformImport /
refreshCycle）。新增的 status=confirmed URL 筛选如果写成 === 'confirmed'，
会成为全项目唯一一处用不同定义的地方 —— 首页「累计分红」（走 onlyConfirmed）
与落地页就永远对不上，而那正是这次改造要消灭的问题。

抽出 isPendingTx，3 处统一。onlyConfirmed 语义不变（calculator.test.ts:360
已钉死），测试补两条把这条语义与 onlyConfirmed 钉在一起。"
```

---

## Task 2: `utils/txFilter.ts` —— 筛选的唯一实现

**Files:**
- Create: `src/utils/txFilter.ts`
- Create: `src/utils/txFilter.test.ts`

**Interfaces:**
- Consumes: `isPendingTx(tx: Transaction): boolean`（Task 1 产出）、`TRANSACTION_TYPE_LABELS`（`src/types/index.ts:175`）、`Transaction['type']`（`src/types/index.ts:49`）
- Produces:
  - `export type TxStatusFilter = '' | 'pending' | 'confirmed'`
  - `export interface TxFilters { fundId: string; type: Transaction['type'] | ''; date: string; status: TxStatusFilter }`
  - `export function isRealDate(v: string): boolean`
  - `export function parseTxFilters(params: URLSearchParams, knownFundIds: readonly string[]): TxFilters`
  - `export function filterTransactions(txs: Transaction[], f: TxFilters): Transaction[]`
  - `export function txFilterParams(f: TxFilters): Record<string, string>`

- [ ] **Step 1: 写失败的测试**

新建 `src/utils/txFilter.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import {
  parseTxFilters,
  filterTransactions,
  txFilterParams,
  isRealDate,
  type TxFilters,
} from './txFilter';
import type { Transaction } from '../types';

const KNOWN_FUNDS = ['160140', '008163'];

function mkTx(over: Partial<Transaction> & { id: string }): Transaction {
  return {
    fundId: '160140',
    type: 'buy',
    date: '2026-11-26',
    amount: 1000,
    fee: 0,
    shares: 100,
    nav: 1,
    ...over,
  };
}

function params(q: string): URLSearchParams {
  return new URLSearchParams(q);
}

describe('isRealDate —— 日历合法性必须用往返判定', () => {
  it('合法日期通过', () => {
    expect(isRealDate('2026-11-26')).toBe(true);
    expect(isRealDate('2024-02-29')).toBe(true); // 闰年
  });

  it('形状不对的直接拒绝', () => {
    expect(isRealDate('abc')).toBe(false);
    expect(isRealDate('')).toBe(false);
    expect(isRealDate('2026-1-5')).toBe(false);
    expect(isRealDate('2026/11/26')).toBe(false);
  });

  it('进位日期必须拒绝 —— dayjs 的 isValid() 对它们返回 true', () => {
    // dayjs('2026-13-45').isValid() === true（归一化成 2027-02-14）
    // dayjs('2026-02-30').isValid() === true（归一化成 2026-03-02）
    expect(isRealDate('2026-13-45')).toBe(false);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-04-31')).toBe(false);
    expect(isRealDate('0000-00-00')).toBe(false);
  });
});

describe('parseTxFilters —— URL 参数校验', () => {
  it('空参数 → 全空（= 不过滤）', () => {
    expect(parseTxFilters(params(''), KNOWN_FUNDS)).toEqual({
      fundId: '',
      type: '',
      date: '',
      status: '',
    });
  });

  it('合法参数正确解析', () => {
    const f = parseTxFilters(params('fund=160140&type=dividend&date=2026-11-26&status=confirmed'), KNOWN_FUNDS);
    expect(f).toEqual({
      fundId: '160140',
      type: 'dividend',
      date: '2026-11-26',
      status: 'confirmed',
    });
  });

  it('非法 type 被忽略（不能变成 0 条记录的死胡同）', () => {
    expect(parseTxFilters(params('type=foo'), KNOWN_FUNDS).type).toBe('');
    expect(parseTxFilters(params('type=buy'), KNOWN_FUNDS).type).toBe('buy');
  });

  it('非法 date 被忽略', () => {
    expect(parseTxFilters(params('date=abc'), KNOWN_FUNDS).date).toBe('');
    expect(parseTxFilters(params('date=2026-13-45'), KNOWN_FUNDS).date).toBe('');
    expect(parseTxFilters(params('date=2026-11-26'), KNOWN_FUNDS).date).toBe('2026-11-26');
  });

  it('未知 fund id 被忽略 —— 它会驱动「补登初始持仓」入口', () => {
    expect(parseTxFilters(params('fund=999999'), KNOWN_FUNDS).fundId).toBe('');
    expect(parseTxFilters(params('fund=160140'), KNOWN_FUNDS).fundId).toBe('160140');
  });

  it('status 只认 pending / confirmed', () => {
    expect(parseTxFilters(params('status=pending'), KNOWN_FUNDS).status).toBe('pending');
    expect(parseTxFilters(params('status=confirmed'), KNOWN_FUNDS).status).toBe('confirmed');
    expect(parseTxFilters(params('status=whatever'), KNOWN_FUNDS).status).toBe('');
  });
});

describe('filterTransactions —— 过滤', () => {
  const txs = [
    mkTx({ id: 'a', fundId: '160140', type: 'buy', date: '2026-11-26', status: 'confirmed' }),
    mkTx({ id: 'b', fundId: '160140', type: 'dividend', date: '2026-11-26', status: 'pending' }),
    mkTx({ id: 'c', fundId: '008163', type: 'dividend', date: '2026-11-25', status: 'confirmed' }),
    mkTx({ id: 'd', fundId: '008163', type: 'buy', date: '2026-11-25' }), // 未设 status
  ];

  it('fundId 单独生效', () => {
    const out = filterTransactions(txs, { fundId: '008163', type: '', date: '', status: '' });
    expect(out.map((t) => t.id)).toEqual(['c', 'd']);
  });

  it('type 单独生效', () => {
    const out = filterTransactions(txs, { fundId: '', type: 'dividend', date: '', status: '' });
    expect(out.map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('date 单独生效', () => {
    const out = filterTransactions(txs, { fundId: '', type: '', date: '2026-11-26', status: '' });
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('status=pending 只留待确认', () => {
    const out = filterTransactions(txs, { fundId: '', type: '', date: '', status: 'pending' });
    expect(out.map((t) => t.id)).toEqual(['b']);
  });

  it('status=confirmed 必须保留 status 未设的记录（与 onlyConfirmed 一致）', () => {
    const out = filterTransactions(txs, { fundId: '', type: '', date: '', status: 'confirmed' });
    expect(out.map((t) => t.id)).toEqual(['a', 'c', 'd']);
  });

  it('四条条件叠加', () => {
    const out = filterTransactions(txs, {
      fundId: '160140',
      type: 'dividend',
      date: '2026-11-26',
      status: 'pending',
    });
    expect(out.map((t) => t.id)).toEqual(['b']);
  });

  it('不改原数组、不改顺序', () => {
    const input = [...txs];
    const out = filterTransactions(input, { fundId: '', type: '', date: '', status: '' });
    expect(input).toEqual(txs);
    expect(out).not.toBe(input);
    expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('txFilterParams —— 反向生成 URL 参数', () => {
  it('空值不输出', () => {
    expect(txFilterParams({ fundId: '', type: '', date: '', status: '' })).toEqual({});
  });

  it('非空值输出，参数名固定', () => {
    expect(
      txFilterParams({ fundId: '160140', type: 'buy', date: '2026-11-26', status: 'confirmed' }),
    ).toEqual({ fund: '160140', type: 'buy', date: '2026-11-26', status: 'confirmed' });
  });

  it('往返幂等', () => {
    const f: TxFilters = {
      fundId: '160140',
      type: 'dividend',
      date: '2026-11-26',
      status: 'pending',
    };
    const round = parseTxFilters(new URLSearchParams(txFilterParams(f)), KNOWN_FUNDS);
    expect(round).toEqual(f);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/utils/txFilter.test.ts`
Expected: FAIL —— `Cannot find module './txFilter'`

- [ ] **Step 3: 实现 `src/utils/txFilter.ts`**

新建 `src/utils/txFilter.ts`：

```ts
import dayjs from 'dayjs';
import { TRANSACTION_TYPE_LABELS, type Transaction } from '../types';
import { isPendingTx } from './calculator';

/**
 * 交易记录页的筛选条件 —— **全部由 URL 持有**。
 * 空串 / '' 一律表示"不限 / 全部"，不是"没有值"。
 */
export type TxStatusFilter = '' | 'pending' | 'confirmed';

export interface TxFilters {
  /** 基金 id；'' = 不限 */
  fundId: string;
  /** 交易类型；'' = 不限 */
  type: Transaction['type'] | '';
  /** 交易日期 YYYY-MM-DD；'' = 不限 */
  date: string;
  /** 确认状态；'' = 全部 */
  status: TxStatusFilter;
}

/**
 * 日期合法性判定 —— **必须用往返判定**。
 *
 * dayjs 未开严格解析，非法日期会被**进位**而非判无效：
 *   dayjs('2026-13-45').isValid() === true   （归一化成 2027-02-14）
 *   dayjs('2026-02-30').isValid() === true   （归一化成 2026-03-02）
 *   dayjs('2026-04-31').isValid() === true   （归一化成 2026-05-01）
 *
 * 只靠正则 + isValid() 的话，?date=2026-13-45 会被当成合法日期接受，
 * 落地页查出 0 条 —— 正是"死胡同"。
 */
export function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  if (!dayjs(v).isValid()) return false;
  return dayjs(v).format('YYYY-MM-DD') === v;
}

/**
 * 交易类型是否合法。
 * 不能用 `TRANSACTION_TYPE_LABELS[v]` 判空 —— 项目开了 noUncheckedIndexedAccess，
 * 索引取值是 `string | undefined`，用它判存在性不可靠。
 */
function isRealType(v: string): v is Transaction['type'] {
  return Object.prototype.hasOwnProperty.call(TRANSACTION_TYPE_LABELS, v);
}

function isRealStatus(v: string): v is TxStatusFilter {
  return v === 'pending' || v === 'confirmed';
}

/**
 * 解析 URL 查询参数 → 筛选条件。
 *
 * URL 是外部输入：非法值一律当没传（忽略），而不是变成"0 条记录"的死胡同。
 *
 * @param knownFundIds 账本里真实存在的基金 id。URL 里的 fund 参数必须在此之内，
 *   否则当没传 —— fundId 会驱动「补登初始持仓」入口，未知 id 会写出孤儿交易。
 */
export function parseTxFilters(
  params: URLSearchParams,
  knownFundIds: readonly string[],
): TxFilters {
  const fund = params.get('fund') ?? '';
  const type = params.get('type') ?? '';
  const date = params.get('date') ?? '';
  const status = params.get('status') ?? '';

  return {
    fundId: fund && knownFundIds.includes(fund) ? fund : '',
    type: isRealType(type) ? type : '',
    date: isRealDate(date) ? date : '',
    status: isRealStatus(status) ? status : '',
  };
}

/** 状态筛选是否命中该交易。confirmed 的口径必须与 onlyConfirmed 一致。 */
function statusMatch(tx: Transaction, status: TxStatusFilter): boolean {
  if (status === 'pending') return isPendingTx(tx);
  if (status === 'confirmed') return !isPendingTx(tx);
  return true;
}

/**
 * 按筛选条件过滤交易。
 * 返回**新数组**，不改入参、不改顺序（排序在调用处做）。
 */
export function filterTransactions(txs: Transaction[], f: TxFilters): Transaction[] {
  return txs.filter(
    (t) =>
      (!f.fundId || t.fundId === f.fundId) &&
      (!f.type || t.type === f.type) &&
      (!f.date || t.date === f.date) &&
      (!f.status || statusMatch(t, f.status)),
  );
}

/**
 * 筛选条件 → URL 查询参数（与 parseTxFilters 互为逆运算）。
 * 空值不输出。
 *
 * 这是**重建式**写入：URL 里本模块不认识的参数（如 ?foo=1）会在用户动任何筛选后
 * 消失 —— "URL 词汇是封闭集合"的必然结果，不是 bug。
 */
export function txFilterParams(f: TxFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.fundId) out.fund = f.fundId;
  if (f.type) out.type = f.type;
  if (f.date) out.date = f.date;
  if (f.status) out.status = f.status;
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/utils/txFilter.test.ts`
Expected: PASS —— 3 个 describe 块全绿（约 20 条断言）

- [ ] **Step 5: 提交**

```bash
git add src/utils/txFilter.ts src/utils/txFilter.test.ts
git commit -m "feat(txfilter): 交易记录页筛选的唯一实现 —— 解析 / 过滤 / 反向生成

筛选此前一半在 URL（status）、一半在组件本地 state（fund/type），是"同一个
概念两处各写一遍"。三件事收进 utils/txFilter.ts：解析、过滤、反向生成参数。

URL 是外部输入，参数必须校验。两个坑：
- dayjs 的 isValid() 不校验日历合法性，非法日期会**进位**（'2026-13-45' → true，
  归一化成 2027-02-14）。只靠正则 + isValid() 的话 ?date=2026-13-45 会被当成
  合法日期接受 → 落地页 0 条。改用往返判定 format('YYYY-MM-DD') === v。
- noUncheckedIndexedAccess 下不能用索引取值判存在性 → hasOwnProperty。

status 做成三态（'' / pending / confirmed）：此前 URL 无法表达「只看已确认」，
首页「累计分红」（只算已确认）与落地页的数字永远对不上且无法收敛。

测试 20 条，含进位日期、status 未设的记录（初始持仓没有 status 字段）、
往返幂等。"
```

---

## Task 3: `InitialPositionModal` —— 写入路径防孤儿交易

**Files:**
- Modify: `src/components/InitialPositionModal.tsx:99-100`

**Interfaces:**
- Consumes: `getFundById(id: string): Fund | undefined`（store，`src/stores/index.ts:175`）；组件已有 `const fund = fundId ? getFundById(fundId) : null;`（`InitialPositionModal.tsx:38`）

**为什么:** `fund` 一旦由 URL 驱动（Task 4），未知 fund id 就能进到这个弹窗。而 `handleOk` 只判 `if (!fundId) return;` —— **只判空不判存在**。`getFundById` 对未知 id 返回 `undefined` → 弹窗照样能提交 → 写进一条 `fundId: 'xxx'` 的**孤儿交易**，持仓计算、交易自检、平台对账全部对不上。今天这个洞不存在只是因为 `filterFund` 只能从 Select 里选真实基金。

- [ ] **Step 1: 加写入路径守卫**

把 `src/components/InitialPositionModal.tsx` 的 `handleOk` 开头：

```ts
  const handleOk = async () => {
    if (!fundId) return;
```

改成：

```ts
  const handleOk = async () => {
    // 基金必须真实存在 —— fundId 会从 URL 来（交易记录页的筛选参数），
    // 未知 id 写进去就是一条孤儿交易：持仓计算、交易自检、平台对账全部对不上。
    if (!fundId || !fund) {
      message.error('基金不存在，无法设置初始持仓');
      return;
    }
```

（`message` 已在第 2 行 import，无需改 import。）

- [ ] **Step 2: 跑构建确认类型通过**

Run: `npm run build`
Expected: 构建成功（`fund` 已在组件作用域内，第 38 行）

- [ ] **Step 3: 确认守卫已就位（完整验证在 Task 4 之后）**

本任务的守卫是**写入路径**的防御（"即使 fundId 从哪来是未知值，也不写出孤儿
交易"）。触发路径要等 Task 4 把 `fund` 变成 URL 参数后才存在 —— 完整的手工验证
放在 Task 4 的验证清单第 10 条。

本步只做一件事：确认改动没破坏现有调用方。

Run: `npm run build && npm test`
Expected: 全部通过（FundDetail / FundList 两个入口传的是真实 fundId，行为不变）

- [ ] **Step 4: 提交**

```bash
git add src/components/InitialPositionModal.tsx
git commit -m "fix(initialposition): 写入前校验基金存在 —— 防孤儿交易

handleOk 只判 if (!fundId) return，不判这个 id 是否真实存在。getFundById 对
未知 id 返回 undefined，于是能写进一条 fundId:'xxx' 的孤儿交易：持仓计算、
交易自检、平台对账全部对不上。

今天这个洞没被踩到，只是因为 filterFund 只能从 Select 里选真实基金。
一旦 fundId 变成 URL 可控（本次改造），洞就开了 —— 写入路径的守卫要独立于
fundId 从哪来。
"
```

---

## Task 4: `Transactions.tsx` —— 筛选改由 URL 持有

**Files:**
- Modify: `src/pages/Transactions.tsx`（import 块 `:1-13`、`:16-37`、筛选栏 `:209-235`）

**Interfaces:**
- Consumes: `parseTxFilters(params, knownFundIds)` / `filterTransactions(txs, f)` / `txFilterParams(f)` / `TxFilters` / `TxStatusFilter`（Task 2 产出）
- Produces: 无新导出

**为什么:** 筛选此前一半 URL（status）、一半本地 state（fund/type）。`setPendingOnly` 用覆盖式 `setSearchParams({status:'pending'})` / `setSearchParams({})`（`:26-28`）——勾一下就把 URL 里别的参数清空。

- [ ] **Step 1: 改 import 块**

`src/pages/Transactions.tsx` 第 1-13 行的 import 区，把第 1 行改成：

```tsx
import { useState, useMemo } from 'react';
```

（第 7 行的 `import { formatMoney, formatDate, pnlColor } from '../utils/formatter';` 暂时不动 —— `today` 在 Task 5 加。）

在第 12 行 `import { TRANSACTION_TYPE_LABELS, TX_TYPE_COLORS } from '../types';` 之后加两行：

```tsx
import {
  parseTxFilters,
  filterTransactions,
  txFilterParams,
  type TxFilters,
  type TxStatusFilter,
} from '../utils/txFilter';
```

- [ ] **Step 2: 用 URL 派生筛选，删掉本地 state**

把 `src/pages/Transactions.tsx` 第 21-37 行这一段：

```tsx
  const [filterFund, setFilterFund] = useState<string>('');
  const [filterType, setFilterType] = useState<string>('');
  const [searchParams, setSearchParams] = useSearchParams();
  const pendingOnly = searchParams.get('status') === 'pending';
  const setPendingOnly = (v: boolean) => {
    if (v) setSearchParams({ status: 'pending' });
    else setSearchParams({});
  };
  const [initModalOpen, setInitModalOpen] = useState(false);

  const filteredTxs = useMemo(() => {
    let list = [...transactions];
    if (filterFund) list = list.filter((t) => t.fundId === filterFund);
    if (filterType) list = list.filter((t) => t.type === filterType);
    if (pendingOnly) list = list.filter((t) => t.status === 'pending');
    return list.sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, filterFund, filterType, pendingOnly]);
```

替换成：

```tsx
  const [initModalOpen, setInitModalOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // 筛选的唯一真源是 URL（utils/txFilter.ts 是唯一实现）——本地 state 不再持有
  // 筛选。此前 fund/type 走本地 state、status 走 URL，是"同一个概念两处各写一遍"。
  //
  // fundIds / filters 都必须 memo：filters 若是每次渲染的新对象 → filteredTxs
  // 换引用 → summary 重算 → AntD Table 拿新 dataSource 全量重渲染（本项目有
  // 4 秒实测卡顿史）。searchParams 本身稳定（react-router 内部 useMemo 依赖
  // [location.search]），所以这两层 memo 成立。
  const fundIds = useMemo(() => funds.map((f) => f.id), [funds]);
  const filters = useMemo(() => parseTxFilters(searchParams, fundIds), [searchParams, fundIds]);

  /** 改筛选 = 改 URL。重建式写入：不认识的参数（如 ?foo=1）会被丢弃。 */
  const updateFilters = (patch: Partial<TxFilters>) => {
    setSearchParams(txFilterParams({ ...filters, ...patch }), { replace: true });
  };

  const filteredTxs = useMemo(() => {
    // filterTransactions 返回新数组，排序在上面做 —— 不动 store 里的 transactions
    return filterTransactions(transactions, filters).sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, filters]);
```

- [ ] **Step 3: 筛选栏改成 URL 驱动 + 日期标签**

把 `src/pages/Transactions.tsx` 第 209-235 行这一整段筛选栏：

```tsx
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          placeholder="筛选基金"
          style={{ width: 160 }}
          value={filterFund || undefined}
          onChange={(v) => setFilterFund(v ?? '')}
        >
          {funds.map((f) => (
            <Select.Option key={f.id} value={f.id}>{f.name}</Select.Option>
          ))}
        </Select>
        <Select
          allowClear
          placeholder="筛选类型"
          style={{ width: 120 }}
          value={filterType || undefined}
          onChange={(v) => setFilterType(v ?? '')}
        >
          {Object.entries(TRANSACTION_TYPE_LABELS).map(([key, label]) => (
            <Select.Option key={key} value={key}>{label}</Select.Option>
          ))}
        </Select>
        <Checkbox checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)}>
          仅看未确认
        </Checkbox>
      </Space>
```

替换成：

```tsx
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          placeholder="筛选基金"
          style={{ width: 160 }}
          value={filters.fundId || undefined}
          onChange={(v) => updateFilters({ fundId: v ?? '' })}
        >
          {funds.map((f) => (
            <Select.Option key={f.id} value={f.id}>{f.name}</Select.Option>
          ))}
        </Select>
        <Select
          allowClear
          placeholder="筛选类型"
          style={{ width: 120 }}
          value={filters.type || undefined}
          onChange={(v) => updateFilters({ type: (v ?? '') as TxFilters['type'] })}
        >
          {Object.entries(TRANSACTION_TYPE_LABELS).map(([key, label]) => (
            <Select.Option key={key} value={key}>{label}</Select.Option>
          ))}
        </Select>
        {/* status 是三态（全部 / 已确认 / 未确认）——二值 Checkbox 表达不了
            「只看已确认」。?status=pending 是既有契约（首页「去确认」按钮在用）。 */}
        <Select
          allowClear
          placeholder="确认状态"
          style={{ width: 120 }}
          value={filters.status || undefined}
          onChange={(v) => updateFilters({ status: (v ?? '') as TxStatusFilter })}
        >
          <Select.Option value="confirmed">已确认</Select.Option>
          <Select.Option value="pending">未确认</Select.Option>
        </Select>
        {filters.date && (
          <Tag
            closable
            onClose={() => updateFilters({ date: '' })}
            style={{ marginInlineEnd: 0 }}
          >
            日期 {filters.date}
          </Tag>
        )}
      </Space>
```

- [ ] **Step 4: 清掉不再需要的 Checkbox import**

`src/pages/Transactions.tsx` 第 2 行：

```tsx
import { Card, Table, Button, Select, Tag, Space, message, Popconfirm, Checkbox, Statistic, Row, Col } from 'antd';
```

改成：

```tsx
import { Card, Table, Button, Select, Tag, Space, message, Popconfirm, Statistic, Row, Col } from 'antd';
```

- [ ] **Step 5: 改掉 `filterFund` 的另一处引用**

`src/pages/Transactions.tsx` 第 144 行：

```tsx
          {filterFund && (
```

改成：

```tsx
          {filters.fundId && (
```

第 246 行：

```tsx
        fundId={filterFund || null}
```

改成：

```tsx
        fundId={filters.fundId || null}
```

- [ ] **Step 6: 跑构建确认类型通过**

Run: `npm run build`
Expected: 构建成功。若报 `filterFund` / `filterType` / `pendingOnly` / `setPendingOnly` 未定义，说明还有漏改的引用 —— 全局搜一遍这几个名字确认改干净。

- [ ] **Step 7: 跑全部单测**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 8: 手工验证**

Run: `npm run dev`，然后：
1. 打开 `/fund-tracker/transactions` → 筛选栏出现「筛选基金 / 筛选类型 / **确认状态**」三个下拉，无「仅看未确认」勾选框
2. 「确认状态」选「未确认」→ URL 变成 `/fund-tracker/transactions?status=pending`，列表只剩待确认
3. 取消选择 → URL 变回 `/fund-tracker/transactions`（**没有残留 `?`**）
4. 选「已确认」→ URL 变成 `?status=confirmed`，列表只剩已确认
5. 直接访问 `/fund-tracker/transactions?type=dividend&status=confirmed` → 「筛选类型」显示「分红」、「确认状态」显示「已确认」，列表只剩已确认的分红
6. 浏览器后退 → 回到上一页（筛选变化不写历史）
7. 刷新页面 → 筛选保持
8. 直接访问 `/fund-tracker/transactions?type=foo` → 「筛选类型」为空，列表显示全部（无效参数被忽略，不是 0 条死胡同）
9. 直接访问 `/fund-tracker/transactions?date=2026-13-45` → 无「日期」标签，列表显示全部
10. 直接访问 `/fund-tracker/transactions?fund=999999` → 「筛选基金」为空，「补登初始持仓」按钮**不出现**（Task 3 的写入守卫也守住了另一条路）

- [ ] **Step 9: 提交**

```bash
git add src/pages/Transactions.tsx
git commit -m "refactor(transactions): 筛选全部改由 URL 持有 —— 单一真源

此前 fund/type 走组件本地 useState、status 走 URL，同一个概念两处各写一遍；
setPendingOnly 用覆盖式 setSearchParams({status:'pending'}) / setSearchParams({})，
勾一下就把 URL 里别的参数清空。

现在 fund / type / date / status 全部从 URL 派生，改筛选 = 改 URL。
filterTransactions 返回新数组，排序在其上做，不动 store 里的 transactions。

「仅看未确认」Checkbox 改成「确认状态」Select（三态：全部/已确认/未确认）——
二值 Checkbox 表达不了「只看已确认」，而首页「累计分红」正是要跳到这个状态。

filters 与 fundIds 都用 useMemo：filters 若是每次渲染的新对象 → filteredTxs
换引用 → summary 重算 → AntD Table 全量重渲染（本项目有 4 秒卡顿史）。

无 DOM 测试基建，交互手工验证：后退/刷新/无效参数忽略/日期标签清除。"
```

---

## Task 5: `Transactions.tsx` —— 数字对齐

**Files:**
- Modify: `src/utils/calculator.ts`（新增 `dividendValue()` 导出；`calcDividendTotal` / `calcXIRR` 改走它）
- Modify: `src/pages/Transactions.tsx:7`（import）、`:40-49`（summary）、`:155`（统计条上方插入提示）

**Interfaces:**
- Consumes: `calcTodayInvested(transactions, dcaPlans)`（`src/utils/calculator.ts:459`）、`dividendValue(tx: Transaction): number`（`src/utils/calculator.ts`，本任务新增）、`today()`（`src/utils/formatter.ts:26`）

**为什么:** 卡片数字 ≡ 落地页合计，是本次改造的核心约束。两处要动：落地页分红公式与 `calcDividendTotal` 写法不同（→ 抽出共享的 `dividendValue(tx)`，**不是**把落地页改成无条件 `Math.max`）；「待执行定投」在落地页看不到。

- [ ] **Step 1: 抽出共享的 `dividendValue(tx)`，落地页改走它**

**先在 `src/utils/calculator.ts` 加一个导出**（放在 `calcDividendTotal` 前面）：

```ts
/**
 * 一笔分红折算成金额 —— 现金分红取 amount，红利再投资取 shares × nav。
 *
 * 全项目对「这笔分红值多少钱」只有这一个实现：首页「累计分红」卡片
 * （calcDividendTotal）、年化 XIRR（calcXIRR）、交易记录页的分红统计条
 * 都走它。写成三份就等着分叉。
 */
export function dividendValue(tx: Transaction): number {
  return tx.amount > 0 ? tx.amount : Math.max(tx.amount, tx.shares * tx.nav);
}
```

`calcDividendTotal` 改成：

```ts
export function calcDividendTotal(transactions: Transaction[]): number {
  return onlyConfirmed(transactions)
    .filter((tx) => tx.type === 'dividend')
    .reduce((sum, tx) => sum + dividendValue(tx), 0);
}
```

`calcXIRR` 里的分红那一行改成：

```ts
    else if (tx.type === 'dividend') amount = dividendValue(tx);
```

**然后**改 `src/pages/Transactions.tsx` 的 summary（import 区加
`import { calcTodayInvested, dividendValue } from '../utils/calculator';`），
这一行：

```tsx
      else { dividendCount++; dividendAmount += tx.amount > 0 ? tx.amount : tx.shares * tx.nav; }
```

改成：

```tsx
      // 分红金额走 `dividendValue` —— 与首页卡片（calcDividendTotal）、年化 XIRR
      // （calcXIRR）同一个实现（utils/calculator.ts）。三处各写一遍就等着分叉。
      else { dividendCount++; dividendAmount += dividendValue(tx); }
```

> ⚠️ **不要**把落地页改成无条件 `Math.max(tx.amount, tx.shares * tx.nav)`。
> `calcDividendTotal` 是 `amount > 0` 早退结构，两者**不等价** —— 无条件
> `Math.max` 会在「`amount > 0` 且 `shares × nav > amount`」区间给出不同的数。
> 正确方向是抽出共享的 `dividendValue(tx)`，三处都走它。

- [ ] **Step 2: 算「待执行定投」提示**

在 `src/pages/Transactions.tsx` 的 import 区，把第 7 行：

```tsx
import { formatMoney, formatDate, pnlColor } from '../utils/formatter';
```

改成：

```tsx
import { formatMoney, formatDate, pnlColor, today } from '../utils/formatter';
```

再加一行（放在 `import { confirmPendingTx } from '../utils/autoConfirm';` 之后）：

```tsx
import { calcTodayInvested } from '../utils/calculator';
```

然后在组件里，紧接在 `filteredTxs` 的 useMemo 之后插入：

```tsx
  /**
   * 「待执行定投」提示。首页「今日投入」卡片的合计含「今日应执行但尚未产生交易」的
   * 定投计划 —— 落地页只有真实交易，若当天只有定投没有手动买入，这里会显示
   * 「买入 0 笔 / ¥0.00」，用户会以为定投没跑。数据复用 calcTodayInvested 的
   * planAmount（与卡片同一份计算，不另写一遍）。
   */
  const pendingDcaHint = useMemo(() => {
    if (!filters.date || filters.date !== today()) return null;
    const { planAmount } = calcTodayInvested(transactions, dcaPlans);
    return planAmount > 0 ? planAmount : null;
  }, [filters.date, transactions, dcaPlans]);
```

并把组件解构（第 16 行）改成：

```tsx
  const { funds, transactions, dcaPlans, getNavHistory, updateTransaction, removeTransaction } = useStore();
```

- [ ] **Step 3: 在统计条上方渲染提示**

在 `src/pages/Transactions.tsx` 里，`<Row gutter={[16, 16]} style={{ marginBottom: 16 }}>` 这一行**之前**插入：

```tsx
      {pendingDcaHint !== null && (
        <Alert
          type="info"
          showIcon
          message={`今日另有 ¥${formatMoney(pendingDcaHint)} 定投计划待执行，尚未产生交易记录`}
          style={{ marginBottom: 16 }}
        />
      )}
```

并在 import 块第 2 行的 antd 导入里加上 `Alert`：

```tsx
import { Card, Table, Button, Select, Tag, Space, message, Popconfirm, Statistic, Row, Col, Alert } from 'antd';
```

- [ ] **Step 4: 跑构建 + 单测**

Run: `npm run build && npm test`
Expected: 全部通过

- [ ] **Step 5: 手工验证**

Run: `npm run dev`，然后：
1. 若今天有应执行但未产生交易的定投计划 → 访问 `/fund-tracker/transactions?date=<今天>&type=buy` → 统计条上方出现蓝色提示「今日另有 ¥X 定投计划待执行，尚未产生交易记录」
2. 若今天没有待执行定投 → **不出现**提示
3. 不带 `date` 参数访问 → **不出现**提示（提示只在"今日投入"这条路径上有意义）
4. 「分红笔数 / 累计」的数字与首页「累计分红」在 `?type=dividend&status=confirmed` 下完全相同

- [ ] **Step 6: 提交**

```bash
git add src/pages/Transactions.tsx
git commit -m "fix(transactions): 数字对齐 —— 分红公式与卡片一致 + 待执行定投提示

两处让「卡片数字 ≡ 落地页合计」成立：

1. 分红公式写法不同。落地页用 amount > 0 ? amount : shares*nav，首页
   calcDividendTotal 也是 amount > 0 早退、但 calcXIRR 用的是无条件
   Math.max(amount, shares*nav) —— 三份拼写 = 分叉在等着。抽出共享的
   dividendValue(tx)（amount > 0 早退），三处都走它。注意不要把落地页改成
   无条件 Math.max：那是第三种写法，与 calcDividendTotal 并不等价。

2. 「待执行定投」在落地页看不到。卡片合计含今日应执行但尚未产生交易的定投，
   落地页只有真实交易 —— 当天只有定投没有手动买入时会显示「买入 0 笔 / ¥0.00」，
   用户会以为定投没跑。统计条上方补一句提示，数据复用 calcTodayInvested 的
   planAmount（与卡片同一份计算，不另写一遍）。
"
```

---

## Task 6: `Dashboard.tsx` —— 两张卡可点

**Files:**
- Modify: `src/pages/Dashboard.tsx:81-84`（memo deps）、`:423-447`（两张卡）

**Interfaces:**
- Consumes: `todayStr`（`Dashboard.tsx:52` 已有）、`navigate`（`Dashboard.tsx:36` 已有）、`todayInvested`（组件内已有）

- [ ] **Step 1: 修 memo deps —— 跨零点必须重算**

`src/pages/Dashboard.tsx` 第 81-84 行：

```tsx
  const todayInvested = useMemo(
    () => calcTodayInvested(transactions, dcaPlans),
    [transactions, dcaPlans]
  );
```

改成：

```tsx
  // deps 必须含 todayStr —— transactions 只在增删改时换引用（stores/index.ts:313），
  // 30 分钟净值 tick 不动它。少了 todayStr，跨零点后卡片仍是昨天的数，
  // 而链接指向今天 → 落地页 0 条。
  const todayInvested = useMemo(
    () => calcTodayInvested(transactions, dcaPlans),
    [transactions, dcaPlans, todayStr]
  );
```

- [ ] **Step 2: 累计分红卡变可点**

`src/pages/Dashboard.tsx` 第 425-434 行：

```tsx
          <Card size="small">
            <Statistic
              title="累计分红"
```

改成：

```tsx
          <Card
            size="small"
            hoverable
            onClick={() => navigate('/transactions?type=dividend&status=confirmed')}
          >
            <Statistic
              title="累计分红"
```

**为什么带 `status=confirmed`**：卡片数字来自 `calcDividendTotal`（只算已确认），落地页要显示**同一批**记录，筛选词必须能表达"只看已确认"。

- [ ] **Step 3: 今日投入卡变可点 + 副标题拆分**

`src/pages/Dashboard.tsx` 第 435-447 行整段：

```tsx
        <Col xs={24} sm={8}>
          <Tooltip title={`交易：${formatMoney(todayInvested.txAmount)}  +  定投预期：${formatMoney(todayInvested.planAmount)}`}>
            <Card size="small">
              <Statistic
                title={`今日投入（${today()}）`}
                value={todayInvested.total}
                precision={2}
                valueStyle={{ color: todayInvested.total > 0 ? '#1677ff' : undefined, fontWeight: 600 }}
                prefix={<FundOutlined />}
              />
            </Card>
          </Tooltip>
        </Col>
```

替换成：

```tsx
        <Col xs={24} sm={8}>
          <Card
            size="small"
            hoverable
            onClick={() => navigate(`/transactions?date=${todayStr}&type=buy`)}
          >
            <Statistic
              title={`今日投入（${todayStr}）`}
              value={todayInvested.total}
              precision={2}
              valueStyle={{ color: todayInvested.total > 0 ? '#1677ff' : undefined, fontWeight: 600 }}
              prefix={<FundOutlined />}
            />
            {/* 卡片合计含「今日应执行但尚未发生的定投」—— 点进去的列表里没有对应
                记录，差额必须自己说清楚，否则用户以为数字算错了。
                formatMoney 不带 ¥，这里自己加。 */}
            <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
              交易 ¥{formatMoney(todayInvested.txAmount)} ｜ 待执行定投 ¥{formatMoney(todayInvested.planAmount)}
            </div>
          </Card>
        </Col>
```

（`Tooltip` 的 import 保留 —— 表格列（`Dashboard.tsx:224`/`:232`）与「⚡ 最新净值
盈亏」卡（`:375`）还在用它，只是「今日投入」这张卡上的那个删掉。）

- [ ] **Step 4: 跑构建 + 单测**

Run: `npm run build && npm test`
Expected: 全部通过

- [ ] **Step 5: 手工验证**

Run: `npm run dev`，然后：
1. 首页「累计分红」卡有 hover 效果 → 点击 → 跳到 `/fund-tracker/transactions?type=dividend&status=confirmed`，「筛选类型」显示分红、「确认状态」显示已确认
2. 落地页「分红笔数 / 累计」的数字 ≡ 首页「累计分红」的数字
3. 首页「今日投入」卡副标题显示「交易 ¥X ｜ 待执行定投 ¥Y」→ 点击 → 跳到 `/fund-tracker/transactions?date=<今天>&type=buy`
4. 落地页统计条的「买入笔数 / 金额」≡ 卡片副标题里的「交易 ¥X」
5. 悬停卡片不再显示 tooltip（拆分信息已在卡片正面）

- [ ] **Step 6: 提交**

```bash
git add src/pages/Dashboard.tsx
git commit -m "feat(dashboard): 累计分红 / 今日投入 两张卡可点进交易记录

这两张卡是入口型指标 —— 数字只说明"有个量"，用户真正想问的是"哪些记录贡献了
它"。点过去带上对应筛选，落地页列表正好是这批记录。

累计分红 → ?type=dividend&status=confirmed。必须带 status：卡片数字走
calcDividendTotal（只算已确认），落地页要显示同一批记录，筛选词得能表达
「只看已确认」——此前 URL 根本表达不了。

今日投入 → ?date=今天&type=buy。副标题拆开显示「交易 ¥X ｜ 待执行定投 ¥Y」：
卡片合计含今日应执行但尚未发生的定投，点进去的列表里没有对应记录，差额必须
自己说清楚，否则用户以为数字算错了。原来只在 tooltip 里，现已重复 → 删掉。

顺带修一个跨零点的静默错误：todayInvested 的 memo deps 不含 todayStr，
transactions 只在增删改时换引用（30 分钟净值 tick 不动它），跨零点后卡片仍是
昨天的数、而链接指向今天 → 落地页 0 条。deps 补上 todayStr。"
```

---

## Task 7: 全量验证 + CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`（「核心 seam」一节之后）

- [ ] **Step 1: 跑全量验证**

Run: `npm test && npm run build`
Expected: 全部通过。记录测试条数。

- [ ] **Step 2: 补 CLAUDE.md**

在 `CLAUDE.md` 的「### 核心 seam（2026-11-22 架构重构落地）」小节结束后（也就是「**8. provenance**」那段之后、「## Source Structure」之前）插入一段：

```markdown
**9. 交易筛选 — `utils/txFilter.ts` 的 `parseTxFilters` / `filterTransactions` / `txFilterParams`**

「交易记录页的筛选条件」的唯一实现。筛选**全部**由 URL 持有（`useSearchParams`），
本地 state 不持有筛选 —— 此前 fund/type 走本地、status 走 URL，是"同一个概念两处
各写一遍"。

- `status` 是**三态**（`''` / `pending` / `confirmed`）——二值表达不了「只看已确认」，
  而首页「累计分红」卡片（只算已确认）正是要跳到 `?status=confirmed`。
- `confirmed` 的判定是 `!isPendingTx(tx)`，**不是** `t.status === 'confirmed'`：
  `Transaction.status` 是可选字段，初始持仓与旧数据没有它。
- URL 参数一律校验：`type` / `date` / `fund` / `status` 非法值当没传。日期合法性
  必须用**往返判定**（`dayjs(v).format('YYYY-MM-DD') === v`）——dayjs 的
  `isValid()` 对进位日期（`'2026-13-45'`）返回 true，只靠它会查出 0 条记录。
- `txFilterParams` 是**重建式**写入：不认识的 URL 参数（`?foo=1`）会在用户动任何
  筛选后消失。
```

- [ ] **Step 3: 提交**

**注意：`CLAUDE.md` 是被 gitignore 的**（`.gitignore:6`，理由是「包含架构细节/已知坑/
内部约定——不上传」），**不要 commit 它**。改动落在磁盘上即生效（本地 Claude Code
会话读的就是这个文件）。强推需要 `git add -f`，那是违背用户既定策略，不要做。

本任务**不产生 commit**。

---

## 实施完成后

1. `git push`（Windows 国内网络：`git -c http.connectTimeout=120 -c http.lowSpeedTime=60 push`）
2. push 到 main 会触发 GitHub Pages 部署（`.github/workflows/deploy.yml`）
3. 打开部署后的站点，手工验证一遍 Task 4 / Task 5 / Task 6 的验证清单
