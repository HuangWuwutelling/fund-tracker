import dayjs from 'dayjs';
import type { Fund } from '../types';
import { isNonTradingDay } from './chineseHolidays';

/**
 * 在 `date` 基础上加 N 个交易日（跳过周末和法定节假日）。
 * QDII 跨国庆/春节的发布日归属能精确落在实际工作日，而非假期中段。
 */
export function addTradingDays(date: string, days: number): string {
  let d = dayjs(date);
  let added = 0;
  while (added < days) {
    d = d.add(1, 'day');
    if (!isNonTradingDay(d.format('YYYY-MM-DD'))) added++;
  }
  return d.format('YYYY-MM-DD');
}

/**
 * 收益归属日 / 净值发布日：
 * - A 股/债券/指数/混合：发布日 = NAV 日（T+0）
 * - QDII：发布日 = NAV 日 + 2 交易日（T+2，跳过周末）
 *
 * 例：QDII 8/27（Thu）NAV → 8/31（Mon）；QDII 8/28（Fri）NAV → 9/1（Tue）。
 * 这样 QDII 的"8/27→8/26 NAV 变化"在 8/31 那天发布，与基金公司的"实际发布日"对齐。
 *
 * 用法：
 * - 当日盈亏判定（calcDailyPnl）：find publishDate === today
 * - 历史格归属（reportGenerator）：navDate 归属（"准确日期"），不用这个
 */
export function getPublishDate(fund: Fund, navDate: string): string {
  return fund.type === 'qdii' ? addTradingDays(navDate, 2) : navDate;
}