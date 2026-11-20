import { describe, it, expect } from 'vitest';
import { mergeNavTail, backfillAccNav } from './navHistoryMerge';
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

/* ============================================================
 *  真实累计净值回填（accNav）
 * ============================================================ */

describe('backfillAccNav（回填本地历史的真实累计净值）', () => {
  it('本地 acc≡nav（旧的假累计净值）+ 远程有真实 accNav → 回填', () => {
    const local = [
      { date: '2026-01-01', nav: 1.0, accNav: 1.0 },
      { date: '2026-01-02', nav: 0.9, accNav: 0.9 }, // 除息日，本地没有真实 acc
    ];
    const remote = [
      { date: '2026-01-01', nav: 1.0, accNav: 1.0 },
      { date: '2026-01-02', nav: 0.9, accNav: 1.1 }, // 真实累计净值：1.1
    ];
    const out = backfillAccNav(local, remote);
    expect(out[0]!.accNav).toBe(1.0);
    expect(out[1]!.accNav).toBe(1.1);
  });

  it('只改 accNav，不动本地 nav（本地 nav 可能是用户手工修正过的）', () => {
    const local = [{ date: '2026-01-01', nav: 1.23, accNav: 1.23 }];
    const remote = [{ date: '2026-01-01', nav: 1.0, accNav: 1.5 }];
    const out = backfillAccNav(local, remote);
    expect(out[0]!.nav).toBe(1.23);
    expect(out[0]!.accNav).toBe(1.5);
  });

  it('远程没有真实累计净值（全是 ≡ nav）→ 不回填', () => {
    const local = [{ date: '2026-01-01', nav: 1.0, accNav: 1.0 }];
    const remote = [{ date: '2026-01-01', nav: 1.0, accNav: 1.0 }];
    expect(backfillAccNav(local, remote)).toBe(local);
  });

  it('远程没有该日期 → 该条保持原值', () => {
    const local = [{ date: '2026-01-01', nav: 1.0, accNav: 1.0 }];
    const remote = [{ date: '2026-02-01', nav: 1.0, accNav: 1.5 }];
    const out = backfillAccNav(local, remote);
    expect(out[0]!.accNav).toBe(1.0);
  });

  it('无变化时返回原数组引用（调用方靠引用判断是否需要写盘）', () => {
    const local = [{ date: '2026-01-01', nav: 1.0, accNav: 1.0 }];
    const remote = [{ date: '2026-01-01', nav: 1.0, accNav: 1.0 }];
    expect(backfillAccNav(local, remote)).toBe(local);
  });
});

describe('mergeNavTail（回填 + 追加）', () => {
  it('尾部无新数据但本地 acc 需要回填 → 返回回填后的历史（不是 null）', () => {
    const local = [{ date: '2026-01-01', nav: 1.0, accNav: 1.0 }];
    const remote = [{ date: '2026-01-01', nav: 1.0, accNav: 1.4 }];
    const out = mergeNavTail(local, remote);
    expect(out).not.toBeNull();
    expect(out![0]!.accNav).toBe(1.4);
    expect(out!.length).toBe(1);
  });

  it('回填 + 追加尾部同时发生', () => {
    const local = [{ date: '2026-01-01', nav: 1.0, accNav: 1.0 }];
    const remote = [
      { date: '2026-01-01', nav: 1.0, accNav: 1.4 },
      { date: '2026-01-02', nav: 1.05, accNav: 1.45 },
    ];
    const out = mergeNavTail(local, remote);
    expect(out!.length).toBe(2);
    expect(out![0]!.accNav).toBe(1.4);
    expect(out![1]!.accNav).toBe(1.45);
  });

  it('远程没有真实累计净值 + 本地有真实累计净值 → 不追加尾部（避免制造假分红）', () => {
    const local = [{ date: '2026-01-01', nav: 1.0, accNav: 1.4 }];
    const remote = [
      { date: '2026-01-01', nav: 1.0, accNav: 1.0 },
      { date: '2026-01-02', nav: 1.05, accNav: 1.05 },
    ];
    expect(mergeNavTail(local, remote)).toBeNull();
  });

  it('两边都没有真实累计净值 → 正常追加（旧口径，行为不变）', () => {
    const local = [{ date: '2026-01-01', nav: 1.0, accNav: 1.0 }];
    const remote = [
      { date: '2026-01-01', nav: 1.0, accNav: 1.0 },
      { date: '2026-01-02', nav: 1.05, accNav: 1.05 },
    ];
    const out = mergeNavTail(local, remote);
    expect(out!.length).toBe(2);
  });
});
