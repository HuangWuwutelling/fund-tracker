# 卖出交易改为按份额录入 — 设计文档

日期：2026-11-20
状态：已批准，待实施

## 背景与问题

卖出表单原本只有「金额」+「手续费」，份额由 `calcSharesFromAmount(amount, fee, nav) = (amount − fee) / nav`
**反算**得到。这个式子是**买入**口径（买入时金额 = 总付出，手续费内扣，净买入 = 金额 − 手续费），
套到卖出上自相矛盾：

- 想记录「卖 1000 份 @ 净值 1.2345，成交额 1234.50，手续费 0.50，到手 1234.00」
  - 填金额 `1234.50` → 份额被算成 `999.5958` 份，**少卖 0.4 份**，持仓留零头
  - 想让份额正好 1000 → 必须填 `1235.00`（把手续费虚增进金额），但下游现金流按
    「金额 − 手续费」算 = 1234.50，比实际到手多算 0.50

也就是说，**份额和金额不可能同时正确**。更根本的是：卖出时手续费是从**赎回款**里扣的，
不该减少卖出的份额；现公式却把它当成"减少投入"。

### 真实案例（本项目 2026-11-19 的记录）

```
2026-11-06 分红再投资   +57.6100 份   → 累计 12498.5567 份
2026-11-19 卖出   amount=14104.83  → 份额反算成 12488.7817 份
                                      → 残留 9.775 份 ≈ 11.04 元
```

用户实际卖出全部 12498.5567 份（按净值 1.1294 应成交 14115.87 元），因表单只允许填金额，
填了平台显示的净额 14104.83，应用再反算份额 → **少记 9.775 份**，该基金仍显示持仓 9.775 份 /
11.04 元，市值与收益率均失真。且无法用手续费字段补救——那只会让份额算得更少。

## 设计决策

| 决策 | 选择 |
|---|---|
| 卖出录入单位 | **份额为主**（成交额自动算），配「全部卖出」按钮 |
| 是否保留「按金额赎回」入口 | **不保留**——卖出统一按份额录入 |
| 历史记错的记录 | **编辑时提供「按该笔交易前持仓」按钮**，手动修正，不做自动迁移脚本 |

不做（YAGNI）：按金额赎回入口、买入侧改动、历史数据迁移脚本、平台费率表。

## 一、存储口径（唯一真源）

| 类型 | 用户录入 | 权威字段 | 派生关系 |
|---|---|---|---|
| 买入 | 金额 + 手续费 | `amount` | `shares = (amount − fee) / nav`　**不变** |
| **卖出** | **份额** + 手续费 | `shares` | `amount = shares × nav`；到手 = `amount − fee`　**修正** |
| 分红-现金 | 金额 | `amount` | `shares = 0`　不变 |
| 分红-再投资 | 份额 | `shares` | `amount = shares × nav`　不变 |

不变式：`amount` 恒为**扣费前金额**（买入 = 总付出，卖出 = 成交额），`fee` 恒从该金额中扣除。
买入侧一字不改，只修卖出侧。

## 二、新增纯函数

全部为纯函数、无副作用，可单测，两处表单共用。

- `calcAmountFromShares(shares, nav)` → `shares × nav`（`utils/calculator.ts`）
- `calcSharesBeforeTx(transactions, tx)` → 该笔交易**之前**的持仓份额
  （排除 tx 自身、含同日交易；`utils/calculator.ts`）
- `resolveTxValues(input)` → 统一解析一笔交易的 `{ amount, fee, shares, nav }`
  （新文件 `utils/txValues.ts`）

`resolveTxValues` 是关键：把「买入按金额 / 卖出按份额 / 分红两种方式 / 待确认」的分支收敛到
**一个纯函数**，`FundDetail` 与 `Transactions` 两个表单、以及两处 `handleConfirm` 都调它——
消除当前三份重复逻辑。

### resolveTxValues 分支表

| type | pending | amount | fee | shares | nav |
|---|---|---|---|---|---|
| buy | 否 | 输入 | 输入 | `(amount − fee) / nav` | 输入 |
| buy | 是 | 输入 | 输入 | `0`（净值未知） | `0` |
| sell | 否 | `shares × nav` | 输入 | 输入 | 输入 |
| sell | 是 | `0`（净值未知） | 输入 | 输入 | `0` |
| dividend (cash) | — | 输入 | 输入 | `0` | 输入 |
| dividend (reinvest) | — | `shares × nav` | `0` | 输入 | 输入 |

## 三、卖出表单（FundDetail 与 Transactions 同步改）

```
交易类型  [卖出 ▾]
交易日期  [2026-11-19]
卖出份额  [ 12498.5567 ] 份   ← 用户填
成交净值  [ 1.1294    ]       ← 自动查，可手改
成交金额  [ 14115.87  ] 元    ← 自动算（份额 × 净值）
手续费    [ 11.04     ] 元    ← 用户填
实际到手  [ 14104.83  ] 元    ← 自动算
[ 全部卖出 ]  ← 填入份额
```

**「全部卖出」按钮的份额来源**：

- 新建卖出 → 当前持仓 `calcShares(已确认交易)`
- 编辑卖出 → **该笔交易前的持仓** `calcSharesBeforeTx(...)` ← 修历史记错的记录靠这个

## 四、待确认（pending）语义

净值未发布时份额已知、成交额未知：

- 买入 pending：`shares = 0`（现状不变）
- **卖出 pending：份额照记，`amount = 0`**（净值未知）
- 确认时（两处 `handleConfirm`）按类型分支：卖出 → `amount = shares × 确认净值`，份额不变

pending 交易不计入持仓（`onlyConfirmed` 已保证），因此记录份额是安全的。

## 五、影响面（已逐个核对）

| 消费方 | 用到什么 | 是否受影响 |
|---|---|---|
| `calcShares` | `shares` | 否 |
| `calcCost` | `shares`（按比例扣成本） | 否 |
| `calcXIRR` | 卖出现金流 = `amount − fee` = 到手 | 否，且**顺带修正**旧口径多算手续费的偏差 |
| 交易列表统计 `sellAmount` | `amount − fee` | 否 |
| 周报 `totalSellNet` | `amount − fee` | 否 |
| 持仓时间线 | `shares` | 否 |

结论：下游**全部正确**，无需改动。

## 六、测试（TDD）

- `utils/txValues.test.ts`：`resolveTxValues` 全分支表驱动（4 类型 × 待确认/已确认）
- `utils/calculator.test.ts` 补充：`calcAmountFromShares`、`calcSharesBeforeTx`
  （含同日多笔、编辑自身排除、pending 排除）
- 回归：现有 calculator / indicators / reportGenerator / verify-reports 测试全绿

## 七、实施步骤

1. RED：`txValues.test.ts` + `calculator.test.ts` 补充用例，跑出失败
2. GREEN：`utils/txValues.ts`、`calcAmountFromShares`、`calcSharesBeforeTx`
3. 表单改造：`FundDetail.tsx` + `Transactions.tsx` 的卖出字段、「全部卖出」按钮、预览区
4. `handleConfirm` 改造：两处都改用 `resolveTxValues` 的卖出分支
5. `calcSharesFromAmount` 注释标注为"买入专用"
6. 验证：`npm test` + `npm run build`；`npm run dev` 手工验证表单与「全部卖出」
7. 文档：`CLAUDE.md` 记录卖出口径变更
