import { describe, it, expect } from 'vitest';
import { parseIndexTimestamp, shouldUpdateIndexQuote, etToBeijing } from './indexQuote';
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

describe('etToBeijing', () => {
  it('DST 期间（EDT, +12h）: 2026-10-02 17:15 → 2026-10-03 05:15', () => {
    // 10 月在 DST 区间内（3 月第 2 个周日 ~ 11 月第 1 个周日）
    expect(etToBeijing('2026-10-02', '17:15')).toEqual({
      date: '2026-10-03',
      time: '05:15',
    });
  });

  it('DST 期间跨午夜的边界: 2026-06-15 23:30 → 2026-06-16 11:30', () => {
    expect(etToBeijing('2026-06-15', '23:30')).toEqual({
      date: '2026-06-16',
      time: '11:30',
    });
  });

  it('标准时期间（EST, +13h）: 2026-01-15 16:00 → 2026-01-16 05:00', () => {
    // 1 月不在 DST 区间
    expect(etToBeijing('2026-01-15', '16:00')).toEqual({
      date: '2026-01-16',
      time: '05:00',
    });
  });

  it('标准时期间跨年: 2025-12-31 23:59 → 2026-01-01 12:59', () => {
    expect(etToBeijing('2025-12-31', '23:59')).toEqual({
      date: '2026-01-01',
      time: '12:59',
    });
  });

  it('DST 边界前一日（仍在 EST）: 2026-03-07 16:00 → 2026-03-08 05:00', () => {
    // 2026 年 DST 从 3 月 8 日（周日）开始 → 3 月 7 日还是 EST
    expect(etToBeijing('2026-03-07', '16:00')).toEqual({
      date: '2026-03-08',
      time: '05:00',
    });
  });

  it('DST 开始日（已切到 EDT, +12h）: 2026-03-08 16:00 → 2026-03-09 04:00', () => {
    // 3 月 8 日已经进入 DST → +12
    expect(etToBeijing('2026-03-08', '16:00')).toEqual({
      date: '2026-03-09',
      time: '04:00',
    });
  });

  it('DST 结束日（已切回 EST, +13h）: 2026-11-01 16:00 → 2026-11-02 05:00', () => {
    // 2026 年 DST 11 月 1 日结束 → 当日已是 EST
    expect(etToBeijing('2026-11-01', '16:00')).toEqual({
      date: '2026-11-02',
      time: '05:00',
    });
  });

  it('空 date → 空结果', () => {
    expect(etToBeijing('', '16:00')).toEqual({ date: '', time: '' });
  });

  it('空 time → 空结果', () => {
    expect(etToBeijing('2026-10-02', '')).toEqual({ date: '', time: '' });
  });

  it('非法格式 → 空结果（不抛）', () => {
    expect(etToBeijing('not-a-date', '16:00')).toEqual({ date: '', time: '' });
  });
});