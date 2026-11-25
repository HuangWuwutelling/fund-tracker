import type { Transaction, TxOrigin } from '../types';

/**
 * 「初始持仓」记录的 note 标记——**历史遗留**。
 *
 * 新记录的来源由 `Transaction.origin` 表达，这个字符串只在**回填老数据**时
 * 用来推断来源（判定规则与旧实现一致，所以老数据的分类结果不变）。
 */
export const INITIAL_POSITION_NOTE = '初始持仓';

/**
 * 「平台流水导入」记录的 note 标记——**历史遗留**（同上）。
 *
 * 这类记录的金额/份额/净值**都是平台给的真值**，不是应用反算出来的，
 * 所以「交易自检」不参与核对（见 utils/txAudit.ts）。
 */
export const PLATFORM_IMPORT_NOTE = '平台流水导入';

/**
 * provenance（这笔交易从哪来）由**类型**表达，不再靠备注字符串匹配。
 *
 * 旧实现用 `note.includes('初始持仓')` 判断来源。后果：用户在备注里写
 * "初始持仓"两个字，这笔**手动**交易会被静默当成初始持仓——排除交易自检、
 * nav 被归一化成 0、还触发重复计算预警。规则靠子串匹配，用户无法回避。
 *
 * 现在：
 * - **新记录**从创建起就带 `origin`（初始持仓弹窗 / 平台流水导入 / 定投自动记录
 *   各写自己的来源；手动录入写 'manual'），备注回归自由文本
 * - **老数据**在 `loadFromStorage` / `importData` 时回填一次——判定规则与旧实现
 *   **完全一致**（同样的 `includes`），所以老数据的分类结果与今天一样，不会突变
 * - 回填之后，来源就**冻结**在 origin 里，备注再写什么都不影响
 */

/**
 * 从老数据推断来源。**只看 note / planId，不看 tx.origin**——
 * 它是"迁移与按名称重新分类"用的纯推断函数。
 *
 * 判定顺序与旧实现逐条对齐（平台流水 → 初始持仓 → 定投 → 手动）。
 */
export function detectOrigin(tx: Transaction): TxOrigin {
  if (tx.note?.includes(PLATFORM_IMPORT_NOTE)) return 'platform-import';
  if (tx.note?.includes(INITIAL_POSITION_NOTE)) return 'initial-position';
  if (tx.planId) return 'dca-auto';
  return 'manual';
}

/**
 * 消费端读来源：**有 origin 就用 origin**，没有（老数据）才推断一次。
 *
 * 回填之后所有记录都有 origin，备注里的字不再有任何含义。
 */
export function originOf(tx: Transaction): TxOrigin {
  return tx.origin ?? detectOrigin(tx);
}

/**
 * 给没有 origin 的记录补上来源。幂等（已有 origin 的不动）。
 *
 * 'manual' 不写——缺省就是 manual，写了只是噪音。
 * 保留 note 原值：最坏情况用户可以人工改回。
 *
 * 返回原数组引用表示"无变化"（调用方据此判断是否需要写盘）。
 */
export function backfillOrigin(transactions: Transaction[]): Transaction[] {
  let changed = false;
  const out = transactions.map((t) => {
    if (t.origin) return t;
    const origin = detectOrigin(t);
    if (origin === 'manual') return t;
    changed = true;
    return { ...t, origin };
  });
  return changed ? out : transactions;
}
