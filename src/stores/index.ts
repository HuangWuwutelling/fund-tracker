import { create } from 'zustand';
import type { Platform, Fund, Transaction, DcaPlan, DailySnapshot, Settings, NavRecord } from '../types';
import * as storage from '../utils/storage';
import { generateSnapshot } from '../utils/snapshot';
import dayjs from 'dayjs';

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

  // Actions - Transactions
  addTransaction: (tx: Transaction) => void;
  updateTransaction: (id: string, updates: Partial<Transaction>) => void;
  removeTransaction: (id: string) => void;

  // Actions - DCA Plans
  addDcaPlan: (plan: DcaPlan) => void;
  updateDcaPlan: (id: string, updates: Partial<DcaPlan>) => void;
  removeDcaPlan: (id: string) => void;
  toggleDcaPlan: (id: string) => void;

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
  importData: (data: ReturnType<typeof storage.exportAllData>) => void;
}

export const useStore = create<FundTrackerState>((set, get) => ({
  platforms: [],
  funds: [],
  transactions: [],
  dcaPlans: [],
  snapshots: [],
  settings: { theme: 'light', navAutoRefresh: true, reportFrequency: 'both' },

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

    // Regenerate today's snapshot to reflect the removal
    const newSnapshot = generateSnapshot(funds, transactions);
    const snapshots = [...get().snapshots.filter((s) => s.date !== newSnapshot.date), newSnapshot];
    storage.saveSnapshots(snapshots);

    set({ funds, transactions, dcaPlans, snapshots });
  },

  getFundById: (id) => get().funds.find((f) => f.id === id),

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
    // 缺字段时 fallback 到默认值，避免整个 app 崩溃成空白页
    set({
      platforms: data.platforms,
      funds: data.funds,
      transactions: data.transactions,
      dcaPlans: data.dcaPlans,
      snapshots: data.snapshots ?? [],
      settings: data.settings ?? { theme: 'light', navAutoRefresh: true, reportFrequency: 'both' },
    });
  },
}));
