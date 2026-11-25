import { describe, it, expect } from 'vitest';
import { parseQuoteLine, parseKlineRows } from './indexApi';
import { TENCENT_QUOTE_CN, TENCENT_QUOTE_US } from '../test/fixtures/tencentQuotes';
import { TENCENT_KLINE_ROWS } from '../test/fixtures/tencentKline';

/**
 * 腾讯行情解析器的测试。
 *
 * `parseQuoteLine` 按**位置**取字段——值 [3]、时间戳 [30]、涨跌额 [31]、
 * 涨跌幅 [32]。这些偏移是接口格式的一部分：腾讯一旦改格式，解析器会
 * **静默**算错，界面上的指数点位看起来完全正常，数字却是错的。
 *
 * 所以测试用**真实响应样本**（2026-11-25 实抓）把偏移钉死。
 */
describe('parseQuoteLine（解析 v_X="..." 记录）', () => {
  it('A 股：从真实响应里取到值 / 涨跌额 / 涨跌幅', () => {
    const q = parseQuoteLine(TENCENT_QUOTE_CN);
    expect(q).not.toBeNull();
    expect(q!.value).toBe(3898.24);
    expect(q!.change).toBe(-65.58);
    expect(q!.changePercent).toBe(-1.65);
  });

  it('A 股：时间戳是 14 位数字串 → 日期 + 时分', () => {
    const q = parseQuoteLine(TENCENT_QUOTE_CN);
    // 原始时间戳字段是 20261125161409 → 日期 2026-11-25，时分 16:14
    // （时分的格式由 utils/indexQuote.ts 的 parseIndexTimestamp 决定，
    //   它只取 YYYY-MM-DD + HH:mm 两段，不做时区换算——见那里的注释）
    expect(q!.date).toBe('2026-11-25');
    expect(q!.rawTime).toBe('16:14');
  });

  it('美股：时间戳带分隔符（2026-11-24 17:15:59）也能解析', () => {
    const q = parseQuoteLine(TENCENT_QUOTE_US);
    expect(q).not.toBeNull();
    expect(q!.value).toBe(26214.17);
    expect(q!.change).toBe(-531.93);
    expect(q!.changePercent).toBe(-1.99);
    expect(q!.date).toBe('2026-11-24');
  });

  it('美股：字段数比 A 股少，但**位置**一样（值仍在 [3]、涨跌额仍在 [31]）', () => {
    // 两者的字段总数不同（88 vs 73），偏移却一样——这正是需要钉死的地方
    const cn = TENCENT_QUOTE_CN.split('"')[1]!.split('~');
    const us = TENCENT_QUOTE_US.split('"')[1]!.split('~');
    expect(cn.length).not.toBe(us.length);
    expect(cn[3]).toBe('3898.24');
    expect(us[3]).toBe('26214.17');
  });

  it('不是 v_ 开头的行 → null', () => {
    expect(parseQuoteLine('hello world')).toBeNull();
    expect(parseQuoteLine('v_sh000300="";')).toBeNull();
  });

  it('字段不足（被截断的响应）→ null，不返回半截数据', () => {
    expect(parseQuoteLine('v_sh000300="1~沪深300~000300~3898.24";')).toBeNull();
  });

  it('数值字段不是有限数 → null', () => {
    const broken = 'v_sh000300="1~x~000300~abc~' + '~'.repeat(26) + '~20261125161409~-65.58~-1.65";';
    expect(parseQuoteLine(broken)).toBeNull();
  });
});

describe('parseKlineRows（K 线 day 数组 → [date, close]）', () => {
  it('从真实响应里取出 date + close', () => {
    const records = parseKlineRows(TENCENT_KLINE_ROWS);
    expect(records).toHaveLength(5);
    expect(records[0]!.date).toBe('2026-11-19');
    expect(records[0]!.value).toBeCloseTo(3984.84, 6);
  });

  it('close 取的是第 3 个字段（index 2），不是 open（第 2 个）', () => {
    // open=3972.430, close=3984.840 —— 取错字段会得到一个"看起来合理"的错数
    const records = parseKlineRows(TENCENT_KLINE_ROWS);
    expect(records[0]!.value).not.toBeCloseTo(3972.43, 6);
  });

  it('不是数组 → 空', () => {
    expect(parseKlineRows(null)).toEqual([]);
    expect(parseKlineRows(undefined)).toEqual([]);
    expect(parseKlineRows('nope')).toEqual([]);
  });

  it('非法行被丢弃（日期不是字符串 / close 不是数字 / 长度不足 / 不是数组）', () => {
    const rows = [
      ['2026-11-19', '3972.430', '3984.840', '3995.550', '3937.750', '163357787.000'],
      [20261119, '1', '2', '3', '4', '5'], // 日期不是字符串
      ['2026-11-20', '1', 'not-a-number', '3', '4', '5'], // close 不是数字
      ['2026-11-21', '1'], // 长度不足
      'not-a-row', // 不是数组
    ];
    expect(parseKlineRows(rows)).toEqual([{ date: '2026-11-19', value: 3984.84 }]);
  });

  it('日期格式本身**不校验**（只要是字符串就收下）', () => {
    // 真实行为：解析器只判类型，不判 YYYY-MM-DD 格式。K 线接口始终返回规范日期，
    // 所以这里不构成风险——但把它写进测试，免得有人误以为解析器会兜住格式错误。
    expect(parseKlineRows([['bad-date', '1', '2']])).toEqual([{ date: 'bad-date', value: 2 }]);
  });

  it('空数组 → 空', () => {
    expect(parseKlineRows([])).toEqual([]);
  });
});
