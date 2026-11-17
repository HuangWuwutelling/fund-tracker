import { describe, it, expect, beforeAll, afterEach } from 'vitest';

// Node 环境没有 localStorage——stub 它，让 storage.ts 的 getItem 不抛
beforeAll(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    };
  }
});

// @ts-expect-error vitest 提供 node 环境,tsc 不带 @types/node（仅可选分支用）
import { readFileSync, existsSync, readdirSync } from 'fs';
// @ts-expect-error 同上
import { resolve } from 'path';
import dayjs from 'dayjs';
import {
  generateDailyReturns,
  generateMonthlyReturns,
  generateYearlyReturns,
  generateMonthlyReport,
  generateWeeklyReport,
  __setNavHistoryForTest,
} from './reportGenerator';
import type { Fund, Transaction, Platform, NavRecord } from '../types';

/* ============================================================
 * WC ↔ Reports 对账测试
 *
 * 不变量：月报 totalReturn = 当月日格之和；月度/年度聚合同理；
 *         周报 totalReturn = 周内日格之和。
 *
 * 数据来源分两层：
 * 1. 程序化确定性场景（必跑）——原 fixture fund-tracker-backup-2026-10-05.json
 *    已从仓库根删除（含个人数据，被 gitignore），改为在测试内构造等效场景：
 *    买入 / 现金分红 / 卖出（含手续费）/ pending 排除 / 跨月望远镜求和。
 *    日期取 2026-08 ~ 2026-09，永远早于运行日，"今日格"不干扰断言。
 * 2. 可选真实数据分支（本地有 fund-tracker-backup-*.json 时附加跑，
 *    CI 里因 gitignore 自然跳过）。
 * ============================================================ */

/** 生成 [start, end] 内的工作日序列（YYYY-MM-DD，跳过周末） */
function weekdays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let c = dayjs(start); c.format('YYYY-MM-DD') <= end; c = c.add(1, 'day')) {
    const dow = c.day();
    if (dow !== 0 && dow !== 6) out.push(c.format('YYYY-MM-DD'));
  }
  return out;
}

// 2026-08-03（周一）~ 2026-09-30（周三）的工作日；该区间无 A 股法定节假日干扰
const NAV_DATES = weekdays('2026-08-03', '2026-09-30');

/** 确定性净值：f1 线性上行，f2 锯齿波动，四舍五入到 4 位（真实 NAV 精度） */
function navFor(fundIdx: number, date: string): number {
  const i = NAV_DATES.indexOf(date);
  const raw = fundIdx === 0 ? 1 + i * 0.002 : 1 + (i % 5) * 0.003;
  return Math.round(raw * 10000) / 10000;
}

const FUNDS: Fund[] = [
  { id: 'TEST001', name: '测试沪深300联接A', platformId: 'p1', type: 'index', currentNav: navFor(0, NAV_DATES[NAV_DATES.length - 1]!), navDate: NAV_DATES[NAV_DATES.length - 1]! },
  { id: 'TEST002', name: '测试国开债7-10年A', platformId: 'p1', type: 'bond', currentNav: navFor(1, NAV_DATES[NAV_DATES.length - 1]!), navDate: NAV_DATES[NAV_DATES.length - 1]! },
];

const PLATFORMS: Platform[] = [{ id: 'p1', name: '测试平台' }];

const TRANSACTIONS: Transaction[] = [
  { id: 't1', fundId: 'TEST001', type: 'buy', date: '2026-08-03', amount: 10000, fee: 0, shares: 10000, nav: 1, status: 'confirmed' },
  { id: 't2', fundId: 'TEST002', type: 'buy', date: '2026-08-05', amount: 5000, fee: 0, shares: 5000, nav: 1, status: 'confirmed' },
  // 现金分红：amount > 0、shares = 0
  { id: 't3', fundId: 'TEST002', type: 'dividend', date: '2026-08-14', amount: 50, fee: 0, shares: 0, nav: 0, status: 'confirmed' },
  // 卖出含手续费：totalSellNet = amount - fee
  { id: 't4', fundId: 'TEST001', type: 'sell', date: '2026-09-10', amount: 2400, fee: 10, shares: 2000, nav: 1.2, status: 'confirmed' },
  // pending：必须被排除在 WC 计算之外
  { id: 't5', fundId: 'TEST001', type: 'buy', date: '2026-09-15', amount: 1000, fee: 0, shares: 1000, nav: 0, status: 'pending' },
];

function navHistoryFor(fundIdx: number): NavRecord[] {
  return NAV_DATES.map((date) => ({ date, nav: navFor(fundIdx, date), accNav: navFor(fundIdx, date) }));
}

/**
 * 独立复算 WC 累计收益（与 reportGenerator 文档头公式一致）：
 *   cum(D) = shares(D) × nav(D) − totalBuy + totalSellNet + totalCashDiv
 * 用它对月度/周度做望远镜求和断言，防止"日格口径"与"累计口径"双双漂移。
 */
function expectedCumAt(fundIdx: number, date: string): number {
  const fund = FUNDS[fundIdx]!;
  const txs = TRANSACTIONS.filter((t) => t.fundId === fund.id && t.status === 'confirmed' && t.date <= date);
  let shares = 0;
  let totalBuy = 0;
  let totalSellNet = 0;
  let totalCashDiv = 0;
  for (const t of txs) {
    if (t.type === 'buy') { shares += t.shares; totalBuy += t.amount; }
    else if (t.type === 'sell') { shares -= t.shares; totalSellNet += t.amount - t.fee; }
    else if (t.type === 'dividend') { totalCashDiv += t.amount; }
  }
  const nav = navFor(fundIdx, date);
  return shares * nav - totalBuy + totalSellNet + totalCashDiv;
}

/** 写入 nav 数据：localStorage（月报内部 lookupNavForDate 走 storage）+ 测试注入钩子 */
function loadNavs(histories: Record<string, NavRecord[]>) {
  for (const [code, records] of Object.entries(histories)) {
    localStorage.setItem(`fund-tracker:nav:${code}`, JSON.stringify(records));
  }
  __setNavHistoryForTest((code: string) => histories[code] ?? []);
}

afterEach(() => {
  __setNavHistoryForTest(null);
});

/** 对一组 (funds, transactions) 运行全部对账断言；platforms 可注入（真实备份分支传 json.platforms） */
function assertReconciliation(
  funds: Fund[],
  transactions: Transaction[],
  platforms: Platform[] = PLATFORMS,
) {
  const dailyReturns = generateDailyReturns(funds, transactions);

  // 1) 月报 = 当月日格之和（Aug / Sep 2026）
  const augRep = generateMonthlyReport(2026, 8, funds, transactions, [], platforms);
  const sepRep = generateMonthlyReport(2026, 9, funds, transactions, [], platforms);
  const augWC = dailyReturns.filter((d) => d.date.startsWith('2026-08')).reduce((s, d) => s + d.totalReturn, 0);
  const sepWC = dailyReturns.filter((d) => d.date.startsWith('2026-09')).reduce((s, d) => s + d.totalReturn, 0);
  expect(Math.abs(augRep.totalReturn - augWC)).toBeLessThan(0.01);
  expect(Math.abs(sepRep.totalReturn - sepWC)).toBeLessThan(0.01);

  // 2) 月度聚合 = 日格之和
  const monthly2026 = generateMonthlyReturns(funds, transactions, dailyReturns, 2026);
  const augMR = monthly2026.find((m) => m.month === '2026-08');
  const sepMR = monthly2026.find((m) => m.month === '2026-09');
  expect(Math.abs((augMR?.totalReturn ?? 0) - augWC)).toBeLessThan(0.01);
  expect(Math.abs((sepMR?.totalReturn ?? 0) - sepWC)).toBeLessThan(0.01);

  // 3) 年度聚合 = 日格之和
  const yearly = generateYearlyReturns(funds, transactions, dailyReturns);
  const yr2026 = yearly.find((y) => y.year === '2026');
  const total2026 = dailyReturns.filter((d) => d.date.startsWith('2026')).reduce((s, d) => s + d.totalReturn, 0);
  expect(Math.abs((yr2026?.totalReturn ?? 0) - total2026)).toBeLessThan(0.01);

  // 4) 周报 = 周内日格之和（2026-09-09 所在周 = 9/7 周一 ~ 9/13 周日，跨卖出事件）
  const weekRep = generateWeeklyReport(new Date('2026-09-09'), funds, transactions, [], []);
  const weekWC = dailyReturns
    .filter((d) => d.date >= '2026-09-07' && d.date <= '2026-09-13')
    .reduce((s, d) => s + d.totalReturn, 0);
  expect(Math.abs(weekRep.totalReturn - weekWC)).toBeLessThan(0.01);

  return { augWC, sepWC, weekWC, weekRep };
}

describe('WC ↔ Reports 对账（程序化确定性场景）', () => {
  it('月报/月度/年度 = 日格之和，且日格望远镜求和与累计公式吻合', () => {
    loadNavs({ TEST001: navHistoryFor(0), TEST002: navHistoryFor(1) });

    const { augWC, sepWC, weekWC } = assertReconciliation(FUNDS, TRANSACTIONS);

    // 独立公式复核（不只验内部自洽）：
    // Aug = cum(8/31) − 0：f1 10000 份 + f2 5000 份 + f2 现金分红 50
    const expectedAug =
      expectedCumAt(0, '2026-08-31') + expectedCumAt(1, '2026-08-31');
    expect(Math.abs(augWC - expectedAug)).toBeLessThan(0.01);
    // Sep = cum(9/30) − cum(8/31)：f1 含 9/10 卖出（+2390 净回款），pending 不参与
    const expectedSep =
      (expectedCumAt(0, '2026-09-30') - expectedCumAt(0, '2026-08-31')) +
      (expectedCumAt(1, '2026-09-30') - expectedCumAt(1, '2026-08-31'));
    expect(Math.abs(sepWC - expectedSep)).toBeLessThan(0.01);
    // 周格 = cum(9/11) − cum(9/4)（9/12/13 是周末，望远镜到 9/11 的累计值）
    const expectedWeek =
      (expectedCumAt(0, '2026-09-11') - expectedCumAt(0, '2026-09-04')) +
      (expectedCumAt(1, '2026-09-11') - expectedCumAt(1, '2026-09-04'));
    expect(Math.abs(weekWC - expectedWeek)).toBeLessThan(0.01);
  });

  it('pending 交易不产生日格（排除验证）', () => {
    loadNavs({ TEST001: navHistoryFor(0), TEST002: navHistoryFor(1) });
    const dailyReturns = generateDailyReturns(FUNDS, TRANSACTIONS);
    // pending 买入 9/15：若被误计入，9/15 起日格会额外多 1000 份的涨跌，
    // Sep 总和就会偏离独立公式（expectedSep 只含 8000 份 + 2390 回款）
    const expectedSep =
      (expectedCumAt(0, '2026-09-30') - expectedCumAt(0, '2026-08-31')) +
      (expectedCumAt(1, '2026-09-30') - expectedCumAt(1, '2026-08-31'));
    const sepWC = dailyReturns.filter((d) => d.date.startsWith('2026-09')).reduce((s, d) => s + d.totalReturn, 0);
    expect(Math.abs(sepWC - expectedSep)).toBeLessThan(0.01);
  });
});

describe('WC ↔ Reports 对账（可选：本地真实备份）', () => {
  // 真实备份是全历史数据（~2 万条净值），generateDailyReturns 全日历跑数轮，
  // 本地实测 >5s；vitest 默认 5s 会超时，显式放宽。CI 无备份文件，天然跳过。
  it('仓库根存在 fund-tracker-backup-*.json 时附加对账（CI 跳过）', () => {
    // @ts-expect-error 同上
    const dir = process.cwd();
    let path: string | null = null;
    try {
      const backup = readdirSync(dir).find((f: string) => /^fund-tracker-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f));
      if (backup) path = resolve(dir, backup);
    } catch {
      return;
    }
    if (!path || !existsSync(path)) return;

    const json = JSON.parse(readFileSync(path, 'utf-8')) as {
      funds: Fund[];
      transactions: Transaction[];
      navHistories: Record<string, NavRecord[]>;
      platforms: Platform[];
    };
    const histories: Record<string, NavRecord[]> = {};
    for (const [code, records] of Object.entries(json.navHistories ?? {})) {
      histories[code] = records.map((r) => ({ date: r.date, nav: r.nav, accNav: r.accNav }));
    }
    loadNavs(histories);
    const { augWC, sepWC, weekWC, weekRep } = assertReconciliation(json.funds, json.transactions, json.platforms ?? PLATFORMS);
    const fileName = path.replace(/\\/g, '/').split('/').pop();
    console.log(`[真实备份 ${fileName}] Aug: ${augWC.toFixed(2)}, Sep: ${sepWC.toFixed(2)}, 周 9/7-9/13: 报表 ${weekRep.totalReturn.toFixed(2)} vs 日历 ${weekWC.toFixed(2)}`);
  }, 60000);
});
