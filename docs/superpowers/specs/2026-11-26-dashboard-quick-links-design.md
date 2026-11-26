# 首页快链：累计分红 / 今日投入 → 交易记录

> 日期：2026-11-26 · 状态：设计已确认（经两轮评审），待实施

## 背景

首页「次要指标」一行有三张卡：

| 卡片 | 现状 |
|---|---|
| 累计分红 | 不可点 |
| 今日投入 | 不可点 |
| 持仓基金 | 可点 → `/funds` |

「累计分红」「今日投入」是用户想点进去看明细的**入口型指标**——数字本身只说明"有个量"，
真正想问的是"哪些记录贡献了它"。目前只能自己在交易记录页里翻。

点过去要做到"列表正好是这批记录"，就要求交易记录页的筛选能被**外部驱动**。而现在
交易记录页的筛选状态是半拉子的：

| 筛选 | 状态来源 |
|---|---|
| 筛选基金 | 本地 `useState`（`Transactions.tsx:21`） |
| 筛选类型 | 本地 `useState`（`Transactions.tsx:22`） |
| 仅看未确认 | URL `?status=pending`（`Transactions.tsx:24`） |
| 日期 | 不存在 |

一半 URL、一半本地，是"同一个概念两处各写一遍"——本项目事故最常见的形状。
顺带还有一个已存在的隐患：`setPendingOnly` 用 `setSearchParams({status:'pending'})` /
`setSearchParams({})` **覆盖式**写入（`Transactions.tsx:26-28`），任何时候勾一下
「仅看未确认」都会把 URL 里其它参数清空。

## 目标

1. 首页「累计分红」「今日投入」两张卡可点，跳到交易记录页并带上对应筛选
2. 交易记录页的**全部**筛选由 URL 持有——单一真源，刷新/前进后退/分享链接都成立
3. **卡片上的数字 ≡ 点进去之后的列表合计**（本设计最核心的约束，见「数字对齐」）
4. 筛选逻辑抽成纯函数并配单测；URL 参数是外部输入，必须校验

## 不做

- 不做日期范围筛选（只支持单个日期）
- 不给卡片加 `→` 角标或新图标——样式与已有的「持仓基金」卡保持一致
- 不改「持仓基金」卡的跳转目标
- 不引入 jsdom / @testing-library（沿用现有纯函数 + node 环境 vitest 的路子）
- 不碰 `Transaction` / 持久化结构
- 不改任何金额**计算**口径（只让两处本来就该相等的公式显式对齐，见 §数字对齐）

---

## 设计

### 1. 新增 `src/utils/txFilter.ts` —— 筛选的唯一实现

```ts
/** '' = 全部 */
export type TxStatusFilter = '' | 'pending' | 'confirmed';

export interface TxFilters {
  fundId: string;                   // '' = 不限
  type: Transaction['type'] | '';   // '' = 不限
  date: string;                     // '' = 不限；否则 YYYY-MM-DD
  status: TxStatusFilter;           // '' = 全部
}

export function parseTxFilters(
  params: URLSearchParams,
  knownFundIds: readonly string[],
): TxFilters;

export function filterTransactions(txs: Transaction[], f: TxFilters): Transaction[];

export function txFilterParams(f: TxFilters): Record<string, string>;
```

**`parseTxFilters` —— 参数校验（URL 是外部输入，必须校验）**

| 参数 | 规则 | 非法值处理 |
|---|---|---|
| `type` | `Object.prototype.hasOwnProperty.call(TRANSACTION_TYPE_LABELS, v)` | 当作没传（`''`） |
| `date` | `/^\d{4}-\d{2}-\d{2}$/` **且** `dayjs(v).isValid()` **且** `dayjs(v).format('YYYY-MM-DD') === v` | 当作没传（`''`） |
| `fund` | 必须在 `knownFundIds` 里 | 当作没传（`''`） |
| `status` | `'pending'` / `'confirmed'` | 其它值当没传（`''`） |

> **日期校验必须用往返判定**。`dayjs(v).isValid()` **不校验日历合法性**——dayjs 未开
> 严格解析，非法日期会被**进位**而非判无效：
>
> ```
> dayjs('2026-13-45').isValid()  → true   （归一化成 2027-02-14）
> dayjs('2026-02-30').isValid()  → true   （归一化成 2026-03-02）
> dayjs('2026-04-31').isValid()  → true   （归一化成 2026-05-01）
> ```
>
> 只用正则 + `isValid()` 的话，`?date=2026-13-45` 会被当成合法日期接受 → 落地页 0 条
> 记录——正是本设计明令禁止的"死胡同"。

> **类型校验不能靠索引取值判空**。项目开了 `noUncheckedIndexedAccess: true`
> （`tsconfig.app.json:18`），`TRANSACTION_TYPE_LABELS[v]` 是 `string | undefined`，
> 要用 `hasOwnProperty` 判存在性。

无效 `type` / `date` / `fund` / `status` **都不能**变成"0 条记录"的死胡同——
`?type=foo` 应当被忽略，而不是给用户一个空列表再让他猜哪里错了。

**`filterTransactions`** —— 纯函数，四条条件按「空值 = 不限」AND 叠加：

```ts
(!f.fundId || t.fundId === f.fundId)
&& (!f.type || t.type === f.type)
&& (!f.date || t.date === f.date)
&& (!f.status || statusMatch(t, f.status))
```

保持输入顺序不变（排序留在调用处，现状是 `b.date.localeCompare(a.date)` 降序）。
返回**新数组**，不影响入参。

**`txFilterParams`** —— 反向生成 URL 参数，空值不输出。与 `parseTxFilters` 互为逆运算
（往返幂等）。注意这是**重建式**写入：URL 里任何本设计不认识的参数（`?foo=1`）会在
用户动任何筛选后消失——这是"URL 词汇是封闭集合"的必然结果，不是 bug。

### 2. 「待确认」判定只有一个定义

`status=confirmed` 的过滤必须与 `calcDividendTotal` 用的 `onlyConfirmed` **逐字一致**：

| 写法 | 含义 |
|---|---|
| `t.status === 'confirmed'` | ❌ 会漏掉 `status` 未设的记录 |
| `t.status !== 'pending'` | ✅ `onlyConfirmed` 的语义 |

`Transaction.status` 是**可选**字段（`types/index.ts:58`）。表单建的交易一定有 status
（`decideNavEntry` 恒返回 `'confirmed' \| 'pending'`），但**初始持仓没写 status**
（`InitialPositionModal.tsx` 的 tx 对象里没有这个字段），旧数据同理。
`calculator.test.ts:360` 已经把这条语义钉死："剔除 pending，保留 confirmed 与未设
status 的旧数据"。

所以新增一个共享谓词（`calculator.ts`）：

```ts
export function isPendingTx(tx: Transaction): boolean {
  return tx.status === 'pending';
}
export function onlyConfirmed(transactions: Transaction[]): Transaction[] {
  return transactions.filter((t) => !isPendingTx(tx));
}
```

本次统一**"confirmed 判定"的 4 处**：`calculator.ts:8`、`platformImport.ts:177`、
`refreshCycle.ts:154`、新增的 `txFilter.ts`。其余 `=== 'pending'` 的**展示判断**
（`Dashboard.tsx:121`、`txAudit.ts:49` 等）保持原样——语义无歧义，不扩大改动面。

> 不这么做的后果很具体：首页「累计分红」走 `calcDividendTotal`（含 status 未设的记录），
> 落地页走 `=== 'confirmed'`（不含）→ **两个数字依然对不上**，而这正是本设计要消灭的问题。

### 3. `src/pages/Transactions.tsx` —— 筛选改由 URL 持有

- `filterFund` / `filterType` 两个本地 `useState` **删除**，改为 `parseTxFilters` 派生
- 「仅看未确认」Checkbox **改成「状态」Select**（三态：全部 / 已确认 / 未确认），
  因为 URL 的 `status` 词汇是三态，二值 Checkbox 表达不了 `confirmed`：

  | Select 值 | URL | 含义 |
  |---|---|---|
  | 全部 | 无 `status` 参数 | 不过滤 |
  | 已确认 | `?status=confirmed` | `!isPendingTx(tx)` |
  | 未确认 | `?status=pending` | `isPendingTx(tx)` |

  `?status=pending` 是既有契约（`Dashboard.tsx:276` 的「去确认」按钮在用），不变。

- 新增 `updateFilters(patch)`：合并当前筛选 → `txFilterParams` → `setSearchParams(params, { replace: true })`
  - `replace: true`：筛选变化不往浏览器历史里塞中间态，后退键直接回上一页
  - **副作用要说清**：因为是"解析 → 重建"，`?foo=1` 这类不认识的参数会在用户动任何
    筛选后消失
- `setPendingOnly` 那个覆盖式的 `setSearchParams({...})` 随之删除（它就是覆盖隐患本身）
- **筛选栏右侧**：`filters.date` 非空时显示可清除标签 `日期 2026-11-26 ✕`
- 「筛选类型」下拉会显示「分红」/「买入」（`allowClear` 清空 → 参数移除）
- `summary`（本页统计条）的口径不变，仍与过滤后列表一致

**memo 纪律**（本项目有 4 秒实测卡顿史，不能引入新的全量重渲染）：

```ts
const fundIds = useMemo(() => funds.map((f) => f.id), [funds]);
const filters = useMemo(() => parseTxFilters(searchParams, fundIds), [searchParams, fundIds]);
```

`searchParams` 本身稳定（react-router 内部 `useMemo` deps = `[location.search]`），
但 `filters` 若写成组件体内的裸调用 → 每次渲染新对象 → `filteredTxs` 换引用 →
`summary` 重算 → AntD Table 每次拿新 `dataSource` 全量重渲染。

### 4. `src/pages/Dashboard.tsx` —— 两张卡变可点

| 卡片 | 跳转 | 其它变化 |
|---|---|---|
| 累计分红 | `/transactions?type=dividend&status=confirmed` | 加 `hoverable` + `onClick` |
| 今日投入 | `/transactions?date=${todayStr}&type=buy` | 加 `hoverable` + `onClick`；副标题拆开显示 |

**累计分红带 `status=confirmed`** —— 卡片数字来自 `calcDividendTotal`（只算已确认），
落地页要显示**同一批**记录，筛选词必须能表达"只看已确认"。这也让 URL 词汇首次能表达
一个此前无法筛选的状态。

**今日投入的副标题拆分**：卡片正面显示 `交易 ¥2,000 ｜ 待执行定投 ¥1,500`（原先只在
tooltip 里）。原因是卡片总额含「今日应执行但尚未发生的定投」，点进去的列表里**没有**
对应记录——差额必须自己说清楚，否则用户会以为数字算错了。合计仍是 `todayInvested.total`。

**跨零点必须修**：`todayInvested` 的 memo deps 现在是 `[transactions, dcaPlans]`
（`Dashboard.tsx:81-84`），**不含 `todayStr`**。而 `transactions` 只在增删改时换引用
（`stores/index.ts:313`），30 分钟净值 tick 不动它 → 跨零点后 memo 不重算 →

> 卡片副标题写「交易 ¥2,000」（**昨天**的数），链接却是 `?date=今天` → 落地页 0 条。

修法：`useMemo(..., [transactions, dcaPlans, todayStr])`。`todayStr` 是字符串，跨零点
自然变化 → memo 会重算。

日期用页面已有的 `todayStr`（`Dashboard.tsx:52`，本地时区；**不用** `toISOString()`，
那是 UTC，UTC+8 早上 8 点前会算错日子）。tooltip 与副标题重复 → 删掉 tooltip。

`formatMoney` 不带 ¥（返回 `"2,000.00"`），副标题要自己写 `¥${formatMoney(...)}`。

### 5. 写路径防护 —— `fund` URL 化会打开一个孤儿交易的洞

`Transactions.tsx:144` 的「补登初始持仓」按钮由 `filterFund` 控制显隐，
`InitialPositionModal` 拿 `fundId` 建交易。而它的保存路径是：

```ts
// InitialPositionModal.tsx:100
if (!fundId) return;          // ← 只判空，不判存在
```

`getFundById` 对未知 id 返回 `undefined`（`stores/index.ts:175`）→ 弹窗照样能提交 →
写进一条 `fundId: 'xxx'` 的**孤儿交易**（持仓计算、交易自检、平台对账全部对不上）。

今天这个洞不存在，是因为 `filterFund` 只能从 Select 里选真实基金；`fund` 一旦 URL
可控就开了。两层都补：

1. **写入路径**（真正的 invariant，与 fundId 从哪来无关）：
   `InitialPositionModal` 提交前校验 `getFundById(fundId)` 存在，不存在则不写并报错
2. **URL 参数**：`parseTxFilters` 用 `knownFundIds` 校验，未知 fund id 当没传

---

## 数字对齐（本设计的核心约束）

| 卡片 | 卡片数字 | 落地页 | 筛选词 | 对齐 |
|---|---|---|---|---|
| 累计分红 | `calcDividendTotal` = 已确认分红之和，单笔走 `dividendValue(tx)` | 分红统计条（同样走 `dividendValue(tx)`） | `?type=dividend&status=confirmed` | ✅ 三处同一个实现（见下） |
| 今日投入 | 卡片**大字** = `todayInvested.total`（交易 + 待执行定投）；卡片**副标题的「交易」数** = `todayInvested.txAmount` | 买入统计条 = 今天的买入合计（**含待确认**） | `?date=X&type=buy` | ✅ 副标题的「交易」数 ≡ 落地页买入合计 |

**不变式（准确表述）**：

> 卡片**副标题的「交易」数** ≡ 落地页买入合计；卡片**大字**是含待执行定投的当日
> 总投入，落地页用一条提示说明差额。

卡片大字**不能**等于落地页合计 —— 它含「今日应执行但尚未产生交易」的定投，
落地页列表里没有那些记录。差额由落地页的提示条说清楚。

**分红金额只有一个实现**：三处 —— 首页卡片的 `calcDividendTotal`
（`src/utils/calculator.ts`）、年化的 `calcXIRR`（同文件）、落地页的分红统计条
（`src/pages/Transactions.tsx`）—— 都走 `dividendValue(tx)`：

```ts
// src/utils/calculator.ts
export function dividendValue(tx: Transaction): number {
  return tx.amount > 0 ? tx.amount : Math.max(tx.amount, tx.shares * tx.nav);
}
```

口径是 **`amount > 0` 早退**，不是无条件 `Math.max`。

> ⚠️ `calcDividendTotal` 是 `amount > 0` 早退结构，**不是**无条件 `Math.max`。
> 把落地页"改成无条件 `Math.max` 以对齐 `calcDividendTotal`"是**改错方向** ——
> 那会造出第三种写法，正是本设计要消灭的分叉。正确做法是抽出共享的
> `dividendValue(tx)`，三处都走它。

`amount > 0` 早退的理由：`amount` 恒为**扣费前**的真实成交额，红利再投资的
`amount` 由**未舍入**份额算出，比舍入到 4 位的 `shares × nav` 略大一点点 ——
无条件 `Math.max` 会把那个舍入差也算进去。

**「待执行定投」的差额在落地页也要说一句**：卡片合计含「今日应执行但尚未产生交易」的
定投计划。若当天只有定投计划、没有手动买入，落地页会显示「买入 0 笔 / ¥0.00」——
用户会以为定投没跑。落地页在 `date` 筛选生效时，于统计条上方加一句：

> ⓘ 今日另有 ¥1,500 定投计划待执行，尚未产生交易记录

数据来自 `calcTodayInvested(...).planAmount`（与卡片同一份计算，不另写一遍）。

---

## 已知差异（不是 bug）

1. **落地页的统计条不区分 confirmed/pending**（`Transactions.tsx:39` 的注释原文如此声明）
   ——但现在 `status` 筛选生效时，过滤后的列表本身就是单一状态，统计条随之收敛。
   `status=''`（默认）时统计条仍含 pending，与卡片不同——这是既有契约，不改。

2. **`replace: true` 与"前进后退成立"的关系**：筛选变化不写历史，所以后退键是
   **回到上一页**，而不是回到上一个筛选态。目标 2 的"前进后退成立"指的是"URL 是
   真源、刷新与分享链接能还原筛选"，不是"能逐步回退筛选历史"。

3. **清空全部筛选后 URL 是干净的 `/transactions`**：react-router 的 `createPath`
   对 `search === '?'` 有特殊处理，会丢掉问号（`@remix-run/router/dist/router.cjs.js:401`）。

---

## 数据流

```
Dashboard 卡片 onClick
  └─ navigate('/transactions?type=dividend&status=confirmed')
       └─ Transactions 挂载 → parseTxFilters(searchParams, fundIds)
            └─ filterTransactions(transactions, filters) → filteredTxs → 表格
                 └─ 改 Select → updateFilters → setSearchParams → 回到 parseTxFilters
```

数据流是单向的：**URL → 解析 → 过滤 → 渲染**。改 Select = 改 URL = 改解析结果，
三者是同一件事。

## 测试

新建 `src/utils/txFilter.test.ts`（node 环境，纯函数）：

1. `parseTxFilters`：空参数 → 全空
2. `parseTxFilters`：`?type=dividend` / `?type=buy` → 正确解析
3. **无效 `type` 被忽略**（`?type=foo` → `''`）
4. **无效 `date` 被忽略**：`?date=abc`、`?date=2026-13-45`、`?date=2026-02-30`
   （**进位**样例——只靠 `isValid()` 会漏，必须钉死）
5. `parseTxFilters`：`?status=pending` / `?status=confirmed` → 正确解析；其它值 → `''`
6. `parseTxFilters`：未知 fund id → `''`；已知 fund id → 原样
7. `filterTransactions`：fund / type / date / status 各自单独生效
8. `filterTransactions`：四条件叠加
9. `filterTransactions`：`status=pending` 只留 `isPendingTx` 的记录
10. **`filterTransactions`：`status=confirmed` 保留 `status` 未设的记录**
    （与 `onlyConfirmed` 逐字一致——初始持仓没有 status）
11. `filterTransactions`：不改原数组、不改顺序
12. `txFilterParams`：空值不输出；`status` → `status=confirmed`
13. **往返幂等**：`parseTxFilters(new URLSearchParams(txFilterParams(f)), ids)` 与 `f` 相等

`calculator.test.ts` 补一条：`isPendingTx` 与 `onlyConfirmed` 语义一致。

UI 层（点击跳转、标签清除、Select 同步、待执行定投提示）靠 `npm run dev` 手工验证
——沿用现有做法，不引入 DOM 测试基建。

## 实施步骤

1. `src/utils/calculator.ts` —— 抽 `isPendingTx`，统一 3 处 confirmed 判定
2. `src/utils/txFilter.ts` —— 新建纯函数模块
3. `src/utils/txFilter.test.ts` —— 单测
4. `src/components/InitialPositionModal.tsx` —— 写入路径校验基金存在
5. `src/pages/Transactions.tsx` —— 筛选改由 URL 持有 + 状态 Select + 日期标签 +
   待执行定投提示 + 分红公式对齐
6. `src/pages/Dashboard.tsx` —— 两张卡可点 + 今日投入副标题拆分 + memo deps 加 todayStr
7. `npm test` + `npm run build`
8. `CLAUDE.md` 补一句：`txFilter` 是交易记录页筛选的唯一实现

---

## 评审记录

本文档经两轮评审（作者自查 + 独立对抗性评审）修正，主要问题：

| 问题 | 修正 |
|---|---|
| 日期校验用 `dayjs().isValid()`，溢出日期会被接受 | 改往返校验，补进位样例测试 |
| `todayInvested` memo 不含 todayStr，跨零点卡片是昨天的数、链接指向今天 | memo deps 加 `todayStr` |
| `fund` URL 化打开孤儿交易的洞 | 写入路径 + URL 参数两层校验 |
| URL 无法表达"只看已确认"，卡片与落地页永远对不上 | `status` 改三态 + Checkbox 改 Select |
| 落地页对"待执行定投"一无所知，会显示「买入 0 笔」 | 落地页加提示，数据复用 `calcTodayInvested` |
| `status=confirmed` 若写成 `=== 'confirmed'` 会漏掉 status 未设的记录 | 抽 `isPendingTx`，与 `onlyConfirmed` 逐字一致 |
| `filters` 未规定 memo，会引入新的全量重渲染 | 明确 memo 写法 |
| 落地页分红公式与 `calcDividendTotal` 写法不同 | 抽出共享的 `dividendValue(tx)`，三处都走它（**不是**把落地页改成无条件 `Math.max`） |
| `noUncheckedIndexedAccess` 下索引取值判空不可靠 | 用 `hasOwnProperty` |
