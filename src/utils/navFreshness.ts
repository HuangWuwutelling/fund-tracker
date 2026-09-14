import type { Fund } from '../types';

/** fundId → 上次刷新时观测到的最新 NAV 归属日（YYYY-MM-DD） */
export type SeenNavMap = Record<string, string>;

/**
 * 判断某只基金"本次刷新是否拿到了新一期净值"。
 *
 * 用**观测法**而不是推算发布日：对照上次刷新时看到的最新 NAV 日，日期前进了就是有新数据。
 * 这样不需要知道基金类型、不需要知道它是 A 股还是 QDII、不需要知道它跟踪哪个市场——
 * 只要基金公司发布了新净值就一定能被观测到，没发布就一定观测不到。
 *
 *   - 无基线（首次观测 / 新添加的基金）：视为有新数据，避免首屏整块显示"待更新"
 *   - 完全没有 NAV：false（无数据 ≠ 有新数据）
 *
 * 注意这不影响盈亏数字本身——数字永远是最新一对 NAV 的涨跌。本函数只驱动
 * "本轮刷新有没有新东西"这一个 UI 提示。
 */
export function isNewlyPublished(
  previousSeen: string | undefined,
  latestNavDate: string | undefined
): boolean {
  if (!latestNavDate) return false;
  if (!previousSeen) return true;
  return latestNavDate > previousSeen;
}

/**
 * 对全部基金做一次新鲜度判定，同时算出"下次比较用"的基线。
 *
 * @param funds         当前基金列表（基线以它为准，已移除的基金会被剔除）
 * @param latestDateOf  取某只基金最新可用 NAV 的归属日（无则返回 undefined）
 * @param previousSeen  上次刷新保存的基线
 * @returns fresh       本次有新净值的 fundId 集合
 * @returns nextSeen    下次刷新写入的基线
 */
export function computeFreshness(
  funds: Fund[],
  latestDateOf: (fund: Fund) => string | undefined,
  previousSeen: SeenNavMap
): { fresh: Set<string>; nextSeen: SeenNavMap } {
  const fresh = new Set<string>();
  const nextSeen: SeenNavMap = {};

  for (const fund of funds) {
    const latest = latestDateOf(fund);
    // 拿不到 NAV 时保留旧基线——否则临时拉取失败会让下次刷新误报"有新净值"
    if (latest) nextSeen[fund.id] = latest;
    else if (previousSeen[fund.id]) nextSeen[fund.id] = previousSeen[fund.id]!;
    if (isNewlyPublished(previousSeen[fund.id], latest)) fresh.add(fund.id);
  }

  return { fresh, nextSeen };
}
