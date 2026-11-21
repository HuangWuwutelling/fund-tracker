import type { NavRecord, Transaction } from '../types';
import { resolveTxValues } from './txValues';
import { INITIAL_POSITION_NOTE, PLATFORM_IMPORT_NOTE } from './txNormalize';

/** 一笔交易的净值核对结果 */
export interface TxAuditIssue {
  txId: string;
  fundId: string;
  date: string;
  type: 'buy' | 'sell';
  /** 记录里的净值 */
  recordedNav: number;
  /** 净值历史里该日期的真实净值 */
  correctNav: number;
  /** 记录里的份额 */
  recordedShares: number;
  /** 按正确净值推算的份额（卖出时与记录相同——份额是权威） */
  correctShares: number;
  /** 记录里的成交额 */
  recordedAmount: number;
  /** 按正确口径的成交额 */
  correctAmount: number;
  fee: number;
}

/** 净值比较容差：接口与本地都是 4 位小数，1e-9 足够滤掉浮点噪声 */
const NAV_EPS = 1e-9;

/**
 * 交易自检：逐笔核对买卖记录的净值与本地净值历史里**同一日期**的净值。
 *
 * 检查对象与排除项：
 * - 只查 buy / sell（分红不涉及成交净值）
 * - 跳过 pending（净值尚未确认，nav=0 是正常的）
 * - 跳过「初始持仓」记录（它的 nav 是成本单价，不是市场净值 —— 见 txNormalize.ts）
 * - 净值历史里没有该日期 → 跳过（缺数据，不是错）
 *
 * 修正口径（与 resolveTxValues 一致）：
 * - 买入：份额权威来自金额 → shares = (amount − fee) / nav
 * - 卖出：份额权威（用户填的）→ amount = shares × nav，份额不变
 */
export function auditTransactions(
  transactions: Transaction[],
  navHistories: Record<string, NavRecord[]>,
): TxAuditIssue[] {
  const issues: TxAuditIssue[] = [];
  for (const t of transactions) {
    if (t.type !== 'buy' && t.type !== 'sell') continue;
    if (t.status === 'pending') continue;
    if (t.note?.includes(INITIAL_POSITION_NOTE)) continue;
    if (t.note?.includes(PLATFORM_IMPORT_NOTE)) continue; // 平台真值，不核对

    const history = navHistories[t.fundId];
    if (!history || history.length === 0) continue;
    const record = history.find((r) => r.date === t.date);
    if (!record) continue; // 该日期不在净值历史里 → 缺数据，不是错
    if (Math.abs(t.nav - record.nav) <= NAV_EPS) continue;

    const resolved = resolveTxValues({
      type: t.type,
      dividendType: 'cash',
      amount: t.amount,
      fee: t.fee,
      shares: t.shares,
      nav: record.nav,
      pending: false,
    });

    issues.push({
      txId: t.id,
      fundId: t.fundId,
      date: t.date,
      type: t.type,
      recordedNav: t.nav,
      correctNav: record.nav,
      recordedShares: t.shares,
      correctShares: resolved.shares,
      recordedAmount: t.amount,
      correctAmount: resolved.amount,
      fee: t.fee,
    });
  }
  return issues;
}
