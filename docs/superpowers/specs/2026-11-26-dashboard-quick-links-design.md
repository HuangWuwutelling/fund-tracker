# 首页快链：累计分红 / 今日投入 → 交易记录

> 日期：2026-11-26 · 状态：设计已确认，待实施

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
3. 筛选逻辑抽成纯函数并配单测；URL 参数是外部输入，必须校验

## 不做

- 不做日期范围筛选（只支持单个日期）
- 不给卡片加 `→` 角标或新图标——样式与已有的「持仓基金」卡保持一致
- 不改「持仓基金」卡的跳转目标
- 不引入 jsdom / @testing-library（沿用现有纯函数 + node 环境 vitest 的路子）
- 不碰 `Transaction` / 持久化结构，不改任何金额计算口径

---

## 设计

### 1. 新增 `src/utils/txFilter.ts` —— 筛选的唯一实现

```ts
export interface TxFilters {
  fundId: string;              // '' = 不限
  type: Transaction['type'] | ''; // '' = 不限
  date: string;                // '' = 不限；否则 YYYY-MM-DD
  pendingOnly: boolean;        // true = 只看未确认
}

export function parseTxFilters(params: URLSearchParams): TxFilters;
export function filterTransactions(txs: Transaction[], f: TxFilters): Transaction[];
export function txFilterParams(f: TxFilters): Record<string, string>;
```

**`parseTxFilters` —— 参数校验（URL 是外部输入，必须校验）**

| 参数 | 规则 | 非法值处理 |
|---|---|---|
| `type` | 必须是 `TRANSACTION_TYPE_LABELS` 的键 | 当作没传（`''`） |
| `date` | 匹配 `^\d{4}-\d{2}-\d{2}$` 且 `dayjs(v).isValid()` | 当作没传（`''`） |
| `fund` | 原样透传 | 未知基金 id 只是查不到行，不报错 |
| `status` | `=== 'pending'` 才算真 | 其它值当没传 |

无效 `type` **不能**变成"0 条记录"的死胡同——`?type=foo` 应当被忽略，而不是给用户一个
空列表再让他猜哪里错了。

**`filterTransactions`** —— 纯函数，四条条件按「空值 = 不限」AND 叠加：

```ts
(!f.fundId   || t.fundId === f.fundId)
&& (!f.type   || t.type === f.type)
&& (!f.date   || t.date === f.date)
&& (!f.pendingOnly || t.status === 'pending')
```

保持输入顺序不变（排序留在调用处，现状是 `b.date.localeCompare(a.date)` 降序）。

**`txFilterParams`** —— 反向生成 URL 参数，空值不输出，`pendingOnly` → `status=pending`。
与 `parseTxFilters` 互为逆运算（往返幂等）。

### 2. `src/pages/Transactions.tsx` —— 筛选改由 URL 持有

- `filterFund` / `filterType` 两个本地 `useState` **删除**，改为 `parseTxFilters(searchParams)` 派生
- `pendingOnly` 从 `searchParams.get('status')` 改为同一份解析结果
- 新增一个 `updateFilters(patch)`：合并当前筛选 → `txFilterParams` → `setSearchParams(params, { replace: true })`
  - `replace: true`：筛选变化不往浏览器历史里塞中间态，后退键直接回上一页
- `setPendingOnly` 那个覆盖式的 `setSearchParams({...})` 随之删除（它就是覆盖隐患本身）
- 筛选栏右侧：`filters.date` 非空时显示可清除标签 `日期 2026-11-26 ✕`
- 「筛选类型」下拉会显示「分红」/「买入」，可改可清
- `summary`（本页统计条）的口径不变，仍与过滤后列表一致

### 3. `src/pages/Dashboard.tsx` —— 两张卡变可点

| 卡片 | 跳转 | 其它变化 |
|---|---|---|
| 累计分红 | `/transactions?type=dividend` | 加 `hoverable` + `onClick` |
| 今日投入 | `/transactions?date=${todayStr}&type=buy` | 加 `hoverable` + `onClick`；副标题拆开显示 |

**今日投入的副标题拆分**：卡片正面显示 `交易 ¥2,000 ｜ 待执行定投 ¥1,500`（原先只在
tooltip 里）。原因是卡片总额含「今日应执行但尚未发生的定投」，点进去的列表里**没有**
对应记录——差额必须自己说清楚，否则用户会以为数字算错了。合计仍是 `todayInvested.total`。

日期用页面已有的 `todayStr`（`Dashboard.tsx:52`，本地时区；**不用** `toISOString()`，
那是 UTC，UTC+8 早上 8 点前会算错日子）。

tooltip 与副标题重复 → 删掉 tooltip。

### 4. 已知差异（不是 bug）

落地页（`?type=dividend`）的分红合计与首页「累计分红」可能差一笔：

| | 口径 |
|---|---|
| 首页 `calcDividendTotal` | 只算已确认（`onlyConfirmed`） |
| 落地页 `summary.dividendAmount` | 算全部过滤后记录（含 pending） |

差异 = 待确认的分红金额。落地页有「状态」列标出「待确认」，用户看得见；落地页统计条
本来就声明过"不区分 confirmed/pending，与过滤后列表口径一致"，不改。

---

## 数据流

```
Dashboard 卡片 onClick
  └─ navigate('/transactions?type=dividend')
       └─ Transactions 挂载 → parseTxFilters(searchParams)
            └─ filterTransactions(transactions, filters) → filteredTxs → 表格
                 └─ 改下拉 → updateFilters → setSearchParams → 回到 parseTxFilters
```

数据流是单向的：**URL → 解析 → 过滤 → 渲染**，没有任何地方反过来从 UI 状态推 URL 之外的
东西。改下拉 = 改 URL = 改解析结果，三者是同一件事。

## 测试

新建 `src/utils/txFilter.test.ts`（node 环境，纯函数）：

1. `parseTxFilters`：空参数 → 全空；`?type=dividend` / `?type=buy` → 正确解析
2. **无效 `type` 被忽略**（`?type=foo` → `''`）
3. **无效 `date` 被忽略**（`?date=abc`、`?date=2026-13-45` → `''`）
4. `?status=pending` → `pendingOnly: true`；其它 status 值 → false
5. `filterTransactions`：fund / type / date / pending 各自单独生效
6. `filterTransactions`：四条件叠加
7. `filterTransactions`：pending 过滤只留 `status === 'pending'`
8. `filterTransactions`：不改原数组、不改顺序
9. `txFilterParams`：空值不输出；`pendingOnly` → `status=pending`
10. **往返幂等**：`parseTxFilters(new URLSearchParams(txFilterParams(f)))` 与 `f` 相等

UI 层（点击跳转、标签清除、下拉同步）靠 `npm run dev` 手工验证——沿用现有做法，
不引入 DOM 测试基建。

## 实施步骤

1. `src/utils/txFilter.ts` —— 新建纯函数模块
2. `src/utils/txFilter.test.ts` —— 单测
3. `src/pages/Transactions.tsx` —— 筛选改由 URL 持有 + 日期标签
4. `src/pages/Dashboard.tsx` —— 两张卡可点 + 今日投入副标题拆分
5. `npm test` + `npm run build`
6. `CLAUDE.md` 补一句：`txFilter` 是交易记录页筛选的唯一实现
