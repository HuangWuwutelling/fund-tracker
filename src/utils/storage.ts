import type { Platform, Fund, Transaction, DcaPlan, DailySnapshot, Settings, NavRecord } from '../types';

const PREFIX = 'fund-tracker';
const CURRENT_VERSION = 1;

function key(name: string): string {
  return `${PREFIX}:${name}`;
}

function getItem<T>(name: string, fallback: T): T {
  const raw = localStorage.getItem(key(name));
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function setItem<T>(name: string, value: T): void {
  localStorage.setItem(key(name), JSON.stringify(value));
}

// --- Version ---
export function getVersion(): number {
  return getItem<number>('version', 0);
}

export function setVersion(v: number): void {
  setItem('version', v);
}

// --- Platforms ---
const DEFAULT_PLATFORMS: Platform[] = [
  { id: 'platform-nanfang', name: '南方基金' },
  { id: 'platform-morgan', name: '摩根资产管理' },
  { id: 'platform-guangfa', name: '广发基金' },
];

export function getPlatforms(): Platform[] {
  return getItem<Platform[]>('platforms', DEFAULT_PLATFORMS);
}

export function savePlatforms(platforms: Platform[]): void {
  setItem('platforms', platforms);
}

// --- Funds ---
export function getFunds(): Fund[] {
  return getItem<Fund[]>('funds', []);
}

export function saveFunds(funds: Fund[]): void {
  setItem('funds', funds);
}

// --- Transactions ---
export function getTransactions(): Transaction[] {
  return getItem<Transaction[]>('transactions', []);
}

export function saveTransactions(transactions: Transaction[]): void {
  setItem('transactions', transactions);
}

// --- DCA Plans ---
export function getDcaPlans(): DcaPlan[] {
  return getItem<DcaPlan[]>('dca-plans', []);
}

export function saveDcaPlans(plans: DcaPlan[]): void {
  setItem('dca-plans', plans);
}

// --- Snapshots ---
export function getSnapshots(): DailySnapshot[] {
  return getItem<DailySnapshot[]>('snapshots', []);
}

export function saveSnapshots(snapshots: DailySnapshot[]): void {
  setItem('snapshots', snapshots);
}

// --- Settings ---
const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  navAutoRefresh: true,
  reportFrequency: 'both',
};

export function getSettings(): Settings {
  return getItem<Settings>('settings', DEFAULT_SETTINGS);
}

export function saveSettings(settings: Settings): void {
  setItem('settings', settings);
}

// --- Nav History (per fund) ---
export function getNavHistory(fundCode: string): NavRecord[] {
  return getItem<NavRecord[]>(`nav:${fundCode}`, []);
}

export function saveNavHistory(fundCode: string, records: NavRecord[]): void {
  setItem(`nav:${fundCode}`, records);
}

// --- Export / Import ---
interface ExportData {
  version: number;
  platforms: Platform[];
  funds: Fund[];
  transactions: Transaction[];
  dcaPlans: DcaPlan[];
  snapshots: DailySnapshot[];
  settings: Settings;
  navHistories: Record<string, NavRecord[]>;
}

export function exportAllData(): ExportData {
  const funds = getFunds();
  const navHistories: Record<string, NavRecord[]> = {};
  for (const fund of funds) {
    navHistories[fund.id] = getNavHistory(fund.id);
  }

  return {
    version: getVersion(),
    platforms: getPlatforms(),
    funds,
    transactions: getTransactions(),
    dcaPlans: getDcaPlans(),
    snapshots: getSnapshots(),
    settings: getSettings(),
    navHistories,
  };
}

export function importAllData(data: ExportData): void {
  setVersion(data.version ?? CURRENT_VERSION);
  savePlatforms(data.platforms);
  saveFunds(data.funds);
  saveTransactions(data.transactions);
  saveDcaPlans(data.dcaPlans);
  saveSnapshots(data.snapshots);
  saveSettings(data.settings);
  if (data.navHistories) {
    for (const [fundCode, records] of Object.entries(data.navHistories)) {
      saveNavHistory(fundCode, records);
    }
  }
}

// --- Init ---
export function initStorage(): void {
  const version = getVersion();
  if (version === 0) {
    setVersion(CURRENT_VERSION);
    // First time: ensure default platforms exist
    const platforms = getPlatforms();
    if (platforms.length === 0) {
      savePlatforms(DEFAULT_PLATFORMS);
    }
  }
  // Future: add migration logic here when CURRENT_VERSION > 1
}
