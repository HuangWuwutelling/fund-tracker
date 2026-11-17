import { describe, it, expect } from 'vitest';
import { mergeNavTail } from './navHistoryMerge';
import type { NavRecord } from '../types';

function recs(...entries: Array<[string, number]>): NavRecord[] {
  return entries.map(([date, nav]) => ({ date, nav, accNav: nav }));
}

describe('mergeNavTail（增量合并净值尾部）', () => {
  it('远程为空 → null（无需写入）', () => {
    expect(mergeNavTail(recs(['2026-11-13', 2.15]), [])).toBeNull();
    expect(mergeNavTail([], [])).toBeNull();
  });

  it('本地无历史 → 返回远程全量（首次添加 / import 后清空）', () => {
    const remote = recs(['2026-11-12', 2.1], ['2026-11-13', 2.15]);
    expect(mergeNavTail([], remote)).toEqual(remote);
  });

  it('尾部日期一致 → null（只更新 Fund 字段，navHistory 不动）', () => {
    const local = recs(['2026-11-12', 2.1], ['2026-11-13', 2.15]);
    const remote = recs(['2026-11-10', 2.0], ['2026-11-11', 2.05], ['2026-11-12', 2.1], ['2026-11-13', 2.15]);
    expect(mergeNavTail(local, remote)).toBeNull();
  });

  it('远程有更新 → 只追加严格晚于 localLatest 的尾部，边界日期保留本地值', () => {
    // 11-14 双方都有但净值不同：边界保留本地 2.18（不覆盖），只追加 11-17
    const local = recs(['2026-11-13', 2.15], ['2026-11-14', 2.18]);
    const remote = recs(['2026-11-13', 2.15], ['2026-11-14', 2.1701], ['2026-11-17', 2.2]);
    expect(mergeNavTail(local, remote)).toEqual([
      { date: '2026-11-13', nav: 2.15, accNav: 2.15 },
      { date: '2026-11-14', nav: 2.18, accNav: 2.18 },
      { date: '2026-11-17', nav: 2.2, accNav: 2.2 },
    ]);
  });

  it('remoteLatest 更旧（API 缓存陈旧）→ null（信任本地）', () => {
    const local = recs(['2026-11-13', 2.15], ['2026-11-16', 2.18]);
    const remote = recs(['2026-11-12', 2.1], ['2026-11-13', 2.15]);
    expect(mergeNavTail(local, remote)).toBeNull();
  });

  it('remote 未按升序时按末元素语义处理（调用方须传升序数据）', () => {
    // mergeNavTail 以 remote 末元素为 remoteLatest——pingzhongdata 返回升序，
    // 本函数不负责排序。乱序输入下（末元素 11-13 < localLatest 11-16）信任本地返回 null
    const local = recs(['2026-11-16', 2.18]);
    const remote = recs(['2026-11-20', 2.2], ['2026-11-13', 2.15]);
    expect(mergeNavTail(local, remote)).toBeNull();
  });
});
