# 第二阶段设计：交易录入收口 + provenance 类型化 + 持仓接口

> 日期：2026-11-22 · 承接 2026-11-22 的架构审核（`.claude/plans/2026-11-22-architecture-refactor.md` 是第一阶段）
> 状态：设计已确认，待实施

## 背景

第一阶段把四个横跨全栈的概念各自收进了 seam（写盘 `commit.ts`、净值序列 `navSeries.ts`、
确认待确认交易 `autoConfirm.ts`、报表净值依赖入参），并修掉了三个已确认的事故。

审核里明确**没有做**的五项，本阶段处理。目标已经确定：**防住下一类事故**——按"能挡住哪类
事故"排序，而不是按"代码好不好看"排序。

本项目历史上所有真实事故都出在**同一件事**上：同一条业务规则在两三个地方各写一遍，
其中一份是旧的或漏了条件。CLAUDE.md 里记着：

| 事故 | 形状 |
|---|---|
| 2026-08-26 买入多算 13.6 份 | 兜底旧净值被当成当日净值（口径没在接口里强制） |
| 2026-11-20 卖出份额被侵蚀 | 买入公式被套用到卖出（公式方向没在接口里强制） |
| 编辑保存后红利再投资份额归零 | 分红方式用 `amount` 判断（规则手写了两遍） |
| 9 笔"异常"交易 | 初始持仓的 nav 存的是成本单价（语义不是市场净值） |
| 指数点位 30 分钟 → 2 小时 | 退避逻辑内联在刷新链路里（策略没在接口里） |

**本阶段要堵的就是这一类**：让"同一条规则只能有一个实现，且那个实现有测试"。

## 目标

1. 交易录入的决策逻辑只有一份实现，且有测试覆盖公式方向、扣费口径、净值日期规则
2. provenance（这笔交易从哪来）由**类型**表达，不再靠备注字符串匹配
3. 「我持有什么」有唯一接口，调用方无法漏传影响数字的参数
4. 一轮刷新的顺序约束写在代码里而不是注释里

## 不做

- **不引入 jsdom / @testing-library**。用纯逻辑抽取代替——表单的决策逻辑抽成纯函数后，
  现有 node 环境的 vitest 就能测；DOM 交互靠 Chrome 手工验证。
- 不做 UI 层测试基建（上一条）
- 不重构 `calculator.ts` 的文件拆分（`position.ts` / `dcaSchedule.ts` / `perf.ts`）——
  它会扩大改动面，与"防事故"无关，留到下次
- 不改 `Transaction` 之外的任何持久化结构
- 不动 `txValues.ts` 的公式语义（它已经是唯一真源且有测试）

---

## 第 1 步 · 交易录入：一份逻辑

### 现状

`FundDetail.tsx` 与 `Transactions.tsx` 各有一份约 60 行的保存流程，形状几乎相同：

```
decideNavEntry(...)  → status 推导  → resolveTxValues(...)  → 卖出超额校验  → 4 位舍入 → txData
```

规则本身在 `utils/txValues.ts`（已是唯一真源），但**规则之外的一堆判断各写一遍**：

| 规则 | FundDetail | Transactions | 差异 |
|---|---|---|---|
| 净值可用性 → status | `FundDetail:360` | `Transactions:103` | 无 |
| 编辑期净值取值 | `values.nav`（用户填的） | `preview.nav`（记录原值） | **用户能否修正错净值** |
| 编辑期净值输入框 | 总是显示 | 不显示（`handleEdit` 伪造 `navDate: tx.date` 使 `isExact` 恒真） | **同账本两处可改性不同** |
| 分红方式推断 | `FundDetail:477` 手写 | `Transactions:247` 手写 | 无（但两处都可能是错的） |
| 卖出超额校验 | `FundDetail:397` | `Transactions:142` | 无 |
| 4 位舍入 | 调用点 | 调用点 | 无 |

### 设计

新增 `src/utils/txFormModel.ts`——纯函数，无 React、无 I/O：

```ts
export interface TxFormInput {
  type: Transaction['type'];
  dividendType: 'cash' | 'reinvest';
  amount: number;
  fee: number;
  shares: number;
  /** 用户手动录入的成交净值；0 = 没填 */
  manualNav: number;
  /** 按日期查到的净值（可能是"最近交易日"兜底值） */
  lookedUp: { nav: number; navDate: string } | null;
  /** 交易日期 YYYY-MM-DD */
  txDate: string;
  /** 用户勾了"待确认" */
  pendingFlag: boolean;
  /** 编辑既有记录——净值以用户填的为准，不重新判定可用性 */
  editing: boolean;
  /** 该基金在这笔交易**之前**的持仓份额 */
  priorShares: number;
}

export interface TxDraft {
  status: 'confirmed' | 'pending';
  nav: number;
  amount: number;
  fee: number;
  shares: number;
  /** 阻断性错误——非空则不能保存 */
  blocking?: string;
  /** 非阻断提醒（净值是兜底值 / 当天净值未发布） */
  warning?: string;
}

export function buildTxDraft(input: TxFormInput): TxDraft;
```

`buildTxDraft` 内部依次调用 `decideNavEntry` → `resolveTxValues`，并**收编**分红方式推断与
卖出超额校验：

```ts
/** 分红方式只能按 shares 判——红利再投资同时有 amount 和 shares */
export function inferDividendType(tx: Transaction): 'cash' | 'reinvest';
```

### 关键决策：编辑期的净值

**统一采用 FundDetail 的行为**：编辑时显示成交净值输入框（回填原值），以用户填的值为准。
理由：CLAUDE.md 已确立"用户可手动录入平台确认的当日净值"，交易记录页不能修正错净值
是能力缺失，不是设计。

`Transactions.handleEdit` 里伪造 `navDate: tx.date` 的做法随之删除——它让 `isExact` 恒为
真，从而既隐藏了输入框又让保存路径取到 lookup 值。

改为：编辑期 `manualNav` 走输入框（预填 `tx.nav`），`lookedUp` 仍用记录里的
`tx.nav` + `tx.date` 供预览展示，但**不参与决策**——编辑期的 `status` 由 `editing`
与 `pendingFlag` 决定，净值由 `manualNav` 决定。

### 完成后

两个页面的保存流程从 ~60 行降到 ~10 行：

```ts
const draft = buildTxDraft({ ...formValues, editing: !!editingTxId, priorShares });
if (draft.blocking) { message.error(draft.blocking); return; }
if (draft.warning) message.warning(draft.warning, 8);
const saved = editingTxId
  ? updateTransaction(editingTxId, { ...draft })
  : addTransaction({ ...draft, id: uuid(), fundId, date: txDate });
if (!saved) { message.error(STORAGE_WRITE_FAILED_MSG, 8); return; }
```

### 测试

`src/utils/txFormModel.test.ts`（新建，node 环境）：

- 买入：`shares = (amount − fee) / nav`；卖出：`amount = shares × nav`，**份额不变**
- `amount` 恒为扣费前金额；`fee` 恒从中扣除
- 分红：`shares > 0` → reinvest（**即使 `amount > 0`**）；`shares === 0` → cash
- 查到的净值日期 ≠ 交易日期且用户没填净值 → `status = 'pending'` 且 `nav = 0`
- 用户填了净值 → `status = 'confirmed'`，用用户填的值
- 编辑期：用户填的净值优先于查到的净值
- 卖出份额 > 该笔交易之前的持仓 → `blocking` 非空
- 份额保留 4 位小数

**完成判据**：两个页面都改用 `buildTxDraft`；上述用例全绿；`npm test` / `tsc -b` /
`npm run build` 通过；Chrome 实测两页各录一笔买入与一笔卖出。

---

## 第 2 步 · 交易录入：一份表单

把两份 JSX 合成 `src/components/TransactionFormModal.tsx`：

```tsx
export interface TransactionFormModalProps {
  open: boolean;
  /** 省略 = 用户可选基金（交易记录页）；指定 = 锁定该基金（基金详情页） */
  fundId?: string;
  /** 编辑模式 */
  tx?: Transaction | null;
  onClose: () => void;
}
```

组件内部拥有：AntD Form、净值预览、手动净值输入、待确认勾选、卖出预览、全部卖出按钮、
保存调用。两个页面只保留各自的表格与导航。

**这一步不改任何规则**——规则在第 1 步已经收成一份。风险最低，但也最容易拖延：
如果第 1 步之后时间紧，这一步可以单独推迟而不留下不一致。

**完成判据**：`FundDetail.tsx` 与 `Transactions.tsx` 都只渲染 `<TransactionFormModal/>`；
Chrome 实测两页表单行为一致（含编辑态的净值可改性）。

---

## 第 3 步 · `Transaction.origin`：provenance 变成类型

### 现状

provenance 靠备注字符串表达：

```ts
// utils/txNormalize.ts
export const INITIAL_POSITION_NOTE = '初始持仓';
export const PLATFORM_IMPORT_NOTE = '平台流水导入';
// utils/txAudit.ts:50-51 —— note?.includes(...)
// utils/txNormalize.ts:30,48 —— note?.includes(...)
```

**后果**：用户在备注里写"初始持仓"两个字，这笔交易会被静默当成初始持仓——排除自检、
nav 被归一化成 0、触发重复计算预警。规则靠 `includes`（子串）匹配，用户无法回避。

### 设计

`src/types/index.ts`：

```ts
export type TxOrigin = 'manual' | 'platform-import' | 'initial-position' | 'dca-auto';

export interface Transaction {
  // ...现有字段
  /** 来源。缺省视为 'manual'（老备份 / 老数据） */
  origin?: TxOrigin;
}
```

新增 `src/utils/txOrigin.ts`：

```ts
/** 从现有数据推断 provenance——迁移用，也用于"按名称重新分类" */
export function detectOrigin(tx: Transaction): TxOrigin;

/** 回填：给没有 origin 的记录补上。幂等。 */
export function backfillOrigin(transactions: Transaction[]): Transaction[];
```

`detectOrigin` 的判定顺序（与现状**完全一致**，保证迁移不改变行为）：

1. `note?.includes(PLATFORM_IMPORT_NOTE)` → `'platform-import'`
2. `note?.includes(INITIAL_POSITION_NOTE)` → `'initial-position'`
3. `tx.planId` 非空 → `'dca-auto'`
4. 否则 → `'manual'`

`txAudit` / `txNormalize` 改为判 `tx.origin`（缺省 `'manual'`），**不再看 note**。

### 迁移

`backfillOrigin` 在两处调用：`stores.loadFromStorage` 与 `stores.importData`——
与既有的 `normalizeInitialPositionNav` 同一时机、同一模式。幂等（已有 origin 的不动）。
**保留 note 原值**——最坏情况用户可人工改回。

风险点：这是唯一会改写真实用户数据的一步。缓解：
- 回填用与现状相同的 `includes` 判定 → 老数据的分类结果与今天**完全一致**
- 保留 note → 可回退
- 迁移前后各跑一次"交易自检"对账（`verify-reports` 那套）

**新记录从创建起就带 origin**：初始持仓弹窗、`PlatformImportModal`、定投自动记录各写自己的
origin，note 回归自由文本。

### 测试

`src/utils/txOrigin.test.ts`：判定顺序、老数据回填、幂等性、`origin` 缺省视为 manual、
带 origin 的记录不再被 note 内容影响。

---

## 第 4 步 · `utils/portfolio.ts`：「我持什么」

### 现状

四个地方各算各的持仓：

| 位置 | 怎么算 |
|---|---|
| `Dashboard.tsx:55` | `calcFundSummary` 映射 + reduce |
| `FundDetail.tsx:158` | `calcFundSummary`；`:192-193` 又用 `calcCost`+`calcShares` 重算一遍均价 |
| `utils/snapshot.ts:23-24` | `calcShares`+`calcCost` 循环累加 |
| `utils/reportGenerator.ts` | `buildSharesTimeline` 独立重实现份额累积 |

而且**每个调用点都得记得传 `settings.usQdiiFilterMode`**（`Dashboard:55,134`、
`FundDetail:155,337`）——漏传不报错，只是安静地改变数字。

### 设计

`src/utils/portfolio.ts`：

```ts
export interface FundPosition {
  fund: Fund;
  shares: number;
  cost: number;
  avgCost: number;
  marketValue: number;
  totalReturn: number;
  returnRate: number;
  dailyPnl: number | null;
  currNavDate: string;
  prevNavDate: string;
  xirr: number;
  dividend: number;
}

export interface PortfolioTotals {
  totalValue: number;
  totalCost: number;
  totalReturn: number;
  totalReturnRate: number;
  totalDailyPnl: number | null;
  navDateBuckets: { date: string; count: number }[];
  noNavCount: number;
  coveredCount: number;
}

export interface PortfolioInput {
  funds: Fund[];
  transactions: Transaction[];
  navHistoryOf: (fundId: string) => NavRecord[];
  /** 关键：收在接口里，调用方无从遗漏 */
  mode: UsQdiiFilterMode;
}

export function portfolioView(input: PortfolioInput): {
  positions: FundPosition[];
  totals: PortfolioTotals;
};

export function fundPosition(input: PortfolioInput, fundId: string): FundPosition | null;
```

`calculator.calcFundSummary` 的实现搬进 `portfolio.ts`（它是"单只基金的头寸"计算），
`calcShares` / `calcCost` 留在 `calculator.ts`（低层算术，已被 characterization 测试锁住）。

调用方：`Dashboard` 用 `portfolioView`，`FundDetail` 用 `fundPosition`，
`snapshot.ts` 改用 `portfolioView(...).totals`（保证快照与 Dashboard 同源）。

### 测试

`src/utils/portfolio.test.ts`：组合总数 = 各基金之和；mode 生效（同一份数据在
`auto` / `off` 下 QDII 的 usable 序列不同 → 数字不同）；无持仓基金不计入。

---

## 第 5 步 · `refresh/refreshCycle.ts`（最低优先）

### 现状

`App.tsx:183` 起的 `refreshAll` 是个 ~70 行闭包，三个顺序约束只以注释存在：

- 指数必须先拉（`App.tsx:236` 注释）——指数是全市场数据，与持仓无关
- 自动确认必须在所有净值写入**之后**（`App.tsx:241` 附近）
- 新鲜度基线必须在循环**之后**（`App.tsx:247-248`）——提前调用会看到旧数据

重排任何一个都不会报错，只会静默产出错误数字。

### 设计

`src/refresh/refreshCycle.ts`：

```ts
export interface RefreshOutcome {
  issues: Record<string, FundRefreshIssue>;
  freshFundIds: Set<string>;
  completedAt: string;
  confirmedCount: number;
}

export interface RefreshDeps {
  fetchFundNav: (fundId: string) => Promise<FetchFundResult>;
  fetchIndexQuotes: () => Promise<IndexQuote[]>;
  navOf: (fundId: string) => NavRecord[];
  commitFund: (fundId: string, nav: number, navDate: string) => boolean;
  commitNavHistory: (fundId: string, records: NavRecord[]) => void;
  commitTransaction: (id: string, patch: Partial<Transaction>) => boolean;
  commitSnapshot: () => void;
  recordBaseline: (latestDateOf: (fundId: string) => string | undefined) => void;
}

export async function runRefreshCycle(
  deps: RefreshDeps,
  plan: { runIndices: boolean; runFundNavs: boolean },
): Promise<RefreshOutcome>;
```

顺序写在函数体里（fetch → publish → confirm → observe → snapshot），
`decideTickAction` 改成返回执行计划而不是三态字符串。

### 测试

`src/utils/refreshCycle.test.ts`（或 `src/refresh/refreshCycle.test.ts`）：
注入假的 fetch，确认调用顺序（confirm 在所有 nav 写入之后、observe 在最后）；
`runIndices: false` 时不拉指数。

**这一步是行为保持型重构，价值最低——前四步做完再做。**

---

## 验证策略（每一步都适用）

1. **先写失败测试**，看到它以正确的原因失败（不是编译错误）
2. 实现 → `npm test` 全绿 → `npx tsc -b` 干净 → `npm run build` 通过
3. **变异检查**：把关键实现改坏，确认对应测试失败（避免写出恒真的断言）
4. Chrome 手工验证受影响路径
5. 一个步骤一个提交，提交信息写清"挡住了哪类事故"

## 风险与对策

| 风险 | 对策 |
|---|---|
| 第 3 步改写真实用户数据 | 回填用与现状相同的 `includes` 判定 → 分类结果不变；保留 note；迁移前后各跑一次自检对账 |
| 第 2 步改动面最大 | 第 1 步不落地不做第 2 步；第 2 步不改任何规则 |
| 抽出 seam 后行为悄悄变了 | 每步都加"同样的输入 → 同样的输出"的对照测试（characterization） |
| 一次改太多，回滚困难 | 每步一个提交，可单独 revert |

## 分支策略

第一阶段的 5 个提交在 `refactor/write-seam-and-nav-series`（已验证：354 passed / 1 skipped，
tsc 干净，构建通过，Chrome 实测通过）。**建议先合进 main**——它是可部署状态，且是本阶段的
地基；合完再开新分支做第二阶段，出问题可整段回退。

（合 main 会触发 GitHub Pages 部署。）

## 完成判据（整体）

- `npm test` 全绿，新增用例数 ≥ 40
- `npx tsc -b` 干净，`npm run build` 通过
- Chrome 实测：交易记录页 / 基金详情页的买入、卖出、编辑、待确认四条路径
- CLAUDE.md 补上「交易录入」「provenance」两节，写清各自的不变式与接口
