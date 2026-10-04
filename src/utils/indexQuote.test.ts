import { describe, it, expect } from 'vitest';
import { parseIndexTimestamp, shouldUpdateIndexQuote } from './indexQuote';
import type { IndexQuote } from '../types';

describe('parseIndexTimestamp', () => {
  it('CN 数字串 → 2026-09-30 + 16:14', () => {
    expect(parseIndexTimestamp('20260930161412')).toEqual({
      date: '2026-09-30',
      time: '16:14',
    });
  });

  it('US 带分隔符 → 2026-10-02 + 17:15', () => {
    expect(parseIndexTimestamp('2026-10-02 17:15:59')).toEqual({
      date: '2026-10-02',
      time: '17:15',
    });
  });

  it('只有 8 位数字 → date 正确 + time 空', () => {
    expect(parseIndexTimestamp('20261004')).toEqual({
      date: '2026-10-04',
      time: '',
    });
  });

  it('空字符串 → 两个都空', () => {
    expect(parseIndexTimestamp('')).toEqual({ date: '', time: '' });
  });

  it('长度 < 8 → 两个都空', () => {
    expect(parseIndexTimestamp('123')).toEqual({ date: '', time: '' });
  });
});

describe('shouldUpdateIndexQuote', () => {
  function q(date: string, market: 'CN' | 'US' = 'CN'): IndexQuote {
    return { name: 'x', market, value: 100, change: 1, changePercent: 1, date, time: '15:00', fetchedAt: 0 };
  }

  it('无 cache → 永远 true（首次观测）', () => {
    expect(shouldUpdateIndexQuote(undefined, { date: '2026-10-04' })).toBe(true);
  });

  it('fetched.date > cached.date → true（拿到新交易日）', () => {
    expect(shouldUpdateIndexQuote(q('2026-10-03'), { date: '2026-10-04' })).toBe(true);
  });

  it('fetched.date === cached.date → false（市场没动：休市 / 周末 / 已收盘）', () => {
    expect(shouldUpdateIndexQuote(q('2026-10-04'), { date: '2026-10-04' })).toBe(false);
  });

  it('fetched.date < cached.date → false（API 返回陈旧数据，信任 cache）', () => {
    expect(shouldUpdateIndexQuote(q('2026-10-04'), { date: '2026-10-03' })).toBe(false);
  });
});