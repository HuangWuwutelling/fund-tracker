import type { NavRecord } from '../types';

/**
 * 回填本地历史的**真实累计净值**（accNav）。
 *
 * 背景（2026-11-20 修正）：2026-11-17 之前抓取的净值历史里 `accNav` 是写死的
 * 假值（恒等于 nav），所以 `buildAdjustedSeries()` 靠 `accNav − nav` 的跳变
 * 检测分红时，老数据段**永远检测不到任何分红**——分红复权对历史区间无效。
 *
 * 而 pingzhongdata 现在提供真实累计净值，且每次都返回**全量**历史——所以只要
 * 远程数据里出现过 `accNav ≠ nav`（说明上游确实在给真实累计净值），就可以把
 * 本地历史对应日期的 accNav 一并回填，老数据无须"重置净值历史"重拉。
 *
 * 只改 accNav，**不动 nav**——本地 nav 可能是用户手工修正过的，边界日期保留
 * 本地值这条既有语义不变。
 *
 * 返回原数组引用表示"无变化"（调用方据此判断是否需要写盘）。
 */
export function backfillAccNav(local: NavRecord[], remote: NavRecord[]): NavRecord[] {
  if (local.length === 0 || remote.length === 0) return local;
  // 上游没给真实累计净值（全是 ≡ nav）→ 无可回填
  if (!remote.some((r) => r.accNav !== r.nav)) return local;
  const byDate = new Map(remote.map((r) => [r.date, r.accNav]));
  let changed = false;
  const out = local.map((r) => {
    const acc = byDate.get(r.date);
    if (acc === undefined || acc === r.accNav) return r;
    changed = true;
    return { ...r, accNav: acc };
  });
  return changed ? out : local;
}

/**
 * 增量合并远程净值尾部到本地历史（App 启动刷新 / FundList 手动刷新共用）。
 *
 * 背景：pingzhongdata 每次都返回全量历史（无增量接口），但本地写入只追加尾部，
 * 避免每次刷新都 JSON.stringify 全量历史重写 localStorage。此逻辑原先内联在
 * App.tsx，而 FundList 手动刷新走的是"全量覆盖"——两条路径语义不一致，
 * 手动刷新会覆盖本地（潜在的用户侧修正）。抽成纯函数统一口径。
 *
 * 语义：
 * - 远程为空 → null（无需写入）
 * - 本地无历史（首次添加 / import 后清空）→ 全量写
 * - 尾部日期一致 → null（只更新 Fund 字段，navHistory 不动）
 * - 远程有更新 → [本地 + 严格晚于 localLatest 的远程尾部]；边界日期保留本地值
 *   （若 API 修正历史净值，用户可在 Settings 里点"重置净值历史"强制全量刷新）
 * - remoteLatest < localLatest（API 缓存陈旧）→ null（信任本地）
 *
 * 累计净值口径（2026-11-20 新增）：本地与远程的 acc 必须**同源**——都有真实
 * 累计净值，或都没有。混用会在拼接处制造一次假分红（gap 从 0 跳到 D），
 * 静默污染 MA250 / MACD / 回撤百分位，所以远程缺真实 acc 而本地有时整轮跳过。
 */
export function mergeNavTail(local: NavRecord[], remote: NavRecord[]): NavRecord[] | null {
  if (remote.length === 0) return null;
  const localLatest = local[local.length - 1]?.date;
  const remoteLatest = remote[remote.length - 1]?.date;
  if (remoteLatest === undefined) return null;

  const remoteHasRealAcc = remote.some((r) => r.accNav !== r.nav);
  const localHasRealAcc = local.some((r) => r.accNav !== r.nav);
  if (localHasRealAcc && !remoteHasRealAcc) {
    console.warn(
      '[navHistoryMerge] 远程数据缺少真实累计净值，跳过本次合并（避免在拼接处制造假分红）',
    );
    return null;
  }

  // 回填本地历史的真实累计净值（老数据 acc≡nav → 分红复权失效）
  const base = backfillAccNav(local, remote);
  const accChanged = base !== local;

  if (!localLatest) return remote;
  if (localLatest === remoteLatest) return accChanged ? base : null;
  if (localLatest > remoteLatest) return accChanged ? base : null;

  const tail = remote.filter((r) => r.date > localLatest);
  if (tail.length === 0) return accChanged ? base : null;
  return [...base, ...tail];
}
