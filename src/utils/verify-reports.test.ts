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

// @ts-expect-error vitest 提供 node 环境,tsc 不带 @types/node
import { readFileSync } from 'fs';
// @ts-expect-error 同上
import { resolve } from 'path';
import {
  generateDailyReturns,
  generateMonthlyReturns,
  generateYearlyReturns,
  generateMonthlyReport,
  generateWeeklyReport,
  __setNavHistoryForTest,
} from './reportGenerator';
import type { Fund, Transaction, Platform } from '../types';

interface BackupJson {
  funds: Fund[];
  transactions: Transaction[];
  navHistories: Record<string, { date: string; nav: number; accNav: number }[]>;
  platforms: Platform[];
}

let json: BackupJson | null = null;

beforeAll(() => {
  // @ts-expect-error 同上
  const path = resolve(process.cwd(), 'fund-tracker-backup-2026-10-05.json');
  try {
    json = JSON.parse(readFileSync(path, 'utf-8'));
    if (json) {
      for (const [code, records] of Object.entries(json.navHistories)) {
        localStorage.setItem(`fund-tracker:nav:${code}`, JSON.stringify(records));
      }
    }
  } catch {
    json = null;
  }
});

afterEach(() => {
  __setNavHistoryForTest(null);
});

describe('WC ↔ Reports 对账', () => {
  it('Reports.tsx 月报 = portfolio 月日历 = 日格之和', () => {
    if (!json) {
      console.warn('跳过：未找到 JSON');
      return;
    }
    __setNavHistoryForTest((code: string) => (json?.navHistories[code] ?? []));

    const dailyReturns = generateDailyReturns(json.funds, json.transactions);

    // 1) generateMonthlyReport 的 totalReturn 必须等于当月日格之和
    const augRep = generateMonthlyReport(2026, 8, json.funds, json.transactions, [], json.platforms);
    const sepRep = generateMonthlyReport(2026, 9, json.funds, json.transactions, [], json.platforms);
    const augWC = dailyReturns
      .filter((d) => d.date.startsWith('2026-08'))
      .reduce((s, d) => s + d.totalReturn, 0);
    const sepWC = dailyReturns
      .filter((d) => d.date.startsWith('2026-09'))
      .reduce((s, d) => s + d.totalReturn, 0);

    console.log(`月报 Aug: ${augRep.totalReturn.toFixed(2)} vs 日历 Aug: ${augWC.toFixed(2)}`);
    console.log(`月报 Sep: ${sepRep.totalReturn.toFixed(2)} vs 日历 Sep: ${sepWC.toFixed(2)}`);

    // 2) generateMonthlyReturns 也必须等于日格之和
    const monthly2026 = generateMonthlyReturns(json.funds, json.transactions, dailyReturns, 2026);
    const augMR = monthly2026.find((m) => m.month === '2026-08');
    const sepMR = monthly2026.find((m) => m.month === '2026-09');
    console.log(`月度 Aug   总: ${augMR?.totalReturn.toFixed(2)}`);
    console.log(`月度 Sep   总: ${sepMR?.totalReturn.toFixed(2)}`);

    // 3) generateYearlyReturns 同理
    const yearly = generateYearlyReturns(json.funds, json.transactions, dailyReturns);
    const yr2026 = yearly.find((y) => y.year === '2026');
    console.log(`年度 2026: ${yr2026?.totalReturn.toFixed(2)}`);

    // 4) 周报（取 Sep W1 = 8/31-9/6 跨月区间，先看简单一周 = 9/7-9/13）
    const weekStart = '2026-09-07';
    const weekEnd = '2026-09-13';
    const weekRep = generateWeeklyReport(
      new Date('2026-09-09'),
      json.funds,
      json.transactions,
      [],
      []
    );
    const weekWC = dailyReturns
      .filter((d) => d.date >= weekStart && d.date <= weekEnd)
      .reduce((s, d) => s + d.totalReturn, 0);
    console.log(`周报 [${weekRep.weekStart}..${weekRep.weekEnd}]: ${weekRep.totalReturn.toFixed(2)} vs 日历: ${weekWC.toFixed(2)}`);

    // 断言：月报 = 月日历
    expect(Math.abs(augRep.totalReturn - augWC)).toBeLessThan(0.01);
    expect(Math.abs(sepRep.totalReturn - sepWC)).toBeLessThan(0.01);
    // 月日历 = 日格之和（再验证一遍）
    expect(Math.abs((augMR?.totalReturn ?? 0) - augWC)).toBeLessThan(0.01);
    expect(Math.abs((sepMR?.totalReturn ?? 0) - sepWC)).toBeLessThan(0.01);
  });
});