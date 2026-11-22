import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildNavIndex,
  exactNavOn,
  navOnOrBefore,
  hasRealAcc,
  getNavIndex,
  putNavHistory,
  invalidateNavHistory,
} from './navSeries';
import { installFakeStorage, type FakeStorage } from '../test/fakeStorage';
import type { NavRecord } from '../types';

let fake: FakeStorage;

beforeEach(() => {
  fake = installFakeStorage();
  invalidateNavHistory();
});

function nav(date: string, n: number, acc = n): NavRecord {
  return { date, nav: n, accNav: acc };
}

describe('navSeries —— 查表语义（"哪条净值可以拿来推算份额"）', () => {
  it('exactNavOn：只认日期**恰好**等于查询日的那条', () => {
    const idx = buildNavIndex([nav('2026-08-06', 1.0386), nav('2026-08-26', 1.048)]);
    expect(exactNavOn(idx, '2026-08-26')?.nav).toBe(1.048);
  });

  it('exactNavOn：没有当天的记录 → null（**绝不**回退到前一条）', () => {
    const idx = buildNavIndex([nav('2026-08-06', 1.0386), nav('2026-08-26', 1.048)]);
    // 这正是 2026-08-26 买入事故的形状：查 08-26 却拿到了 08-06 的旧净值
    expect(exactNavOn(idx, '2026-08-20')).toBeNull();
  });

  it('navOnOrBefore：回退到 ≤ 查询日的最近一条', () => {
    const idx = buildNavIndex([nav('2026-08-06', 1.0386), nav('2026-08-26', 1.048)]);
    expect(navOnOrBefore(idx, '2026-08-20')?.nav).toBe(1.0386);
  });

  it('navOnOrBefore：返回的 date 是**那条净值自己的日期**，不是查询日', () => {
    const idx = buildNavIndex([nav('2026-08-06', 1.0386), nav('2026-08-26', 1.048)]);
    // 调用方必须能看出"这不是当天的净值"——否则就会拿它推算份额
    expect(navOnOrBefore(idx, '2026-08-20')?.date).toBe('2026-08-06');
  });

  it('navOnOrBefore：查询日之后的记录不得被返回', () => {
    const idx = buildNavIndex([nav('2026-08-06', 1.0386), nav('2026-08-26', 1.048)]);
    expect(navOnOrBefore(idx, '2026-08-01')).toBeNull();
  });

  it('记录乱序时也能正确查（建索引时排一次序）', () => {
    const idx = buildNavIndex([nav('2026-08-26', 1.048), nav('2026-08-06', 1.0386)]);
    expect(exactNavOn(idx, '2026-08-26')?.nav).toBe(1.048);
    expect(navOnOrBefore(idx, '2026-08-20')?.date).toBe('2026-08-06');
  });

  it('hasRealAcc：acc ≡ nav → false；出现真实累计净值 → true', () => {
    expect(hasRealAcc([nav('2026-08-06', 1.0)])).toBe(false);
    expect(hasRealAcc([nav('2026-08-06', 1.0, 1.5)])).toBe(true);
  });
});

describe('navSeries —— 缓存（净值序列的唯一读路径）', () => {
  it('第一次读 → 落盘数据', () => {
    fake.setItem('fund-tracker:nav:f1', JSON.stringify([nav('2026-08-26', 1.048)]));
    expect(exactNavOn(getNavIndex('f1'), '2026-08-26')?.nav).toBe(1.048);
  });

  it('命中缓存时不再读 localStorage', () => {
    putNavHistory('f1', [nav('2026-08-06', 1.0386)]);
    const before = fake.getItemCalls;
    getNavIndex('f1');
    expect(fake.getItemCalls).toBe(before);
  });

  it('缓存命中 → 拿到的是同一个索引对象（不再重复建索引）', () => {
    putNavHistory('f1', [nav('2026-08-06', 1.0386)]);
    const first = getNavIndex('f1');
    // 绕过写入接口直接改盘——缓存不该被绕过
    fake.setItem('fund-tracker:nav:f1', JSON.stringify([nav('2026-08-26', 9.9)]));
    const second = getNavIndex('f1');
    expect(second).toBe(first);
    expect(exactNavOn(second, '2026-08-06')?.nav).toBe(1.0386);
  });

  it('putNavHistory → 缓存与落盘同时更新', () => {
    putNavHistory('f1', [nav('2026-08-26', 1.048)]);
    expect(fake.getItem('fund-tracker:nav:f1')).toContain('2026-08-26');
    expect(exactNavOn(getNavIndex('f1'), '2026-08-26')?.nav).toBe(1.048);
  });

  it('invalidateNavHistory → 下次读重新从落盘取（重置净值历史 / 导入 / 跨标签页同步后）', () => {
    putNavHistory('f1', [nav('2026-08-06', 1.0386)]);
    fake.setItem('fund-tracker:nav:f1', JSON.stringify([nav('2026-08-26', 1.048)]));
    invalidateNavHistory('f1');
    expect(exactNavOn(getNavIndex('f1'), '2026-08-26')?.nav).toBe(1.048);
  });

  it('invalidateNavHistory() 不带参数 → 清空全部', () => {
    putNavHistory('f1', [nav('2026-08-06', 1.0386)]);
    putNavHistory('f2', [nav('2026-08-06', 1.0386)]);
    invalidateNavHistory();
    fake.setItem('fund-tracker:nav:f1', JSON.stringify([nav('2026-08-26', 1.048)]));
    // 清空后 f1 应当重新读盘 → 拿到新值
    expect(exactNavOn(getNavIndex('f1'), '2026-08-26')?.nav).toBe(1.048);
  });
});
