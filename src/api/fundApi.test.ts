import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { pairNavWithAcc } from './fundApi';
import type { NavRecord } from '../types';

/** pingzhongdata 实测形状（2026-11，016452）：
 *  Data_netWorthTrend: [{x: ts, y: nav, equityReturn, unitMoney}, ...]
 *  Data_ACWorthTrend:  [[ts, accNav], ...]
 */
const DAY = 86400000;
// 期望日期用与实现相同的 dayjs 格式化推导——断言的是"配对/回退"逻辑，
// 不绑定时区（本地时区任何偏移下 expected/actual 一致）
const fmt = (ts: number) => dayjs(ts).format('YYYY-MM-DD');
const t0 = 1000 * DAY;
const d0 = fmt(t0);
const d1 = fmt(t0 + DAY);
const d2 = fmt(t0 + 2 * DAY);

describe('pairNavWithAcc（单位/累计净值按日期配对）', () => {
  it('分红日 accNav ≠ nav：取自 Data_ACWorthTrend 配对', () => {
    const trend = [
      { x: t0, y: 1.5 },
      { x: t0 + DAY, y: 1.2 }, // 分红除息日：单位净值跳水
      { x: t0 + 2 * DAY, y: 1.21 },
    ];
    const accTrend: Array<[number, number]> = [
      [t0, 1.5],
      [t0 + DAY, 1.5], // 累计净值不跳水
      [t0 + 2 * DAY, 1.51],
    ];
    expect(pairNavWithAcc(trend, accTrend)).toEqual<NavRecord[]>([
      { date: d0, nav: 1.5, accNav: 1.5 },
      { date: d1, nav: 1.2, accNav: 1.5 },
      { date: d2, nav: 1.21, accNav: 1.51 },
    ]);
  });

  it('acc 缺失的日期回退为 nav（旧行为兜底）', () => {
    const trend = [{ x: t0, y: 1.5 }, { x: t0 + DAY, y: 1.4 }];
    const accTrend: Array<[number, number]> = [[t0, 1.6]];
    const out = pairNavWithAcc(trend, accTrend);
    expect(out[0]).toEqual({ date: d0, nav: 1.5, accNav: 1.6 });
    expect(out[1]).toEqual({ date: d1, nav: 1.4, accNav: 1.4 });
  });

  it('acc 无数据 / undefined → 全部回退为 nav（与旧口径一致）', () => {
    const trend = [{ x: t0, y: 1.5 }];
    expect(pairNavWithAcc(trend, undefined)).toEqual<NavRecord[]>([
      { date: d0, nav: 1.5, accNav: 1.5 },
    ]);
    expect(pairNavWithAcc(trend, [])).toEqual<NavRecord[]>([
      { date: d0, nav: 1.5, accNav: 1.5 },
    ]);
  });

  it('非法 acc 条目（非数组 / 非数字 / ≤0）被忽略', () => {
    const trend = [{ x: t0, y: 1.5 }];
    const accTrend = [
      [t0, 0],        // ≤0
      [t0 + DAY, NaN], // NaN
      'bogus' as unknown as [number, number],
    ] as Array<[number, number]>;
    expect(pairNavWithAcc(trend, accTrend)).toEqual<NavRecord[]>([
      { date: d0, nav: 1.5, accNav: 1.5 },
    ]);
  });

  it('QDII 占位判定语义不变：占位行 nav+accNav 双同值原样透传', () => {
    // navPair 的 auto 过滤依赖"与前条 nav+accNav 完全相同"——配对后占位行
    // （nav 与 acc 都复制前日）仍保持双同值，过滤行为不受影响
    const trend = [
      { x: t0, y: 2.0 },
      { x: t0 + DAY, y: 2.0 }, // 占位行
    ];
    const accTrend: Array<[number, number]> = [
      [t0, 2.0],
      [t0 + DAY, 2.0],
    ];
    const out = pairNavWithAcc(trend, accTrend);
    expect(out[0]!.nav).toBe(out[1]!.nav);
    expect(out[0]!.accNav).toBe(out[1]!.accNav);
  });

  it('trend 为空 / undefined → 空数组', () => {
    expect(pairNavWithAcc(undefined, [[t0, 1.5]])).toEqual([]);
    expect(pairNavWithAcc([], undefined)).toEqual([]);
  });
});
