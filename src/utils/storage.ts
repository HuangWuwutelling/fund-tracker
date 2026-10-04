import type { Platform, Fund, Transaction, DcaPlan, DailySnapshot, Settings, NavRecord, IndexQuote } from '../types';

const PREFIX = 'fund-tracker';
const CURRENT_VERSION = 2;

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
  { id: 'platform-morgan', name: '摩根' },
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
export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  navAutoRefresh: true,
  reportFrequency: 'both',
  dcaAutoRecord: true,
};

export function getSettings(): Settings {
  // 合并默认值：老数据缺新字段（如 dcaAutoRecord）时自动补齐，不依赖 storage 版本迁移
  return { ...DEFAULT_SETTINGS, ...getItem<Settings>('settings', DEFAULT_SETTINGS) };
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

export function removeNavHistory(fundCode: string): void {
  localStorage.removeItem(key(`nav:${fundCode}`));
}

export function removeAllNavHistory(): void {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(`${PREFIX}:nav:`)) {
      localStorage.removeItem(k);
    }
  }
}

// --- Seen NAV baseline (观测法新鲜度基线) ---
// key 故意不叫 `nav:*`：importAllData 会清理所有 `nav:` 前缀的残留 key，
// 而这份基线是**设备本地观测**而非用户数据，不参与 exportAllData / importAllData
// （换设备 / 导入备份后没有基线 → 首次观测全部视为"有新净值"，一次刷新后自愈）。
export function getSeenNavMap(): Record<string, string> {
  return getItem<Record<string, string>>('seen-nav', {});
}

export function saveSeenNavMap(map: Record<string, string>): void {
  setItem('seen-nav', map);
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
  /** v1 新增：指数最近一次成功拉取的快照；旧版本备份里没有此字段 */
  indices?: Record<string, IndexQuote>;
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
    indices: getIndices(),
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
  // indices 是 v1 新字段；旧版本备份里 data.indices === undefined 时取空 map
  // （清空本地 indices 而不是保留——因为旧备份的语义就是"完全替换状态"）。
  saveIndices(data.indices ?? {});
  if (data.navHistories) {
    // 完整备份：用备份内的净值历史覆盖
    for (const [fundCode, records] of Object.entries(data.navHistories)) {
      saveNavHistory(fundCode, records);
    }
    // 清理掉备份里没有、但本地还残留的旧 nav（避免孤儿数据干扰显示）
    const importedFundIds = new Set(Object.keys(data.navHistories));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`${PREFIX}:nav:`)) {
        const fundCode = k.slice(`${PREFIX}:nav:`.length);
        if (!importedFundIds.has(fundCode)) {
          localStorage.removeItem(k);
        }
      }
    }
  } else {
    // v0 备份没有 navHistories 字段 → 保留 localStorage 现有的净值历史作为后备
    // （这里什么都不做：save* 没有动 nav:* 这些 key，原有数据自然保留）
  }
}

// --- Indices cache ---
// 不参与 export/import 之外的"历史清理"流程（不像 navHistory 会被 importAllData 兜底删除），
// 是用户能看到的"上次看到什么"快照，导入备份后用备份里的值覆盖即可。
//
// 一次性迁移（2026-10）：v1.0 的 fetcher 走 pingzhongdata ETF（sh000300 → 510310 NAV ≈ 4.3 元），
// v1.1 改用腾讯 qt.gtimg.cn（sh000300 → 真实指数点位 4357+）。如果 cache 里 sh000300 的
// value 还在 < 100（ETF 形态），说明是旧 cache ——`shouldUpdateIndexQuote` 只看 date 字符串
// 比较、而新旧的 date 又恰好都是 2026-09-30，会一直拒写到下一个交易日。检测到就清掉，
// 让 refreshAll 当次拿到的真实点位直接写进去。
export function getIndices(): Record<string, IndexQuote> {
  const data = getItem<Record<string, IndexQuote>>('indices', {});
  const sh000300 = data.sh000300;
  if (sh000300 && sh000300.value > 0 && sh000300.value < 100) {
    localStorage.removeItem(key('indices'));
    return {};
  }
  return data;
}

export function saveIndices(map: Record<string, IndexQuote>): void {
  setItem('indices', map);
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
}
