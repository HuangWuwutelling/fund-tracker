import { describe, it, expect } from 'vitest';
import {
  parseIndexTimestamp,
  shouldUpdateIndexQuote,
  shouldRefreshIndexHistory,
  etToBeijing,
} from './indexQuote';
import type { IndexQuote, IndexHistoryRecord } from '../types';

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

describe('shouldRefreshIndexHistory', () => {
  // 兜底分支：quote 缺位时按"cache 多大"刷新。cn-holiday / quote-fetch-fail 等
  // 异常下 quote.date 可能是空串 / undefined —— 不该影响 history 必须刷新。
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  function history(dates: string[]): IndexHistoryRecord[] {
    return dates.map((date) => ({ date, value: 100 }));
  }
  // 固定 now = 2026-10-07 12:00 local；测试时区差异不影响纯字符串日期比较
  const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();

  it('无 cache → true（首次拉取）', () => {
    expect(shouldRefreshIndexHistory(undefined, '2026-10-07')).toBe(true);
  });

  it('空 cache → true（首次拉取）', () => {
    expect(shouldRefreshIndexHistory([], '2026-10-07')).toBe(true);
  });

  // 主路径：quote 已经前进了 → history 必须跟上。
  // 这是用户 2026-10-07 报告的 bug：cache 截止 2026-10-05，quote 已到 2026-10-07，
  // 旧逻辑按 7 天判断不刷新，导致 modal 显示陈旧曲线。
  it('quote 日期 > cache 最后日期 → true（NASDAQ 100 那条 bug）', () => {
    expect(shouldRefreshIndexHistory(history(['2026-10-05']), '2026-10-07')).toBe(true);
  });

  it('quote 日期比 cache 早 1 天 → true（保持主路径优先）', () => {
    expect(shouldRefreshIndexHistory(history(['2026-10-06']), '2026-10-07')).toBe(true);
  });

  it('quote 日期 === cache 最后日期 → false（已对齐）', () => {
    expect(shouldRefreshIndexHistory(history(['2026-10-07']), '2026-10-07')).toBe(false);
  });

  it('quote 日期 < cache 最后日期 → false（cache 反而更近，理论不该发生但保险）', () => {
    expect(shouldRefreshIndexHistory(history(['2026-10-07']), '2026-10-05')).toBe(false);
  });

  // 兜底：quote 不可用（quote 还没拉到 / quote fetch 失败）时按时间判断。
  // 旧逻辑用的 7 天阈值是这路径的来源，新逻辑保留同样的兜底语义。
  it('无 quote + cache 2 天前 → false（兜底没到）', () => {
    expect(shouldRefreshIndexHistory(history(['2026-10-05']), undefined, NOW)).toBe(false);
  });

  it('无 quote + cache 8 天前 → true（兜底）', () => {
    expect(shouldRefreshIndexHistory(history(['2026-09-29']), undefined, NOW)).toBe(true);
  });

  // 边界：严格大于 7*24h 才算 stale（与旧逻辑一致）
  it('无 quote + cache 恰好 7 天 → false', () => {
    // Sep 30 + 7 * 24h = Oct 7 00:00（恰好 7 天整）。strict `>` 不触发。
    const now = new Date('2026-09-30').getTime() + SEVEN_DAYS_MS;
    expect(shouldRefreshIndexHistory(history(['2026-09-30']), undefined, now)).toBe(false);
  });

  it('无 quote + cache 7 天零 1 毫秒 → true', () => {
    const now = new Date('2026-09-30').getTime() + SEVEN_DAYS_MS + 1;
    expect(shouldRefreshIndexHistory(history(['2026-09-30']), undefined, now)).toBe(true);
  });

  // quote 为空字符串（quote 拉取失败的标记，indices[code] 里见过）也算"无 quote"
  it('quote 是空字符串 + cache 2 天前 → false', () => {
    expect(shouldRefreshIndexHistory(history(['2026-10-05']), '', NOW)).toBe(false);
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