import type { Transaction } from '../types';
import { decideNavEntry } from './navEntry';
import { resolveTxValues } from './txValues';

/**
 * 交易录入的决策逻辑——**唯一实现**。
 *
 * 背景：本项目历史上所有真实事故都是同一个形状——**同一条业务规则在两三个地方
 * 各写了一遍，其中一份是旧的或漏了条件**：
 *
 * | 事故 | 形状 |
 * |---|---|
 * | 2026-08-26 买入多算 13.6 份 | 兜底旧净值被当成当日净值（口径没在接口里强制） |
 * | 2026-11-20 卖出份额被侵蚀 | 买入公式被套用到卖出（公式方向没在接口里强制） |
 * | 编辑保存后红利再投资份额归零 | 分红方式用 `amount` 判断（规则手写了两遍） |
 *
 * `FundDetail.tsx` 与 `Transactions.tsx` 各有一份几乎逐行相同的保存流程（约 60 行），
 * 规则之外的判断各写一遍。这个模块把那些判断收成一处，让调用方无法各自发挥。
 *
 * 不变式：
 * - 买入 `shares = (amount − fee) / nav`；卖出 `amount = shares × nav`（份额权威）
 * - `amount` 恒为**扣费前**金额，`fee` 恒从中扣除（卖出不减少份额）
 * - **只有交易当日的净值**能用来推算份额；查不到就按「待确认」记录
 * - 编辑期净值以用户填的为准，不重新判定可用性、不回退到查到的净值
 * - 分红方式只能按 `shares` 判（`amount > 0` 会把红利再投资误判成现金分红）
 */
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

/** 一笔交易的最终存储值 + 保存前的检查结论 */
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

/**
 * 把表单输入解析成可存储的交易草稿。
 *
 * 调用方拿到 `blocking` 非空就该中止保存并把 `blocking` 展示给用户；
 * `warning` 非空是提醒，不阻断。
 */
export function buildTxDraft(input: TxFormInput): TxDraft {
  const {
    type,
    dividendType,
    amount,
    fee,
    shares,
    manualNav,
    lookedUp,
    txDate,
    pendingFlag,
    editing,
    priorShares,
  } = input;

  // ── 第 1 步 · 定 status 与 nav ──────────────────────────────────────
  let status: 'confirmed' | 'pending';
  let nav: number;
  let warning: string | undefined;

  if (editing) {
    // 编辑期：净值以**用户填的**为准。不重新判定可用性，也不回退到查到的净值——
    // 用户能修正一条记错的净值是能力，不是 bug（交易记录页过去连输入框都不给，
    // 靠伪造 `navDate: tx.date` 让"是否当天净值"恒真，属于用巧合掩盖缺陷）。
    status = pendingFlag ? 'pending' : 'confirmed';
    nav = manualNav;
  } else {
    // 新增期：只有交易当日的净值能用来推算份额。查到的净值若是"最近交易日"
    // 兜底（旧日期），用它算份额会静默算错（2026-08-26 实测多算 13.6 份）。
    // 规则本身在 navEntry.ts —— 那里是唯一真源。
    const decision = decideNavEntry({ txDate, lookedUp, manualNav });
    status = pendingFlag ? 'pending' : decision.status;
    nav = status === 'confirmed' ? decision.nav : 0;
    // 用户自己勾了「待确认」就不必再啰嗦；只有"因为拿不到当日净值而被迫待确认"
    // 才需要提醒——那是用户可以自己解决的（手动填当日净值）。
    if (!pendingFlag && status === 'pending' && decision.warning) {
      warning = decision.warning;
    }
  }

  // ── 第 2 步 · 解析数值 ─────────────────────────────────────────────
  // 公式方向与扣费口径的唯一真源在 txValues.ts（买入按金额、卖出按份额）。
  const resolved = resolveTxValues({
    type,
    dividendType,
    amount,
    fee,
    shares,
    nav,
    pending: status === 'pending',
  });

  // ── 第 3 步 · 卖出超额校验 ─────────────────────────────────────────
  // 用 `pendingFlag`（表单勾选框）而不是 `status`：「你不能卖出比持有更多的份额」
  // 这条约束跟净值无关，净值还没发布也必须拦。
  let blocking: string | undefined;
  if (
    type === 'sell' &&
    !pendingFlag &&
    resolved.shares > 0 &&
    resolved.shares > priorShares + 0.0001
  ) {
    blocking =
      `卖出份额超过当前持仓：当前 ${priorShares.toFixed(4)} 份，` +
      `最多可卖 ${priorShares.toFixed(4)} 份`;
  }

  // ── 第 4 步 · 份额舍入 ─────────────────────────────────────────────
  // 顺序要紧：amount 已经由**未舍入**的份额算出（卖出时 amount = shares × nav），
  // 先舍入再算成交额会让存量交易的成交额与今天算出来的差几分钱。
  const draft: TxDraft = {
    status,
    nav,
    amount: resolved.amount,
    fee: resolved.fee,
    shares: Math.round(resolved.shares * 10000) / 10000,
  };
  if (blocking) draft.blocking = blocking;
  if (warning) draft.warning = warning;
  return draft;
}

/**
 * 推断一笔分红交易的分红方式。
 *
 * **判据只能是 `shares`**，不能用 `amount`：红利再投资**同时**有 `amount`
 * （= 份额 × 净值）和 `shares`，用 `amount > 0` 判断会把它误判成现金分红，
 * 编辑保存时把 `shares` 清零——份额凭空消失（真实发生过）。
 * 现金分红的份额恒为 0。
 *
 * 调用方负责只对 `type === 'dividend'` 的交易调用它。
 */
export function inferDividendType(tx: Transaction): 'cash' | 'reinvest' {
  return tx.shares > 0 ? 'reinvest' : 'cash';
}
