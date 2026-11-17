import type { NavRecord } from '../types';

/**
 * 增量合并远程净值尾部到本地历史（App 启动刷新 / FundList 手动刷新共用）。
 *
 * 背景：pingzhongdata 每次都返回全量历史（无增量接口），但本地写入只追加尾部，
 * 避免每次刷新都 JSON.stringify 全量历史重写 localStorage。此逻辑原先内联在
 * App.tsx，而 FundList 手动刷新走的是"全量覆盖"——两条路径语义不一致，
 * 手动刷新会覆盖本地（潜在的用户侧修正）。抽成纯函数统一口径。
 *
 * 语义（与原 App.tsx 内联版本一致）：
 * - 远程为空 → null（无需写入）
 * - 本地无历史（首次添加 / import 后清空）→ 全量写
 * - 尾部日期一致 → null（只更新 Fund 字段，navHistory 不动）
 * - 远程有更新 → [本地 + 严格晚于 localLatest 的远程尾部]；边界日期保留本地值
 *   （若 API 修正历史净值，用户可在 Settings 里点"重置净值历史"强制全量刷新）
 * - remoteLatest < localLatest（API 缓存陈旧）→ null（信任本地）
 */
export function mergeNavTail(local: NavRecord[], remote: NavRecord[]): NavRecord[] | null {
  if (remote.length === 0) return null;
  const localLatest = local[local.length - 1]?.date;
  const remoteLatest = remote[remote.length - 1]?.date;
  if (remoteLatest === undefined) return null;

  if (!localLatest) return remote;
  if (localLatest === remoteLatest) return null;
  if (localLatest > remoteLatest) return null;

  const tail = remote.filter((r) => r.date > localLatest);
  if (tail.length === 0) return null;
  return [...local, ...tail];
}
