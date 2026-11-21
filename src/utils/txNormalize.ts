import type { Transaction } from '../types';

/** 「初始持仓」记录的 note 标记（初始持仓弹窗写入） */
export const INITIAL_POSITION_NOTE = '初始持仓';

/**
 * 「平台流水导入」记录的 note 标记（平台流水对账弹窗写入）。
 *
 * 这类记录的金额/份额/净值**都是平台给的真值**，不是应用反算出来的，
 * 所以「交易自检」不参与核对（见 utils/txAudit.ts）。
 */
export const PLATFORM_IMPORT_NOTE = '平台流水导入';

/**
 * 归一化「初始持仓」记录的 `nav` 字段。
 *
 * 初始持仓是"某一时点的持仓快照"：它的 `nav` 存的是**成本单价**（初始持仓弹窗用
 * 成本 ÷ 份额 自动算出来的），**不是**那一天的**市场净值**。两者语义完全不同：
 * - 拿它去跟净值历史比对 → 必然误报（2026-11 审计里 9 笔全是这么被标成"异常"的）
 * - 交易表的「净值」列显示的也不是净值
 *
 * 成本单价可以由 `amount ÷ shares` 推导出来，无需单独存 → 统一置 0
 * （0 = 该记录没有市场净值）。
 *
 * 返回原数组引用表示"无变化"（调用方据此判断是否需要写盘）。
 */
export function normalizeInitialPositionNav(transactions: Transaction[]): Transaction[] {
  let changed = false;
  const out = transactions.map((t) => {
    if (t.note?.includes(INITIAL_POSITION_NOTE) && t.nav > 0) {
      changed = true;
      return { ...t, nav: 0 };
    }
    return t;
  });
  return changed ? out : transactions;
}

/**
 * 该基金最早的「初始持仓」记录日期（没有则 null）。
 *
 * 初始持仓是"某时点的持仓快照"，**已经包含**了该时点之前的全部持仓。
 * 所以在这笔初始持仓**之前**日期再记一笔买入，就会与快照重复计算
 * （持仓凭空多出一份）。录入时用它做重复计算预警。
 */
export function initialPositionDate(transactions: Transaction[], fundId: string): string | null {
  const dates = transactions
    .filter((t) => t.fundId === fundId && t.note?.includes(INITIAL_POSITION_NOTE))
    .map((t) => t.date)
    .sort();
  return dates.length > 0 ? dates[0]! : null;
}
