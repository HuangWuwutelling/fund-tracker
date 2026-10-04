import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import type { IndexQuote, Market } from '../types';

// 项目此前未引入 timezone 插件；这里 extend 后全仓库共享。
dayjs.extend(utc);
dayjs.extend(timezone);

const MARKET_TZ: Record<Market, string> = {
  CN: 'Asia/Shanghai',
  US: 'America/New_York',
};

/**
 * 把 API f86 时间戳（毫秒）格式化成该市场**当地**日历日 YYYY-MM-DD。
 *
 * CN 用 Asia/Shanghai，US 用 America/New_York。这样同一 timestamp 在两个市场下可以
 * 落在不同的日期上（例如 UTC 2026-10-04 04:00 = 美东 10-04 00:00 = 北京 10-04 12:00），
 * 各自的"数据日期"由该市场开盘日说了算，跟对方无关。
 */
export function formatIndexDate(timestampMs: number, market: Market): string {
  return dayjs(timestampMs).tz(MARKET_TZ[market]).format('YYYY-MM-DD');
}

/**
 * 决定 API 这次返回的数据要不要写进 cache。
 *
 * 规则就是字面的日期比较：`fetched.date > cached.date` 才写。理由（见设计文档 §3）：
 * API 不会给我们"今天是交易日吗 / 该不该刷新"的判定——但**它返回的日期**就是权威——
 * 同一日重复拉说明市场没动（休市 / 周末 / 已收盘），cache 留旧值即可；
 * 日期前进了说明有新数据，写入。
 *
 * 无 cache 永远 true（首次观测，区别于"已知 cache 但 fetch 拿到旧日期"）。
 * 这里**不**用 `fetchedAt` 参与判定——`fetchedAt` 只是 UI 显示用，不该影响 cache 内容。
 */
export function shouldUpdateIndexQuote(
  cached: IndexQuote | undefined,
  fetched: { date: string }
): boolean {
  if (!cached) return true;
  return fetched.date > cached.date;
}
