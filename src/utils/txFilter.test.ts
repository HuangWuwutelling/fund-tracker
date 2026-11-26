import { describe, it, expect } from 'vitest';
import {
  parseTxFilters,
  filterTransactions,
  txFilterParams,
  isRealDate,
  type TxFilters,
} from './txFilter';
import { calcDividendTotal, calcTodayInvested, dividendValue } from './calculator';
import type { Transaction } from '../types';

const KNOWN_FUNDS = ['160140', '008163'];

function mkTx(over: Partial<Transaction> & { id: string }): Transaction {
  return {
    fundId: '160140',
    type: 'buy',
    date: '2026-11-26',
    amount: 1000,
    fee: 0,
    shares: 100,
    nav: 1,
    ...over,
  };
}

function params(q: string): URLSearchParams {
  return new URLSearchParams(q);
}

describe('isRealDate —— 日历合法性必须用往返判定', () => {
  it('合法日期通过', () => {
    expect(isRealDate('2026-11-26')).toBe(true);
    expect(isRealDate('2024-02-29')).toBe(true); // 闰年
  });

  it('形状不对的直接拒绝', () => {
    expect(isRealDate('abc')).toBe(false);
    expect(isRealDate('')).toBe(false);
    expect(isRealDate('2026-1-5')).toBe(false);
    expect(isRealDate('2026/11/26')).toBe(false);
  });

  it('进位日期必须拒绝 —— dayjs 的 isValid() 对它们返回 true', () => {
    // dayjs('2026-13-45').isValid() === true（归一化成 2027-02-14）
    // dayjs('2026-02-30').isValid() === true（归一化成 2026-03-02）
    expect(isRealDate('2026-13-45')).toBe(false);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-04-31')).toBe(false);
    expect(isRealDate('0000-00-00')).toBe(false);
  });

  it('非闰年的 2 月 29 日必须拒绝 —— 闰年规则不能只靠进位样例兜着', () => {
    // 2023 不是闰年：dayjs('2023-02-29') 会进位成 2023-03-01，往返判定必须拒它。
    // （已有的 '2026-02-30' / '2026-04-31' 覆盖的是"进位机制"，2 月这条
    //   规则要单独钉住 —— 否则将来把往返判定换成别的东西，2 月会先坏。）
    expect(isRealDate('2023-02-29')).toBe(false);
    // 闰年本身必须放行（对照）
    expect(isRealDate('2024-02-29')).toBe(true);
    expect(isRealDate('2000-02-29')).toBe(true);
    // 世纪年：1900 不是闰年，2000 是
    expect(isRealDate('1900-02-29')).toBe(false);
    expect(isRealDate('2000-02-29')).toBe(true);
  });
});

describe('parseTxFilters —— URL 参数校验', () => {
  it('空参数 → 全空（= 不过滤）', () => {
    expect(parseTxFilters(params(''), KNOWN_FUNDS)).toEqual({
      fundId: '',
      type: '',
      date: '',
      status: '',
    });
  });

  it('合法参数正确解析', () => {
    const f = parseTxFilters(params('fund=160140&type=dividend&date=2026-11-26&status=confirmed'), KNOWN_FUNDS);
    expect(f).toEqual({
      fundId: '160140',
      type: 'dividend',
      date: '2026-11-26',
      status: 'confirmed',
    });
  });

  it('非法 type 被忽略（不能变成 0 条记录的死胡同）', () => {
    expect(parseTxFilters(params('type=foo'), KNOWN_FUNDS).type).toBe('');
    expect(parseTxFilters(params('type=buy'), KNOWN_FUNDS).type).toBe('buy');
  });

  it('非法 date 被忽略', () => {
    expect(parseTxFilters(params('date=abc'), KNOWN_FUNDS).date).toBe('');
    expect(parseTxFilters(params('date=2026-13-45'), KNOWN_FUNDS).date).toBe('');
    expect(parseTxFilters(params('date=2026-11-26'), KNOWN_FUNDS).date).toBe('2026-11-26');
  });

  it('未知 fund id 被忽略 —— 它会驱动「补登初始持仓」入口', () => {
    expect(parseTxFilters(params('fund=999999'), KNOWN_FUNDS).fundId).toBe('');
    expect(parseTxFilters(params('fund=160140'), KNOWN_FUNDS).fundId).toBe('160140');
  });

  it('status 只认 pending / confirmed', () => {
    expect(parseTxFilters(params('status=pending'), KNOWN_FUNDS).status).toBe('pending');
    expect(parseTxFilters(params('status=confirmed'), KNOWN_FUNDS).status).toBe('confirmed');
    expect(parseTxFilters(params('status=whatever'), KNOWN_FUNDS).status).toBe('');
  });
});

describe('filterTransactions —— 过滤', () => {
  const txs = [
    mkTx({ id: 'a', fundId: '160140', type: 'buy', date: '2026-11-26', status: 'confirmed' }),
    mkTx({ id: 'b', fundId: '160140', type: 'dividend', date: '2026-11-26', status: 'pending' }),
    mkTx({ id: 'c', fundId: '008163', type: 'dividend', date: '2026-11-25', status: 'confirmed' }),
    mkTx({ id: 'd', fundId: '008163', type: 'buy', date: '2026-11-25' }), // 未设 status
  ];

  it('fundId 单独生效', () => {
    const out = filterTransactions(txs, { fundId: '008163', type: '', date: '', status: '' });
    expect(out.map((t) => t.id)).toEqual(['c', 'd']);
  });

  it('type 单独生效', () => {
    const out = filterTransactions(txs, { fundId: '', type: 'dividend', date: '', status: '' });
    expect(out.map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('date 单独生效', () => {
    const out = filterTransactions(txs, { fundId: '', type: '', date: '2026-11-26', status: '' });
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('status=pending 只留待确认', () => {
    const out = filterTransactions(txs, { fundId: '', type: '', date: '', status: 'pending' });
    expect(out.map((t) => t.id)).toEqual(['b']);
  });

  it('status=confirmed 必须保留 status 未设的记录（与 onlyConfirmed 一致）', () => {
    const out = filterTransactions(txs, { fundId: '', type: '', date: '', status: 'confirmed' });
    expect(out.map((t) => t.id)).toEqual(['a', 'c', 'd']);
  });

  it('四条条件叠加', () => {
    const out = filterTransactions(txs, {
      fundId: '160140',
      type: 'dividend',
      date: '2026-11-26',
      status: 'pending',
    });
    expect(out.map((t) => t.id)).toEqual(['b']);
  });

  it('不改原数组、不改顺序', () => {
    const input = [...txs];
    const out = filterTransactions(input, { fundId: '', type: '', date: '', status: '' });
    expect(input).toEqual(txs);
    expect(out).not.toBe(input);
    expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('匹配不到任何记录 → 返回空数组（不是 undefined、不抛错）', () => {
    // 这正是 spec 反复警告的「0 条记录」路径 —— 落地页必须能显示空列表，
    // 不能炸、也不能返回 undefined 让 .map 挂掉。
    const out = filterTransactions(txs, {
      fundId: '160140',
      type: 'dividend',
      date: '2020-01-01',
      status: '',
    });
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([]);
    // 单条件也能命中空集
    expect(filterTransactions(txs, { fundId: '999999', type: '', date: '', status: '' })).toEqual([]);
    expect(filterTransactions(txs, { fundId: '', type: 'buy', date: '2020-01-01', status: '' })).toEqual([]);
    expect(filterTransactions([], { fundId: '', type: '', date: '', status: '' })).toEqual([]);
  });
});

describe('txFilterParams —— 反向生成 URL 参数', () => {
  it('空值不输出', () => {
    expect(txFilterParams({ fundId: '', type: '', date: '', status: '' })).toEqual({});
  });

  it('非空值输出，参数名固定', () => {
    expect(
      txFilterParams({ fundId: '160140', type: 'buy', date: '2026-11-26', status: 'confirmed' }),
    ).toEqual({ fund: '160140', type: 'buy', date: '2026-11-26', status: 'confirmed' });
  });

  it('往返幂等', () => {
    const f: TxFilters = {
      fundId: '160140',
      type: 'dividend',
      date: '2026-11-26',
      status: 'pending',
    };
    const round = parseTxFilters(new URLSearchParams(txFilterParams(f)), KNOWN_FUNDS);
    expect(round).toEqual(f);
  });

  it('往返幂等只对账本里存在的 fundId 成立 —— 未知 fund 是设计性地被丢弃', () => {
    // parseTxFilters 会把账本里不存在的 fund 当没传（防孤儿交易），
    // 所以往返后 fundId 变成 ''，不是原值。这是有意的，不是 bug。
    const f: TxFilters = { fundId: '999999', type: 'buy', date: '', status: '' };
    const round = parseTxFilters(new URLSearchParams(txFilterParams(f)), KNOWN_FUNDS);
    expect(round).toEqual({ ...f, fundId: '' });
  });
});

/**
 * 契约测试：首页卡片数字 ≡ 落地页列表合计。
 *
 * 这是本分支的**核心不变式**。此前它只靠"两处公式各写一遍 + 一条注释绑定"——
 * 没有任何东西阻止有人只改一边，卡片与落地页会再次静默分叉（两个文件、两个
 * 地方、没有测试会红）。这正是仓库里所有真实事故的形状。
 *
 * 下面走**两条不同的路径**算同一个数：
 *   卡片：calcDividendTotal / calcTodayInvested（utils/calculator.ts）
 *   落地页：filterTransactions（utils/txFilter.ts）+ 同一份求和
 *
 * 断言按 2 位小数比较：两边求和顺序不同（落地页先按日期倒序排、卡片按 store
 * 顺序），浮点加法不满足结合律，末位 ULP 可能不同。
 */
describe('契约：卡片数字 ≡ 落地页列表合计', () => {
  /** 固定「今天」—— `calcTodayInvested` 默认取 `new Date()`，固定日期才能让这条
   *  测试在任意一天跑都得到同一个结果。用**本地** Date 构造器（不是日期字符串），
   * 避开 UTC 与本地时区的偏移（CI 跑在 UTC）。 */
  const TODAY = '2026-11-26';
  const TODAY_DATE = new Date(2026, 10, 26);

  const CONTRACT_TXS: Transaction[] = [
    // 已确认现金分红：amount 就是分红金额
    mkTx({ id: 'd1', type: 'dividend', amount: 120.5, fee: 0, shares: 0, nav: 0, status: 'confirmed' }),
    // 红利再投资分红，**且 shares × nav > amount**（60.8 vs 66）——
    // 这条是**判别用例**：口径是「amount > 0 早退」（取 60.8），不是无条件
    // Math.max（会取 66）。哪天有人把 calcDividendTotal"简化"成无条件
    // Math.max，这里就会红（差 5.2 元）。
    mkTx({ id: 'd2', type: 'dividend', amount: 60.8, fee: 0, shares: 55, nav: 1.2, status: 'confirmed' }),
    // 红利再投资分红，**amount = 0**（老数据形态）→ 走 shares × nav 分支
    mkTx({ id: 'd3', type: 'dividend', amount: 0, fee: 0, shares: 100, nav: 1.5, status: 'confirmed' }),
    // 待确认分红 —— 两条路径都必须排除
    mkTx({ id: 'd4', type: 'dividend', amount: 999, fee: 0, shares: 0, nav: 0, status: 'pending' }),
    // 旧记录：**没有 status 字段** —— 两条路径都必须当「已确认」
    mkTx({ id: 'd5', type: 'dividend', amount: 33.3, fee: 0, shares: 0, nav: 0 }),
    // 今天的买入（已确认 / 待确认 —— 两条路径都算）
    mkTx({ id: 'b1', type: 'buy', date: TODAY, amount: 1000, fee: 0, shares: 800, nav: 1.25, status: 'confirmed' }),
    mkTx({ id: 'b2', type: 'buy', date: TODAY, amount: 500.25, fee: 0, shares: 400.2, nav: 1.25, status: 'pending' }),
    // 昨天的买入 —— 今天的两条路径都必须排除
    mkTx({ id: 'b3', type: 'buy', date: '2026-11-25', amount: 777, fee: 0, shares: 600, nav: 1.295, status: 'confirmed' }),
  ];

  it('分红链路：calcDividendTotal ≡ 落地页筛选后各笔 dividendValue 之和', () => {
    const landed = filterTransactions(CONTRACT_TXS, {
      fundId: '',
      type: 'dividend',
      date: '',
      status: 'confirmed',
    });
    // 落地页拿到的是同一批记录：待确认的排除，status 未设的保留
    expect(landed.map((t) => t.id)).toEqual(['d1', 'd2', 'd3', 'd5']);
    const landedSum = landed.reduce((sum, tx) => sum + dividendValue(tx), 0);
    expect(calcDividendTotal(CONTRACT_TXS)).toBeCloseTo(landedSum, 2);
  });

  it('买入链路：calcTodayInvested.txAmount ≡ 落地页筛选后各笔 tx.amount 之和', () => {
    const landed = filterTransactions(CONTRACT_TXS, {
      fundId: '',
      type: 'buy',
      date: TODAY,
      status: '',
    });
    expect(landed.map((t) => t.id)).toEqual(['b1', 'b2']);
    const landedSum = landed.reduce((sum, tx) => sum + tx.amount, 0);
    expect(calcTodayInvested(CONTRACT_TXS, [], TODAY_DATE).txAmount).toBeCloseTo(landedSum, 2);
  });

  it('dividendValue 的口径被钉死：amount > 0 早退，不是无条件 Math.max', () => {
    const cash = mkTx({ id: 'x1', type: 'dividend', amount: 120.5, shares: 0, nav: 0 });
    // 现金分红 → amount
    expect(dividendValue(cash)).toBe(120.5);
    // 红利再投资且 amount > 0 → 仍是 amount（**不是** max(amount, shares × nav)）
    const reinvest = mkTx({ id: 'x2', type: 'dividend', amount: 60.8, shares: 55, nav: 1.2 });
    expect(dividendValue(reinvest)).toBe(60.8);
    expect(dividendValue(reinvest)).not.toBe(Math.max(60.8, 55 * 1.2));
    // 红利再投资且 amount = 0（老数据形态）→ shares × nav
    const legacy = mkTx({ id: 'x3', type: 'dividend', amount: 0, shares: 100, nav: 1.5 });
    expect(dividendValue(legacy)).toBe(150);
  });
});
