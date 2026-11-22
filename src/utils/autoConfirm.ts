import type { NavRecord, Transaction } from '../types';
import { resolveTxValues } from './txValues';
import { exactNavOn, buildNavIndex } from './navSeries';

/**
 * 确认一笔「待确认」交易。
 *
 * 关键不变式：**只有交易当天的净值**能用来推算份额。
 *
 * 历史教训（2026-08-26 实测）：用户当天买入 1575 元，本地净值历史陈旧
 * （只到 08-06），若用「≤ 该日期的最近一条」兜底取到 08-06 的 1.0386，
 * 份额被算成 1516.4645 份，而当日真实净值 1.048 对应的平台确认份额是
 * 1502.8626 份——**多算 13.6 份**，持仓 / 市值 / 成本 / 收益率全错，
 * 界面上只有一句不起眼的「最近交易日」。
 *
 * 所以这里**只认当天**：查不到就返回 `nav-not-published`，由调用方决定
 * 继续等净值发布、还是让用户手动录入平台确认的成交净值。
 *
 * 此前这条规则在三个地方各写一遍：App.tsx 的自动确认检查了日期，
 * 两个页面的手动确认**没检查**——同一个用户动作在不同页面结果不同。
 * 现在只有这一份实现。
 */

/** 确认后要写回交易记录的字段 */
export interface ConfirmPatch {
  status: 'confirmed';
  /** 确认用的净值（分红不需要，缺省不改） */
  nav?: number;
  /** 买入：补份额；卖出：补成交额 */
  amount?: number;
  shares?: number;
}

export type ConfirmResult =
  | { ok: true; patch: ConfirmPatch }
  | {
      ok: false;
      /** 当天净值还没发布 / 本地没收录 */
      reason: 'nav-not-published';
      /** 本地已知的最新净值日（null = 本地没有任何净值） */
      latestKnownDate: string | null;
    };

/**
 * 按当日净值把一笔待确认交易转成确认记录。
 *
 * @param tx        待确认的交易（买入金额权威、卖出份额权威——见 txValues.ts）
 * @param navHistory 该基金的净值历史
 */
export function confirmPendingTx(tx: Transaction, navHistory: NavRecord[]): ConfirmResult {
  // 分红不涉及成交净值：直接确认，不查历史
  if (tx.type === 'dividend') {
    return { ok: true, patch: { status: 'confirmed' } };
  }

  const index = buildNavIndex(navHistory);
  const record = exactNavOn(index, tx.date);
  if (!record) {
    // 本地最新的净值日——用来告诉用户"还差哪一天"
    const latest = index.asc.length > 0 ? index.asc[index.asc.length - 1]!.date : null;
    return { ok: false, reason: 'nav-not-published', latestKnownDate: latest };
  }

  // 统一口径：买入按金额 → 补份额；卖出按份额 → 补成交额，份额不变。
  // 必须走 resolveTxValues：待确认卖出的 amount 恒为 0（净值未知），
  // 用旧的 calcSharesFromAmount 会把份额算成 (0 − fee) / nav 的负数。
  const resolved = resolveTxValues({
    type: tx.type,
    dividendType: 'cash',
    amount: tx.amount,
    fee: tx.fee,
    shares: tx.shares,
    nav: record.nav,
    pending: false,
  });

  return {
    ok: true,
    patch: {
      status: 'confirmed',
      nav: record.nav,
      amount: resolved.amount,
      // 账本的份额精度统一到 4 位小数
      shares: Math.round(resolved.shares * 10000) / 10000,
    },
  };
}
