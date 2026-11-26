import type { Platform, Fund, Transaction, DcaPlan, DailySnapshot } from '../types';

/**
 * 备份文件的**预检**。
 *
 * 为什么需要：导入是**覆盖**操作——整个账本被备份文件替换。而在此之前，
 * 校验只做到「顶层是不是数组」这一层，于是：
 * - 一个**来自更新版本**的备份（带当前版本不认识的字段）会被照单全收；
 * - 一份 `dcaPlans` 里某条记录字段类型不对的文件能通过校验，被原样写进账本；
 * - 最要命的是：用户**看不到导入后会冲掉什么**。备份是上周的，这周的交易
 *   就这么没了——而界面只告诉他"将覆盖当前所有数据：基金 15 个、交易 200 笔"。
 *
 * 本模块把三件事做成**可测的纯函数**：
 * 1. **版本检查** —— 备份来自更新 / 更旧的版本，分别提示什么
 * 2. **逐表校验** —— 精确到「哪张表、第几条、哪个字段」
 * 3. **导入差异** —— 导入后每张表变成什么样、哪些基金连同其交易会消失
 *
 * 它**只读不写**：不做任何写盘，也不读 localStorage。数据由调用方给。
 */

/** 校验 / 提示的级别。error → 不允许导入；warn → 允许但要让人看见 */
export type BackupIssueLevel = 'error' | 'warn';

export interface BackupIssue {
  level: BackupIssueLevel;
  /** 哪张表（中文名） */
  table: string;
  /** 第几条（1 起）；表级问题为 undefined */
  index?: number;
  /** 什么问题 */
  message: string;
}

export interface BackupCounts {
  platforms: number;
  funds: number;
  transactions: number;
  dcaPlans: number;
  snapshots: number;
  /** 净值历史覆盖了几只基金 */
  navHistoryFunds: number;
}

/** 当前设备上的数据（用来算差异） */
export interface CurrentBackupData {
  platforms: Platform[];
  funds: Fund[];
  transactions: Transaction[];
  dcaPlans: DcaPlan[];
  snapshots: DailySnapshot[];
}

export interface BackupDiff {
  /** 每张表：当前 N 条 → 备份 M 条 */
  tables: { table: string; current: number; incoming: number }[];
  /** 导入后会消失的基金 id（当前有、备份没有） */
  fundsLost: string[];
  /** 导入后新增的基金 id（备份有、当前没有） */
  fundsGained: string[];
  /** 随上面那些基金一起消失的当前交易笔数 */
  transactionsLostWithFunds: number;
}

export interface BackupReport {
  /** 有 error 级问题 → false，不允许导入 */
  ok: boolean;
  /** 备份文件的版本号；老备份没有这个字段 → null */
  version: number | null;
  /** 当前应用认识的版本号 */
  currentVersion: number;
  counts: BackupCounts;
  issues: BackupIssue[];
  /** 与当前数据的差异；没给 current 时为 null */
  diff: BackupDiff | null;
}

/**
 * 当前应用认识的备份版本号。
 *
 * 与 `utils/storage.ts` 的 `CURRENT_VERSION` 保持一致——那是 localStorage 的
 * schema 版本，备份文件的 `version` 字段写的就是它（见 exportAllData）。
 */
export const CURRENT_BACKUP_VERSION = 2;

// --- 小工具 ---

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function isNum(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 校验一列数组。返回数组长度（哪怕里面有几条是坏的——计数要如实反映文件内容）。
 *
 * `validate` 返回错误描述（null = 这条没问题）。
 */
function checkArray(
  data: Record<string, unknown>,
  key: string,
  label: string,
  required: boolean,
  issues: BackupIssue[],
  validate: (item: Record<string, unknown>) => string | null,
): number {
  const raw = data[key];
  if (raw === undefined) {
    if (required) {
      issues.push({ level: 'error', table: label, message: '字段缺失' });
    }
    return 0;
  }
  if (!Array.isArray(raw)) {
    issues.push({ level: 'error', table: label, message: '必须是数组' });
    return 0;
  }
  raw.forEach((item, i) => {
    if (!isObj(item)) {
      issues.push({ level: 'error', table: label, index: i + 1, message: '不是对象' });
      return;
    }
    const err = validate(item);
    if (err) {
      issues.push({ level: 'error', table: label, index: i + 1, message: err });
    }
  });
  return raw.length;
}

/** 校验「对象 → 数组」的映射（navHistories / indexHistories） */
function checkRecordOfArrays(
  data: Record<string, unknown>,
  key: string,
  label: string,
  issues: BackupIssue[],
  validateItem: (item: unknown) => string | null,
): number {
  const raw = data[key];
  if (raw === undefined) return 0;
  if (!isObj(raw)) {
    issues.push({ level: 'error', table: label, message: '必须是对象' });
    return 0;
  }
  let count = 0;
  for (const [name, value] of Object.entries(raw)) {
    count++;
    if (!Array.isArray(value)) {
      issues.push({ level: 'error', table: label, message: `${name} 的值不是数组` });
      continue;
    }
    value.forEach((item, i) => {
      const err = validateItem(item);
      if (err) {
        issues.push({ level: 'error', table: label, index: i + 1, message: `${name}：${err}` });
      }
    });
  }
  return count;
}

/**
 * 检查一份备份文件能不能导入，以及导入后会发生什么。
 *
 * @param data    解析出来的 JSON（类型未知）
 * @param current 当前设备上的数据；给了才算差异
 * @param currentVersion 当前应用认识的备份版本号
 */
export function checkBackup(
  data: unknown,
  current?: CurrentBackupData,
  currentVersion: number = CURRENT_BACKUP_VERSION,
): BackupReport {
  const issues: BackupIssue[] = [];

  if (!isObj(data)) {
    issues.push({ level: 'error', table: '文件', message: '顶层必须是对象' });
    return {
      ok: false, version: null, currentVersion,
      counts: { platforms: 0, funds: 0, transactions: 0, dcaPlans: 0, snapshots: 0, navHistoryFunds: 0 },
      issues, diff: null,
    };
  }

  // ── 版本 ────────────────────────────────────────────────────────
  const version = typeof data.version === 'number' && Number.isFinite(data.version) ? data.version : null;
  if (version === null) {
    issues.push({
      level: 'warn', table: '版本',
      message: `备份文件没有版本号（可能是很早的备份），将按当前版本 v${currentVersion} 导入`,
    });
  } else if (version > currentVersion) {
    issues.push({
      level: 'warn', table: '版本',
      message: `备份来自更新版本的应用（v${version} > 当前 v${currentVersion}），可能包含当前版本不认识的字段`,
    });
  } else if (version < currentVersion) {
    issues.push({
      level: 'warn', table: '版本',
      message: `备份来自旧版本（v${version} < 当前 v${currentVersion}），缺失的字段将按默认值处理`,
    });
  }

  // ── 逐表校验 ────────────────────────────────────────────────────
  const platforms = checkArray(data, 'platforms', '平台', true, issues, (p) => {
    if (!isStr(p.id)) return 'id 必须是字符串';
    if (!isStr(p.name)) return 'name 必须是字符串';
    return null;
  });

  const funds = checkArray(data, 'funds', '基金', true, issues, (f) => {
    if (!isStr(f.id)) return 'id 必须是字符串';
    if (!isStr(f.name)) return 'name 必须是字符串';
    if (!isStr(f.platformId)) return 'platformId 必须是字符串';
    if (!isNum(f.currentNav)) return 'currentNav 必须是数字';
    if (!isStr(f.navDate)) return 'navDate 必须是字符串';
    return null;
  });

  const transactions = checkArray(data, 'transactions', '交易', true, issues, (t) => {
    if (!isStr(t.id)) return 'id 必须是字符串';
    if (!isStr(t.fundId)) return 'fundId 必须是字符串';
    if (!isStr(t.type)) return 'type 必须是字符串';
    if (!isStr(t.date)) return 'date 必须是字符串';
    if (!isNum(t.amount)) return 'amount 必须是数字';
    if (!isNum(t.fee)) return 'fee 必须是数字';
    if (!isNum(t.shares)) return 'shares 必须是数字';
    if (!isNum(t.nav)) return 'nav 必须是数字';
    return null;
  });

  const dcaPlans = checkArray(data, 'dcaPlans', '定投计划', true, issues, (p) => {
    if (!isStr(p.id)) return 'id 必须是字符串';
    if (!isStr(p.fundId)) return 'fundId 必须是字符串';
    if (!isNum(p.amount)) return 'amount 必须是数字';
    if (!isStr(p.frequency)) return 'frequency 必须是字符串';
    if (!isStr(p.startDate)) return 'startDate 必须是字符串';
    return null;
  });

  const snapshots = checkArray(data, 'snapshots', '快照', false, issues, (s) => {
    if (!isStr(s.date)) return 'date 必须是字符串';
    if (!isNum(s.totalValue)) return 'totalValue 必须是数字';
    if (!isNum(s.totalCost)) return 'totalCost 必须是数字';
    return null;
  });

  const navHistoryFunds = checkRecordOfArrays(data, 'navHistories', '净值历史', issues, (item) => {
    if (!isObj(item)) return '不是对象';
    if (!isStr(item.date)) return 'date 必须是字符串';
    if (!isNum(item.nav)) return 'nav 必须是数字';
    if (!isNum(item.accNav)) return 'accNav 必须是数字';
    return null;
  });

  if (data.settings !== undefined && !isObj(data.settings)) {
    issues.push({ level: 'error', table: '设置', message: '必须是对象' });
  }
  if (data.indices !== undefined && !isObj(data.indices)) {
    issues.push({ level: 'error', table: '指数行情', message: '必须是对象' });
  }
  checkRecordOfArrays(data, 'indexHistories', '指数历史', issues, (item) => {
    if (!isObj(item)) return '不是对象';
    if (!isStr(item.date)) return 'date 必须是字符串';
    if (!isNum(item.value)) return 'value 必须是数字';
    return null;
  });

  const counts: BackupCounts = {
    platforms, funds, transactions, dcaPlans, snapshots, navHistoryFunds,
  };

  // ── 差异 ────────────────────────────────────────────────────────
  const diff = current ? diffBackup(current, data, counts) : null;

  return {
    ok: !issues.some((i) => i.level === 'error'),
    version,
    currentVersion,
    counts,
    issues,
    diff,
  };
}

/** 算出导入后每张表变成什么样、哪些东西会消失 */
function diffBackup(
  current: CurrentBackupData,
  data: Record<string, unknown>,
  counts: BackupCounts,
): BackupDiff {
  const incomingFundIds = new Set(
    Array.isArray(data.funds)
      ? data.funds.filter(isObj).map((f) => (isStr(f.id) ? f.id : '')).filter(Boolean)
      : [],
  );
  const currentFundIds = new Set(current.funds.map((f) => f.id));

  const fundsLost = [...currentFundIds].filter((id) => !incomingFundIds.has(id));
  const fundsGained = [...incomingFundIds].filter((id) => !currentFundIds.has(id));
  const lostSet = new Set(fundsLost);
  const transactionsLostWithFunds = current.transactions.filter((t) => lostSet.has(t.fundId)).length;

  return {
    tables: [
      { table: '平台', current: current.platforms.length, incoming: counts.platforms },
      { table: '基金', current: current.funds.length, incoming: counts.funds },
      { table: '交易', current: current.transactions.length, incoming: counts.transactions },
      { table: '定投计划', current: current.dcaPlans.length, incoming: counts.dcaPlans },
      { table: '快照', current: current.snapshots.length, incoming: counts.snapshots },
    ],
    fundsLost,
    fundsGained,
    transactionsLostWithFunds,
  };
}
