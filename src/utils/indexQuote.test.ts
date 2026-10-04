import { describe, it, expect } from 'vitest';
import { formatIndexDate, shouldUpdateIndexQuote } from './indexQuote';
import type { IndexQuote } from '../types';

describe('formatIndexDate', () => {
  it('CN: UTC 2026-10-04 01:30 = 北京 09:30 → 2026-10-04', () => {
    const ts = Date.UTC(2026, 9, 4, 1, 30, 0);
    expect(formatIndexDate(ts, 'CN')).toBe('2026-10-04');
  });

  it('CN: UTC 2026-10-04 15:59 = 北京 23:59 → 2026-10-04', () => {
    const ts = Date.UTC(2026, 9, 4, 15, 59, 0);
    expect(formatIndexDate(ts, 'CN')).toBe('2026-10-04');
  });

  it('CN: UTC 2026-10-04 16:00 = 北京 次日 00:00 → 2026-10-05', () => {
    const ts = Date.UTC(2026, 9, 4, 16, 0, 0);
    expect(formatIndexDate(ts, 'CN')).toBe('2026-10-05');
  });

  it('US: UTC 2026-10-03 13:30 = 美东 09:30 (EDT) → 2026-10-03', () => {
    // 十月美东是 EDT (UTC-4)
    const ts = Date.UTC(2026, 9, 3, 13, 30, 0);
    expect(formatIndexDate(ts, 'US')).toBe('2026-10-03');
  });

  it('US: UTC 2026-01-05 14:30 = 美东 09:30 (EST) → 2026-01-05', () => {
    // 一月美东是 EST (UTC-5)；同样的本地时间，时区偏移不同
    const ts = Date.UTC(2026, 0, 5, 14, 30, 0);
    expect(formatIndexDate(ts, 'US')).toBe('2026-01-05');
  });

  it('US: UTC 2026-10-04 04:00 = 美东 00:00 → 2026-10-04', () => {
    // 跨日的边界 —— 这是关键 case：相同 timestamp 在 CN/US 下必须得到**不同**日期
    const ts = Date.UTC(2026, 9, 4, 4, 0, 0);
    expect(formatIndexDate(ts, 'US')).toBe('2026-10-04');
    expect(formatIndexDate(ts, 'CN')).toBe('2026-10-04'); // Beijing 12:00，同日
  });
});

describe('shouldUpdateIndexQuote', () => {
  function q(date: string, market: 'CN' | 'US' = 'CN'): IndexQuote {
    return { name: 'x', market, value: 100, change: 1, changePercent: 1, date, fetchedAt: 0 };
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
