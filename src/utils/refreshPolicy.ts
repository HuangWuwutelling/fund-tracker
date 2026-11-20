/**
 * 定时 tick 的刷新决策（纯函数，供 App.tsx 使用）。
 *
 * 背景：App 的 30 分钟 tick 只在"有基金的最新净值日早于今天"时才发请求，
 * 以免无谓消耗 API 配额。为了不让**永久失效**的基金（如 pingzhongdata 换成
 * 新格式后被跳过的那些）每 30 分钟空轮询一次，加了退避：stale 集合与上轮
 * 完全相同就隔次跳过，连跳 3 次后强制跑一次（给数据源自愈留窗口）。
 *
 * ⚠️ 指数行情**必须独立于这个退避**：指数点位与基金净值没有依赖关系，
 * 曾经指数拉取被包在 refreshAll 里，退避时整条链路一起被跳过，
 * 导致 Dashboard 的指数点位从每 30 分钟退化到 ~2 小时一次。
 * 所以决策的返回值不是布尔，而是"做什么"：
 * - `idle`         无 stale 基金 → 什么都不做
 * - `indices-only` 基金净值退避，但指数行情照刷
 * - `full`         完整刷新（基金净值 + 指数行情）
 */

/** 连续退避多少个 tick 后强制跑一次完整刷新 */
export const MAX_SKIPPED_TICKS = 3;

export type TickAction = 'idle' | 'indices-only' | 'full';

/**
 * 决定这一轮 tick 该做什么。
 *
 * @param staleIds    本轮"净值日早于今天"的基金 id 集合
 * @param lastStaleIds 上一轮的同一集合（null = 上轮没有 stale 基金）
 * @param skippedCount 已经连续退避了多少个 tick
 */
export function decideTickAction(
  staleIds: ReadonlySet<string>,
  lastStaleIds: ReadonlySet<string> | null,
  skippedCount: number,
): TickAction {
  if (staleIds.size === 0) return 'idle';
  if (lastStaleIds === null) return 'full';
  const unchanged =
    lastStaleIds.size === staleIds.size &&
    [...staleIds].every((id) => lastStaleIds.has(id));
  if (unchanged && skippedCount < MAX_SKIPPED_TICKS) return 'indices-only';
  return 'full';
}
