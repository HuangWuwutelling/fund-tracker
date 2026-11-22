import { create } from 'zustand';
import type { Platform, Fund, Transaction, DcaPlan, DailySnapshot, Settings, NavRecord, IndexQuote, IndexHistoryRecord, FundRefreshIssue } from '../types';
import * as storage from '../utils/storage';
import { normalizeInitialPositionNav } from '../utils/txNormalize';
import { generateSnapshot } from '../utils/snapshot';
import { getPlanDueDates } from '../utils/calculator';
import { latestNavPair } from '../utils/navPair';
import { computeFreshness } from '../utils/navFreshness';
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
  /** 写盘失败返回 false（存储空间不足/被禁用）——此时内存状态不变 */
  addPlatform: (name: string) => boolean;
  removePlatform: (id: string) => boolean;
  getPlatformById: (id: string) => Platform | undefined;

  // Actions - Funds
  /** 写盘失败返回 false（存储空间不足/被禁用）——此时内存状态不变 */
  addFund: (fund: Fund) => boolean;
  updateFund: (id: string, updates: Partial<Fund>) => boolean;
  removeFund: (id: string) => boolean;
  getFundById: (id: string) => Fund | undefined;
  /** 按基金名称重新分类所有基金类型（修正早期版本把 QDII/债券指数误判为"指数型"）；返回变化的基金数 */
  reclassifyFunds: () => number;

  // Actions - Transactions
  /** 写盘失败返回 false（存储空间不足/被禁用）——此时内存状态不变，
   *  界面不会显示"已保存"而磁盘里没有 */
  addTransaction: (tx: Transaction) => boolean;
  updateTransaction: (id: string, updates: Partial<Transaction>) => boolean;
  removeTransaction: (id: string) => boolean;
  /** 重算今日快照——交易变动后调用，保证组合趋势与账本一致 */
  regenerateTodaySnapshot: () => void;

  // Actions - DCA Plans
  /** 写盘失败返回 false（存储空间不足/被禁用）——此时内存状态不变 */
  addDcaPlan: (plan: DcaPlan) => boolean;
  updateDcaPlan: (id: string, updates: Partial<DcaPlan>) => boolean;
  removeDcaPlan: (id: string) => boolean;
  toggleDcaPlan: (id: string) => boolean;
  /** 把启用的定投计划按日程批量补成"待确认买入"交易记录；返回本次生成的笔数 */
  autoRecordDcaPlans: () => number;

  // Actions - Snapshots
  addSnapshot: (snapshot: DailySnapshot) => void;

  // Actions - Settings
  /** 写盘失败返回 false（存储空间不足/被禁用）——此时内存状态不变 */
  updateSettings: (updates: Partial<Settings>) => boolean;

  // Actions - Indices (市场指数缓存)
  indices: Record<string, IndexQuote>;
  updateIndex: (code: string, quote: IndexQuote) => void;

  // Actions - Index History (按 code 懒加载的历史每日收盘点位)
  indexHistories: Record<string, IndexHistoryRecord[]>;
  updateIndexHistory: (code: string, records: IndexHistoryRecord[]) => void;

  // Actions - Nav
  updateNavHistory: (fundCode: string, records: NavRecord[]) => void;
  getNavHistory: (fundCode: string) => NavRecord[];
  resetNavHistory: (fundCode?: string) => void;

  // Actions - Nav freshness (观测法：不推算发布日，只对比"上次刷新看到的最新 NAV 日")
  /** 本次刷新中"最新 NAV 日较上次前进"的基金 id 集合；未刷新过时为空集 */
  freshNavFundIds: Set<string>;
  /** 最近一次刷新完成时间（ISO 字符串）；null = 本次会话还没跑过刷新 */
  navRefreshedAt: string | null;
  /** 刷新结束后调用：对比并更新本地观测基线，产出 freshNavFundIds */
  recordNavFreshness: () => void;

  // Actions - Refresh trigger (App.tsx subscribes to bump to re-run refreshAll)
  refreshTrigger: number;
  requestRefresh: () => void;

  // Actions - Refresh issues（刷新失败上报；非持久化，见 types 的 FundRefreshIssue）
  refreshIssues: Record<string, FundRefreshIssue>;
  /** 整体替换本轮刷新的失败上报（空对象 = 全部成功） */
  setRefreshIssues: (issues: Record<string, FundRefreshIssue>) => void;
  /** 单只基金手动刷新成功后清除其上报 */
  clearRefreshIssue: (fundId: string) => void;

  // Actions - Init & Bulk
  loadFromStorage: () => void;
  exportData: () => void;
  /** 导入并覆盖全部数据；返回按定投计划自动生成的交易笔数；
   *  **-1 = 写盘失败**（存储空间不足）——此时内存状态未变，界面仍显示旧数据 */
  importData: (data: ReturnType<typeof storage.exportAllData>) => number;
}

export const useStore = create<FundTrackerState>((set, get) => ({
  platforms: [],
  funds: [],
  transactions: [],
  dcaPlans: [],
  snapshots: [],
  settings: storage.DEFAULT_SETTINGS,
  indices: {},
  indexHistories: {},
  freshNavFundIds: new Set<string>(),
  navRefreshedAt: null,

  // --- Platforms ---
  addPlatform: (name) => {
    const platform: Platform = { id: `platform-${Date.now()}`, name };
    const platforms = [...get().platforms, platform];
    // 写盘失败 → 不改内存状态（保持"内存 == 磁盘"）
    if (!storage.savePlatforms(platforms)) return false;
    set({ platforms });
    return true;
  },

  removePlatform: (id) => {
    const hasFund = get().funds.some((f) => f.platformId === id);
    if (hasFund) return false;
    const platforms = get().platforms.filter((p) => p.id !== id);
    if (!storage.savePlatforms(platforms)) return false;
    set({ platforms });
    return true;
  },

  getPlatformById: (id) => get().platforms.find((p) => p.id === id),

  // --- Funds ---
  addFund: (fund) => {
    const funds = [...get().funds, fund];
    if (!storage.saveFunds(funds)) return false;
    set({ funds });
    return true;
  },

  updateFund: (id, updates) => {
    const funds = get().funds.map((f) => (f.id === id ? { ...f, ...updates } : f));
    if (!storage.saveFunds(funds)) return false;
    set({ funds });
    return true;
  },

  removeFund: (id) => {
    const funds = get().funds.filter((f) => f.id !== id);
    // 先写最大的那份：配额不足时它先失败 → 后面几步不执行，状态保持原样
    if (!storage.saveFunds(funds)) return false;
    // Also remove transactions and nav history for this fund
    const transactions = get().transactions.filter((t) => t.fundId !== id);
    storage.saveTransactions(transactions);
    const dcaPlans = get().dcaPlans.filter((p) => p.fundId !== id);
    storage.saveDcaPlans(dcaPlans);
    navHistoryCache.delete(id);
    storage.removeNavHistory(id);

    // Regenerate today's snapshot to reflect the removal (skip on non-trading days)
    const newSnapshot = generateSnapshot(funds, transactions);
    const snapshots = get().snapshots.filter((s) => s.date !== today());
    if (newSnapshot) snapshots.push(newSnapshot);
    storage.saveSnapshots(snapshots);

    set({ funds, transactions, dcaPlans, snapshots });
    return true;
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
    // 写盘失败 → 不改内存状态：界面不会显示"已保存"而磁盘里没有
    if (!storage.saveTransactions(transactions)) return false;
    set({ transactions });
    return true;
  },

  updateTransaction: (id, updates) => {
    const transactions = get().transactions.map((t) => (t.id === id ? { ...t, ...updates } : t));
    if (!storage.saveTransactions(transactions)) return false;
    set({ transactions });
    return true;
  },

  removeTransaction: (id) => {
    const transactions = get().transactions.filter((t) => t.id !== id);
    if (!storage.saveTransactions(transactions)) return false;
    set({ transactions });
    return true;
  },

  // --- Snapshot ---
  regenerateTodaySnapshot: () => {
    const { funds, transactions } = get();
    const newSnapshot = generateSnapshot(funds, transactions);
    const snapshots = get().snapshots.filter((s) => s.date !== today());
    if (newSnapshot) snapshots.push(newSnapshot);
    storage.saveSnapshots(snapshots);
    set({ snapshots });
  },

  // --- DCA Plans ---
  addDcaPlan: (plan) => {
    const dcaPlans = [...get().dcaPlans, plan];
    if (!storage.saveDcaPlans(dcaPlans)) return false;
    set({ dcaPlans });
    return true;
  },

  updateDcaPlan: (id, updates) => {
    const dcaPlans = get().dcaPlans.map((p) => (p.id === id ? { ...p, ...updates } : p));
    if (!storage.saveDcaPlans(dcaPlans)) return false;
    set({ dcaPlans });
    return true;
  },

  removeDcaPlan: (id) => {
    const dcaPlans = get().dcaPlans.filter((p) => p.id !== id);
    if (!storage.saveDcaPlans(dcaPlans)) return false;
    set({ dcaPlans });
    return true;
  },

  toggleDcaPlan: (id) => {
    const dcaPlans = get().dcaPlans.map((p) =>
      p.id === id ? { ...p, active: !p.active } : p
    );
    if (!storage.saveDcaPlans(dcaPlans)) return false;
    set({ dcaPlans });
    return true;
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
    if (!storage.saveTransactions(updatedTransactions)) return 0;
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
    if (!storage.saveSettings(settings)) return false;
    set({ settings });
    return true;
  },

  // --- Indices ---
  updateIndex: (code, quote) => {
    const indices = { ...get().indices, [code]: quote };
    storage.saveIndices(indices);
    set({ indices });
  },

  // --- Index History ---
  // 写一次更新全部 map（与 updateIndex 同款语义），持久化到 storage 的 index-history:{code} 单 key。
  updateIndexHistory: (code, records) => {
    const indexHistories = { ...get().indexHistories, [code]: records };
    storage.saveIndexHistory(code, records);
    set({ indexHistories });
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

  // --- Refresh issues ---
  refreshIssues: {},

  setRefreshIssues: (issues) => {
    set({ refreshIssues: issues });
  },

  clearRefreshIssue: (fundId) => {
    set((s) => {
      if (!s.refreshIssues[fundId]) return s;
      const next = { ...s.refreshIssues };
      delete next[fundId];
      return { refreshIssues: next };
    });
  },

  // --- Nav freshness ---
  recordNavFreshness: () => {
    const { funds, getNavHistory, settings } = get();
    const mode = settings.usQdiiFilterMode;
    const { fresh, nextSeen } = computeFreshness(
      funds,
      // "最新 NAV 日"与盈亏数字同源：都走 latestNavPair，避免两处对"最新"的定义漂移
      (fund) => latestNavPair(fund, getNavHistory(fund.id), mode)?.curr.date,
      storage.getSeenNavMap()
    );
    storage.saveSeenNavMap(nextSeen);
    set({ freshNavFundIds: fresh, navRefreshedAt: new Date().toISOString() });
  },

  // --- Init & Bulk ---
  loadFromStorage: () => {
    navHistoryCache.clear();
    storage.initStorage();
    // 归一化「初始持仓」记录的 nav（它是成本单价、不是市场净值）——
    // 存量数据一次性纠正并落盘，之后不再变
    const rawTxs = storage.getTransactions();
    const transactions = normalizeInitialPositionNav(rawTxs);
    if (transactions !== rawTxs) storage.saveTransactions(transactions);
    set({
      platforms: storage.getPlatforms(),
      funds: storage.getFunds(),
      transactions,
      dcaPlans: storage.getDcaPlans(),
      snapshots: storage.getSnapshots(),
      settings: storage.getSettings(),
      indices: storage.getIndices(),
      indexHistories: storage.loadAllIndexHistories(),
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
    // 记录备份时间（设备本地 backup-meta，不参与导出）——备份提醒条据此判断超期
    const meta = storage.getBackupMeta();
    storage.saveBackupMeta({ ...meta, lastBackupAt: new Date().toISOString() });
  },

  importData: (data) => {
    navHistoryCache.clear();
    // 关键数据写盘失败（存储空间不足）→ 不更新内存状态，界面不会假装导入成功
    if (!storage.importAllData(data)) return -1;
    // 缺字段时 fallback 到默认值，避免整个 app 崩溃成空白页；
    // 手编 JSON / 旧备份可能缺 platforms|funds|transactions|dcaPlans|navs 之一。
    // settings 用默认值打底再覆盖导入值，兼容缺新字段（如 dcaAutoRecord）的老备份
    // （运行时备份可能缺失部分字段，故以 Partial 展开，避免 TS2783）
    const settings: Settings = { ...storage.DEFAULT_SETTINGS, ...(data.settings as Partial<Settings>) };
    set({
      platforms: data.platforms ?? [],
      funds: data.funds ?? [],
      transactions: data.transactions ?? [],
      dcaPlans: data.dcaPlans ?? [],
      snapshots: data.snapshots ?? [],
      settings,
      indices: storage.getIndices(),
      indexHistories: storage.loadAllIndexHistories(),
    });
    // 导入后基金集合已变，旧观测基线作废——重置为空，让下一次刷新重新建立
    set({ freshNavFundIds: new Set<string>(), navRefreshedAt: null });
    // 导入后立刻补定投记录（页面 mount 的自动记录早已跑过，导入不会重跑它）
    const autoCreated = get().settings.dcaAutoRecord ? get().autoRecordDcaPlans() : 0;
    // 导入成功 = 用户手上有有效备份文件，视为一次备份动作（刷新提醒条计时）
    const meta = storage.getBackupMeta();
    storage.saveBackupMeta({ ...meta, lastBackupAt: new Date().toISOString() });
    return autoCreated;
  },
}));
