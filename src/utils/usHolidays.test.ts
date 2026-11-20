import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { isUsHoliday, isUsTrackedQdii } from './usHolidays';

/**
 * 收集某年全部"工作日全天休市日"（周末由 getDay() 统一判休市，不在此列）。
 * 金标准比对：字典多一个、少一个、日期写错一个字符都会红。
 */
function weekdayHolidays(year: number): string[] {
  const out: string[] = [];
  const end = dayjs(`${year + 1}-01-01`);
  for (let d = dayjs(`${year}-01-01`); d.isBefore(end); d = d.add(1, 'day')) {
    const dow = d.day(); // 0 = 周日
    if (dow !== 0 && dow !== 6 && isUsHoliday(d.format('YYYY-MM-DD'))) {
      out.push(d.format('YYYY-MM-DD'));
    }
  }
  return out;
}

describe('isUsHoliday（NYSE / NASDAQ 全天休市日）', () => {
  it('2025 年 10 个全天休市日与 NYSE 日历一致', () => {
    expect(weekdayHolidays(2025)).toEqual([
      '2025-01-01', // New Year's Day
      '2025-01-20', // MLK Jr. Day
      '2025-02-17', // Presidents Day
      '2025-04-18', // Good Friday
      '2025-05-26', // Memorial Day
      '2025-06-19', // Juneteenth
      '2025-07-04', // Independence Day
      '2025-09-01', // Labor Day
      '2025-11-27', // Thanksgiving
      '2025-12-25', // Christmas
    ]);
  });

  it('2026 年 10 个全天休市日与 NYSE 日历一致（7/4 落周六 → 提前至 7/3 周五）', () => {
    expect(weekdayHolidays(2026)).toEqual([
      '2026-01-01',
      '2026-01-19',
      '2026-02-16',
      '2026-04-03',
      '2026-05-25',
      '2026-06-19',
      '2026-07-03', // Independence Day observed（7/4 Sat → 7/3 Fri）
      '2026-09-07',
      '2026-11-26',
      '2026-12-25',
    ]);
  });

  it('2027 年 10 个全天休市日与 NYSE 日历一致（6/19、7/4、12/25 各落周末 → observed 前移/顺延）', () => {
    expect(weekdayHolidays(2027)).toEqual([
      '2027-01-01',
      '2027-01-18',
      '2027-02-15',
      '2027-03-26',
      '2027-05-31',
      '2027-06-18', // Juneteenth observed（6/19 Sat → 6/18 Fri）
      '2027-07-05', // Independence Day observed（7/4 Sun → 7/5 Mon）
      '2027-09-06',
      '2027-11-25',
      '2027-12-24', // Christmas observed（12/25 Sat → 12/24 Fri）
    ]);
  });

  it('周末一律休市', () => {
    expect(isUsHoliday('2027-01-02')).toBe(true); // 周六
    expect(isUsHoliday('2027-01-03')).toBe(true); // 周日
  });

  it('普通工作日开市', () => {
    expect(isUsHoliday('2027-01-04')).toBe(false);
    expect(isUsHoliday('2027-03-25')).toBe(false); // Good Friday 前一天
    expect(isUsHoliday('2027-03-29')).toBe(false); // Good Friday 后一天
  });

  it('observed 规则：原始假日当天与相邻工作日的判定', () => {
    expect(isUsHoliday('2027-06-19')).toBe(true);  // 周六（原始 Juneteenth）
    expect(isUsHoliday('2027-06-18')).toBe(true);  // 周五（observed）
    expect(isUsHoliday('2027-06-21')).toBe(false); // 周一
    expect(isUsHoliday('2027-07-04')).toBe(true);  // 周日（原始 Independence Day）
    expect(isUsHoliday('2027-07-05')).toBe(true);  // 周一（observed）
    expect(isUsHoliday('2027-07-06')).toBe(false); // 周二
    expect(isUsHoliday('2027-12-25')).toBe(true);  // 周六（原始 Christmas）
    expect(isUsHoliday('2027-12-24')).toBe(true);  // 周五（observed）
    expect(isUsHoliday('2027-12-27')).toBe(false); // 周一
  });

  it('2028 未收录 → 退化为"仅按周末判定"', () => {
    expect(isUsHoliday('2028-01-01')).toBe(true);  // 周六
    expect(isUsHoliday('2028-07-04')).toBe(false); // 周二（未收录年份不判定节假日）
  });
});

describe('isUsTrackedQdii（美股跟踪 QDII 判定）', () => {
  it('识别中英文美股指数关键词', () => {
    expect(isUsTrackedQdii('华夏纳斯达克100ETF联接(QDII)')).toBe(true);
    expect(isUsTrackedQdii('广发纳斯达克100ETF联接(QDII)')).toBe(true);
    expect(isUsTrackedQdii('易方达标普信息科技指数(QDII)')).toBe(true);
    expect(isUsTrackedQdii('华夏恒生ETF联接(QDII)')).toBe(false);
  });

  it('非美股 QDII 不误判（港股 / 日股）', () => {
    expect(isUsTrackedQdii('华夏恒生科技ETF联接(QDII)')).toBe(false);
    expect(isUsTrackedQdii('华夏野村日经225ETF联接(QDII)')).toBe(false);
  });
});
