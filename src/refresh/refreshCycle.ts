import type { FundRefreshIssue, IndexQuote, NavRecord, Transaction } from '../types';
import type { FetchFundResult } from '../api/fundApi';
import { mergeNavTail } from '../utils/navHistoryMerge';
import { confirmPendingTx } from '../utils/autoConfirm';
import { today } from '../utils/formatter';

/**
 * 一轮刷新的执行体——顺序写在函数体里，不在注释里。
 *
 * 背景：`App.tsx` 的 `refreshAll` 曾是个 ~180 行的闭包，三条顺序约束只以注释存在：
 *
 * 1. **指数必须先拉** —— 指数是全市场数据，与账户有没有持仓无关（空账户也要拉，
 *    否则新用户的 Dashboard 指数卡片永远是"—"）
 * 2. **自动确认必须在所有净值写入之后** —— 确认要用当天净值，用旧数据确认会算错份额
 * 3. **新鲜度基线必须在循环之后** —— 它读的就是净值历史，提前调用会看到旧数据
 *
 * 重排任何一个都不会报错，只会静默产出错误数字。所以这里把顺序做成**可测的代码**：
 * 注入假的 fetch，就能断言"确认发生在所有净值写入之后、基线记录发生在最后"。
 *
 * ⚠️ 与设计文档的一处偏差：`recordBaseline` 不带 `latestDateOf` 参数。
 * "最新净值日"的定义必须与盈亏数字同源（`latestNavPair` + 用户选的
 * `usQdiiFilterMode`），而 mode 与已见净值表都在 store 里——让 store 自己算，
 * 比把 mode 再搬一份到这个模块更不容易漂移。本模块只负责**顺序**。
 */
export interface RefreshOutcome {
  /** 本轮每只基金的失败原因（空对象 = 全部成功） */
  issues: Record<string, FundRefreshIssue>;
  /** 本轮拿到新净值的基金 id */
  freshFundIds: Set<string>;
  /** 本轮完成时间（ISO 字符串） */
  completedAt: string;
  /** 自动确认成功的待确认交易笔数 */
  confirmedCount: number;
}

export interface RefreshDeps {
  /** 本轮要刷新的基金 */
  fundIds: string[];
  /** 拉一只基金的净值与历史。返回判别联合，永不为 null */
  fetchFundNav: (fundId: string) => Promise<FetchFundResult>;
  /** 拉指数行情（全市场数据，与持仓无关） */
  fetchIndexQuotes: () => Promise<IndexQuote[]>;
  /** 该基金当前的净值历史 */
  navOf: (fundId: string) => NavRecord[];
  /** 待确认交易（确认步骤用） */
  pendingTransactions: () => Transaction[];
  /** 写入基金最新净值。false = 写盘失败 */
  commitFund: (fundId: string, nav: number, navDate: string) => boolean;
  /** 写入合并后的净值历史（派生数据，写失败不影响账本） */
  commitNavHistory: (fundId: string, records: NavRecord[]) => void;
  /** 写入一笔交易的补丁。false = 写盘失败 */
  commitTransaction: (id: string, patch: Partial<Transaction>) => boolean;
  /** 重算今日快照 */
  commitSnapshot: () => void;
  /** 记录新鲜度基线。返回本轮拿到新净值的基金 id */
  recordBaseline: () => Set<string>;
  /** 每只基金之间的间隔（毫秒）——避免连续打爆上游接口；测试传 0 */
  paceMs?: number;
  /** 本轮是否已被更新的一轮取代（superseded）——为真时立即中止 */
  isAborted?: () => boolean;
}

/** 本轮要做什么 */
export interface RefreshPlan {
  /** 拉指数行情 */
  runIndices: boolean;
  /** 拉基金净值 */
  runFundNavs: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 跑一轮刷新。
 *
 * 顺序（**不要重排**）：
 *   1. 指数          —— 全市场数据，与持仓无关
 *   2. 逐只基金：拉 → 写盘
 *   3. 确认待确认交易 —— 必须在所有净值写入之后
 *   4. 记录新鲜度基线 —— 必须在循环之后
 *   5. 今日快照
 */
export async function runRefreshCycle(
  deps: RefreshDeps,
  plan: RefreshPlan,
): Promise<RefreshOutcome> {
  const issues: Record<string, FundRefreshIssue> = {};
  const freshFundIds = new Set<string>();
  const aborted = deps.isAborted ?? (() => false);
  const paceMs = deps.paceMs ?? 0;

  const outcome = (confirmedCount = 0): RefreshOutcome => ({
    issues,
    freshFundIds,
    completedAt: new Date().toISOString(),
    confirmedCount,
  });

  // 什么都不做（idle）
  if (!plan.runIndices && !plan.runFundNavs) return outcome();

  // ── 1. 指数先拉 ─────────────────────────────────────────────────
  // 全市场数据，与账户有没有持仓无关 → 空账户也要拉，否则新用户
  // 的 Dashboard 指数卡片永远是"—"。放在基金循环之前，指数也能
  // 比基金净值更早显示。
  if (plan.runIndices) {
    await deps.fetchIndexQuotes();
  }
  if (aborted()) return outcome();

  // 退避档：只刷指数。**不做**确认 / 基线 / 快照——
  // 这一轮本来就没拿到新净值，确认与基线都没有依据。
  if (!plan.runFundNavs) return outcome();

  // ── 2. 逐只基金：拉 → 写盘 ─────────────────────────────────────
  for (let i = 0; i < deps.fundIds.length; i++) {
    if (aborted()) return outcome();
    const fundId = deps.fundIds[i]!;
    try {
      const result = await deps.fetchFundNav(fundId);
      if (aborted()) return outcome();
      if (!result.ok) {
        // new-format / not-found / network / timeout：跳过更新（防写错 NAV），上报原因
        issues[fundId] = { reason: result.reason, at: Date.now() };
      } else if (result.estimate.lastNav > 0) {
        deps.commitFund(fundId, result.estimate.lastNav, result.estimate.navDate);
        // 增量合并净值历史：mergeNavTail 与 FundList 手动刷新共用同一语义
        // （边界日期保留本地值；API 修正历史净值请走 Settings 的"重置净值历史"）
        const merged = mergeNavTail(deps.navOf(fundId), result.navHistory);
        if (merged) {
          deps.commitNavHistory(fundId, merged);
        }
      } else {
        // 加载成功但 trend 为空——此前静默跳过，现在上报让用户看到
        issues[fundId] = { reason: 'no-data', at: Date.now() };
      }
    } catch {
      issues[fundId] = { reason: 'network', at: Date.now() };
    }
    if (i < deps.fundIds.length - 1 && paceMs > 0) {
      await sleep(paceMs);
    }
  }
  if (aborted()) return outcome();

  // ── 3. 确认待确认交易（必须在所有净值写入之后）────────────────────
  // 确认口径只有一份（utils/autoConfirm.ts）：**只有交易当天的净值**能用来
  // 推算份额。查不到就继续等。
  const todayStr = today();
  let confirmedCount = 0;
  for (const tx of deps.pendingTransactions()) {
    if (tx.status !== 'pending') continue;
    // 当天与未来的待确认不动——T+1 净值还没发布，用户自己确认更稳
    if (tx.date >= todayStr) continue;
    const result = confirmPendingTx(tx, deps.navOf(tx.fundId));
    if (!result.ok) continue;
    // 写盘失败 → 不算数（内存与磁盘必须一致）
    if (!deps.commitTransaction(tx.id, result.patch)) continue;
    confirmedCount++;
  }
  if (aborted()) return outcome(confirmedCount);

  // ── 4. 记录新鲜度基线（必须在循环之后）──────────────────────────
  // freshness 读的就是净值历史，提前调用会看到旧数据。
  const fresh = deps.recordBaseline();
  for (const id of fresh) freshFundIds.add(id);
  if (aborted()) return outcome(confirmedCount);

  // ── 5. 今日快照：交易 / 净值变了要跟上，否则组合趋势图与账本不一致 ──
  deps.commitSnapshot();

  return outcome(confirmedCount);
}
