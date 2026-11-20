import type { Transaction } from '../types';
import { calcAmountFromShares, calcSharesFromAmount } from './calculator';

/**
 * 一次录入的原始输入（表单读出来的值）。
 *
 * 各字段是否"权威"取决于交易类型：
 * - buy：amount 是权威（用户投了多少钱），shares 由它反算
 * - sell：**shares 是权威**（用户赎回了多少份），amount 由它反算
 * - dividend/cash：amount 是权威，shares = 0
 * - dividend/reinvest：shares 是权威，amount = shares × nav
 */
export interface TxInput {
  type: Transaction['type'];
  dividendType: 'cash' | 'reinvest';
  amount: number;
  fee: number;
  shares: number;
  nav: number;
  /** 待确认：净值尚未发布，amount / shares 有一方算不出来 */
  pending: boolean;
}

/** 一笔交易的最终存储值 */
export interface TxValues {
  amount: number;
  fee: number;
  shares: number;
  nav: number;
}

/**
 * 把录入值解析成交易的存储口径——**唯一真源**。
 *
 * 关键修正（2026-11-20）：卖出手续费从**赎回款**里扣，不减少卖出的份额。
 * 旧口径沿用买入公式 `shares = (amount − fee) / nav`，导致：
 * - 想记「卖 1000 份 @ 1.2345，成交额 1234.50，费 0.50」→ 份额被算成 999.5958（少 0.4 份）
 * - 想让份额正好 1000 → 得把手续费虚增进金额（1235.00），下游现金流又多了 0.50
 * 份额与金额永远无法同时正确。现在卖出以份额为准：
 *   `amount = shares × nav`（成交额），到手 = `amount − fee`。
 *
 * 不变式：amount 恒为**扣费前金额**（买入 = 总付出，卖出 = 成交额），
 * fee 恒从该金额中扣除。两个页面的表单与「确认净值」都走这里，避免口径漂移。
 */
export function resolveTxValues(input: TxInput): TxValues {
  const type = input.type;
  const fee = input.fee ?? 0;
  const pending = input.pending;
  // 待确认 → 净值未知，nav 记 0
  const nav = pending ? 0 : (input.nav ?? 0);

  if (type === 'dividend') {
    if (input.dividendType === 'cash') {
      // 现金分红：金额权威，份额为 0
      return { amount: input.amount ?? 0, fee, shares: 0, nav };
    }
    // 红利再投资：份额权威，成交额 = 份额 × 净值；分红不计手续费
    const shares = input.shares ?? 0;
    return { amount: calcAmountFromShares(shares, nav), fee: 0, shares, nav };
  }

  if (type === 'sell') {
    // 卖出：份额权威，手续费不减少份额
    const shares = input.shares ?? 0;
    if (pending) {
      // 净值未知 → 成交额记 0，份额照记（待确认交易不计入持仓）
      return { amount: 0, fee, shares, nav: 0 };
    }
    return { amount: calcAmountFromShares(shares, nav), fee, shares, nav };
  }

  // 买入：金额权威，份额 = (金额 − 手续费) / 净值（口径不变）
  const amount = input.amount ?? 0;
  if (pending) {
    return { amount, fee, shares: 0, nav: 0 };
  }
  return { amount, fee, shares: calcSharesFromAmount(amount, fee, nav), nav };
}
