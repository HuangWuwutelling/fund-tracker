import { describe, it, expect } from 'vitest';
import { computeFreshness, isNewlyPublished } from './navFreshness';
import { latestNavPair, type UsQdiiFilterMode } from './navPair';
import type { Fund, NavRecord } from '../types';

function fund(id: string): Fund {
  return { id, name: `基金${id}`, platformId: 'p1', type: 'index', currentNav: 1, navDate: '' };
}

describe('isNewlyPublished', () => {
  it('NAV 日前进 → true', () => {
    expect(isNewlyPublished('2026-09-10', '2026-09-11')).toBe(true);
  });

  it('NAV 日不变 → false', () => {
    expect(isNewlyPublished('2026-09-11', '2026-09-11')).toBe(false);
  });

  it('无基线（首次观测 / 新添加的基金）→ true', () => {
    expect(isNewlyPublished(undefined, '2026-09-11')).toBe(true);
  });

  it('完全没有 NAV → false（哪怕无基线）', () => {
    expect(isNewlyPublished('2026-09-10', undefined)).toBe(false);
    expect(isNewlyPublished(undefined, undefined)).toBe(false);
  });
});

describe('computeFreshness', () => {
  it('NAV 日前进的基金进 fresh，基线被更新', () => {
    const funds = [fund('a'), fund('b')];
    const latest: Record<string, string> = { a: '2026-09-14', b: '2026-09-11' };
    const { fresh, nextSeen } = computeFreshness(funds, (f) => latest[f.id], {
      a: '2026-09-11',
      b: '2026-09-11',
    });
    expect([...fresh]).toEqual(['a']);
    expect(nextSeen).toEqual({ a: '2026-09-14', b: '2026-09-11' });
  });

  it('首次观测（无任何基线）全部视为 fresh', () => {
    const { fresh, nextSeen } = computeFreshness([fund('a')], () => '2026-09-14', {});
    expect([...fresh]).toEqual(['a']);
    expect(nextSeen).toEqual({ a: '2026-09-14' });
  });

  it('拿不到 NAV 的基金不 fresh，且旧基线被保留', () => {
    const { fresh, nextSeen } = computeFreshness([fund('a')], () => undefined, { a: '2026-09-11' });
    expect(fresh.size).toBe(0);
    expect(nextSeen).toEqual({ a: '2026-09-11' });
  });

  it('已移除的基金从基线中剔除', () => {
    const { nextSeen } = computeFreshness([], () => undefined, { gone: '2026-09-11' });
    expect(nextSeen).toEqual({});
  });
});

/**
 * `recordNavFreshness` 在 store 里把"最新 NAV 日"与 `latestNavPair(fund, history, mode)`
 * 绑死——本组测试是那个接线方式的端到端合约：
 * `computeFreshness` 拿到的 `latestDateOf` 必须随模式变化返回不同的"最新日"，
 * 否则 fresh 集合的判定和盈亏数字就会和用户选的模式不一致。
 *
 * 测试场景：美股跟踪 QDII 末尾被数据源补一条"占位条目"（nav+accNav 与前条全等）。
 */
describe('computeFreshness × latestNavPair 模式接线（store recordNavFreshness 用的）', () => {
  // 一只跟踪纳斯达克 100 的 QDII
  const qdii: Fund = {
    id: '159941',
    name: '广发纳指 100ETF',
    platformId: 'p1',
    type: 'qdii',
    currentNav: 1.5,
    navDate: '2026-09-11',
  };
  // 9/9 真实、9/10 真实、9/11 数据源补的占位（与 9/10 全等）。
  // 3 条保证 auto 模式过滤后仍剩 2 条，latestNavPair 才能返回非 null 的 curr。
  const history: NavRecord[] = [
    { date: '2026-09-09', nav: 1.48, accNav: 1.78 },
    { date: '2026-09-10', nav: 1.50, accNav: 1.80 },
    { date: '2026-09-11', nav: 1.50, accNav: 1.80 }, // 占位：与 9/10 全等
  ];
  // 与 store 一致的回调：取最新可用 NAV 的归属日
  const latestDateOf = (mode: UsQdiiFilterMode) => (f: Fund) =>
    latestNavPair(f, history, mode)?.curr.date;

  it('auto 模式：跳过占位 → 最新日是 9/10', () => {
    const { nextSeen } = computeFreshness([qdii], latestDateOf('auto'), {});
    expect(nextSeen[qdii.id]).toBe('2026-09-10');
  });

  it('off 模式：占位保留 → 最新日是 9/11（与 auto 区分）', () => {
    const { nextSeen } = computeFreshness([qdii], latestDateOf('off'), {});
    expect(nextSeen[qdii.id]).toBe('2026-09-11');
  });

  it('切换模式后基线对比语义应一致：off 报 9/11 新增，auto 视为没新东西', () => {
    // 模拟上一轮用 off 模式跑过、基线是 9/10；本轮切到 auto
    // 9/11 是占位，auto 看到的"最新"也是 9/10 → 不应再算 fresh
    const { fresh } = computeFreshness([qdii], latestDateOf('auto'), { [qdii.id]: '2026-09-10' });
    expect(fresh.has(qdii.id)).toBe(false);
  });

  it('A 股基金：三种模式都返回原始最新日（QDII 过滤不适用）', () => {
    const aShare: Fund = { ...qdii, name: '沪深 300ETF', type: 'index' };
    const aHistory: NavRecord[] = [
      { date: '2026-09-10', nav: 4.0, accNav: 5.0 },
      { date: '2026-09-11', nav: 4.0, accNav: 5.0 },
    ];
    const cb = (mode: UsQdiiFilterMode) => (_f: Fund) =>
      latestNavPair(aShare, aHistory, mode)?.curr.date;
    expect(cb('auto')({ ...aShare })).toBe('2026-09-11');
    expect(cb('strict')({ ...aShare })).toBe('2026-09-11');
    expect(cb('off')({ ...aShare })).toBe('2026-09-11');
  });
});
