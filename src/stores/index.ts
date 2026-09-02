import { create } from 'zustand';
import type { Platform, Fund, Transaction, DcaPlan, DailySnapshot, Settings, NavRecord } from '../types';
import * as storage from '../utils/storage';
import { generateSnapshot } from '../utils/snapshot';
import { getPlanDueDates } from '../utils/calculator';
import { today } from '../utils/formatter';
import { getFundTypeFromName } from '../api/fundApi';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';

/** 净值历史内存缓存：避免每次 getNavHistory 都解析 localStorage JSON。
 *  updateNavHistory 和 loadFromStorage 时清空；getNavHistory 命中后写入。
 */
const navHistoryCache = new Map<string, NavRecord[]>();

interface FundTrackerState {
  // Data
  platforms: Platform[];
  funds: Fund[];
  transactions: Transaction[];
  dcaPlans: DcaPlan[];
  snapshots: DailySnapshot[];
  settings: Settings;

  // Actions - Platforms
  addPlatform: (name: string) => void;
  removePlatform: (id: string) => boolean;
  getPlatformById: (id: string) => Platform | undefined;

  // Actions - Funds
  addFund: (fund: Fund) => void;
  updateFund: (id: string, updates: Partial<Fund>) => void;
  removeFund: (id: string) => void;
  getFundById: (id: string) => Fund | undefined;
  /** 按基金名称重新分类所有基金类型（修正早期版本把 QDII/债券指数误判为"指数型"）；返回变化的基金数 */
  reclassifyFunds: () => number;

  // Actions - Transactions
  addTransaction: (tx: Transaction) => void;
  updateTransaction: (id: string, updates: Partial<Transaction>) => void;
  removeTransaction: (id: string) => void;

  // Actions - DCA Plans
  addDcaPlan: (plan: DcaPlan) => void;
  updateDcaPlan: (id: string, updates: Partial<DcaPlan>) => void;
  removeDcaPlan: (id: string) => void;
  toggleDcaPlan: (id: string) => void;
  /** 把启用的定投计划按日程批量补成"待确认买入"交易记录；返回本次生成的笔数 */
  autoRecordDcaPlans: () => number;

  // Actions - Snapshots
  addSnapshot: (snapshot: DailySnapshot) => void;

  // Actions - Settings
  updateSettings: (updates: Partial<Settings>) => void;

  // Actions - Nav
  updateNavHistory: (fundCode: string, records: NavRecord[]) => void;
  getNavHistory: (fundCode: string) => NavRecord[];
  resetNavHistory: (fundCode?: string) => void;

  // Actions - Refresh trigger (App.tsx subscribes to bump to re-run refreshAll)
  refreshTrigger: number;
  requestRefresh: () => void;

  // Actions - Init & Bulk
  loadFromStorage: () => void;
  exportData: () => void;
  /** 导入并覆盖全部数据；返回按定投计划自动生成的交易笔数 */
  importData: (data: ReturnType<typeof storage.exportAllData>) => number;
}

export const useStore = create<FundTrackerState>((set, get) => ({
  platforms: [],
  funds: [],
  transactions: [],
  dcaPlans: [],
  snapshots: [],
  settings: { theme: 'light', navAutoRefresh: true, reportFrequency: 'both', dcaAutoRecord: true },

  // --- Platforms ---
  addPlatform: (name) => {
    const platform: Platform = { id: `platform-${Date.now()}`, name };
    const platforms = [...get().platforms, platform];
    storage.savePlatforms(platforms);
    set({ platforms });
  },

  removePlatform: (id) => {
    const hasFund = get().funds.some((f) => f.platformId === id);
    if (hasFund) return false;
    const platforms = get().platforms.filter((p) => p.id !== id);
    storage.savePlatforms(platforms);
    set({ platforms });
    return true;
  },

  getPlatformById: (id) => get().platforms.find((p) => p.id === id),

  // --- Funds ---
  addFund: (fund) => {
    const funds = [...get().funds, fund];
    storage.saveFunds(funds);
    set({ funds });
  },

  updateFund: (id, updates) => {
    const funds = get().funds.map((f) => (f.id === id ? { ...f, ...updates } : f));
    storage.saveFunds(funds);
    set({ funds });
  },

  removeFund: (id) => {
    const funds = get().funds.filter((f) => f.id !== id);
    storage.saveFunds(funds);
    // Also remove transactions and nav history for this fund
    const transactions = get().transactions.filter((t) => t.fundId !== id);
    storage.saveTransactions(transactions);
    const dcaPlans = get().dcaPlans.filter((p) => p.fundId !== id);
    storage.saveDcaPlans(dcaPlans);
    navHistoryCache.delete(id);
    storage.removeNavHistory(id);

    // Regenerate today's snapshot to reflect the removal (skip on non-trading days)
    const newSnapshot = generateSnapshot(funds, transactions);
    const snapshots = newSnapshot
      ? [...get().snapshots.filter((s) => s.date !== newSnapshot.date), newSnapshot]
      : get().snapshots.filter((s) => s.date !== today());
    storage.saveSnapshots(snapshots);

    set({ funds, transactions, dcaPlans, snapshots });
  },

  getFundById: (id) => get().funds.find((f) => f.id === id),

  reclassifyFunds: () => {
    const { funds } = get();
    let changed = 0;
    const updated = funds.map((f) => {
      // 名称无线索时返回 null——保留用户手动设置的原类型，不被覆盖成 'mixed'
      const t = getFundTypeFromName(f.name);
      if (t === null || t === f.type) return f;
      changed++;
      return { ...f, type: t };
    });
    if (changed === 0) return 0;
    storage.saveFunds(updated);
    set({ funds: updated });
    return changed;
  },

  // --- Transactions ---
  addTransaction: (tx) => {
    const transactions = [...get().transactions, tx];
    storage.saveTransactions(transactions);
    set({ transactions });
  },

  updateTransaction: (id, updates) => {
    const transactions = get().transactions.map((t) => (t.id === id ? { ...t, ...updates } : t));
    storage.saveTransactions(transactions);
    set({ transactions });
  },

  removeTransaction: (id) => {
    const transactions = get().transactions.filter((t) => t.id !== id);
    storage.saveTransactions(transactions);
    set({ transactions });
  },

  // --- DCA Plans ---
  addDcaPlan: (plan) => {
    const dcaPlans = [...get().dcaPlans, plan];
    storage.saveDcaPlans(dcaPlans);
    set({ dcaPlans });
  },

  updateDcaPlan: (id, updates) => {
    const dcaPlans = get().dcaPlans.map((p) => (p.id === id ? { ...p, ...updates } : p));
    storage.saveDcaPlans(dcaPlans);
    set({ dcaPlans });
  },

  removeDcaPlan: (id) => {
    const dcaPlans = get().dcaPlans.filter((p) => p.id !== id);
    storage.saveDcaPlans(dcaPlans);
    set({ dcaPlans });
  },

  toggleDcaPlan: (id) => {
    const dcaPlans = get().dcaPlans.map((p) =>
      p.id === id ? { ...p, active: !p.active } : p
    );
    storage.saveDcaPlans(dcaPlans);
    set({ dcaPlans });
  },

  // 定投自动记录：为每个启用计划，把 startDate→今天 之间所有应执行日（当天该基金
  // 还没有买入记录）补成 pending 买入。幂等——已记录的日子不再重复生成。
  // 生成的记录 shares/nav=0、status=pending，等净值发布由 autoConfirmPending 转确认。
  autoRecordDcaPlans: () => {
    const { dcaPlans, transactions } = get();
    const today = dayjs().format('YYYY-MM-DD');
    // 去重键改为 planId:fundId:date——不同计划即使同日投同基金也各自独立成单。
    // 手动买入的 planId 为空，键 = ':fundId:date'，与任何启用计划的 planId 都不同，
    // 因此不会被误吞；同时也避免旧键 fundId:date 在多计划同日场景下吞掉后续计划。
    const seen = new Set(
      transactions
        .filter((t) => t.type === 'buy')
        .map((t) => `${t.planId ?? ''}:${t.fundId}:${t.date}`)
    );

    const newTxs: Transaction[] = [];
    for (const plan of dcaPlans) {
      if (!plan.active) continue;
      for (const date of getPlanDueDates(plan, today)) {
        const dedupeKey = `${plan.id}:${plan.fundId}:${date}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        newTxs.push({
          id: uuid(),
          fundId: plan.fundId,
          type: 'buy',
          date,
          amount: plan.amount,
          fee: 0,
          shares: 0,
          nav: 0,
          status: 'pending',
          planId: plan.id,
          note: '定投自动记录',
        });
      }
    }

    if (newTxs.length === 0) return 0;
    const updatedTransactions = [...get().transactions, ...newTxs];
    storage.saveTransactions(updatedTransactions);
    set({ transactions: updatedTransactions });
    return newTxs.length;
  },

  // --- Snapshots ---
  addSnapshot: (snapshot) => {
    const existing = get().snapshots.filter((s) => s.date !== snapshot.date);
    const snapshots = [...existing, snapshot];
    storage.saveSnapshots(snapshots);
    set({ snapshots });
  },

  // --- Settings ---
  updateSettings: (updates) => {
    const settings = { ...get().settings, ...updates };
    storage.saveSettings(settings);
    set({ settings });
  },

  // --- Nav History ---
  updateNavHistory: (fundCode, records) => {
    navHistoryCache.set(fundCode, records);
    storage.saveNavHistory(fundCode, records);
  },

  getNavHistory: (fundCode) => {
    const cached = navHistoryCache.get(fundCode);
    if (cached) return cached;
    const records = storage.getNavHistory(fundCode);
    navHistoryCache.set(fundCode, records);
    return records;
  },

  resetNavHistory: (fundCode) => {
    if (fundCode) {
      navHistoryCache.delete(fundCode);
      storage.removeNavHistory(fundCode);
    } else {
      navHistoryCache.clear();
      storage.removeAllNavHistory();
    }
    set((s) => ({ refreshTrigger: s.refreshTrigger + 1 }));
  },

  // --- Refresh trigger ---
  refreshTrigger: 0,

  requestRefresh: () => {
    set((s) => ({ refreshTrigger: s.refreshTrigger + 1 }));
  },

  // --- Init & Bulk ---
  loadFromStorage: () => {
    navHistoryCache.clear();
    storage.initStorage();
    set({
      platforms: storage.getPlatforms(),
      funds: storage.getFunds(),
      transactions: storage.getTransactions(),
      dcaPlans: storage.getDcaPlans(),
      snapshots: storage.getSnapshots(),
      settings: storage.getSettings(),
    });
  },

  exportData: () => {
    const data = storage.exportAllData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = dayjs().format('YYYY-MM-DD');
    a.href = url;
    a.download = `fund-tracker-backup-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  importData: (data) => {
    navHistoryCache.clear();
    storage.importAllData(data);
    // 缺字段时 fallback 到默认值，避免整个 app 崩溃成空白页；
    // settings 用默认值打底再覆盖导入值，兼容缺新字段（如 dcaAutoRecord）的老备份
    // （运行时备份可能缺失部分字段，故以 Partial 展开，避免 TS2783）
    const settings: Settings = { ...storage.DEFAULT_SETTINGS, ...(data.settings as Partial<Settings>) };
    set({
      platforms: data.platforms,
      funds: data.funds,
      transactions: data.transactions,
      dcaPlans: data.dcaPlans,
      snapshots: data.snapshots ?? [],
      settings,
    });
    // 导入后立刻补定投记录（页面 mount 的自动记录早已跑过，导入不会重跑它）
    return get().settings.dcaAutoRecord ? get().autoRecordDcaPlans() : 0;
  },
}));
