import * as storage from './storage';

/**
 * File System Access API 自动备份（实验性）。
 *
 * 流程：用户在 Settings 用 showSaveFilePicker 选定一个固定备份文件 →
 * FileSystemFileHandle 存 IndexedDB（刷新/重启后仍可复用）→ 应用启动时
 * 若距上次自动备份已到周期且权限为 granted，静默全量写入该文件。
 *
 * 浏览器约束（Chrome/Edge 支持，Firefox/Safari 无此 API）：
 * - 权限持久化：每次会话首次写入前需 queryPermission；若为 'prompt' 需要一次
 *   用户手势 requestPermission（UI 层用 Layout 顶部的提醒条按钮承接）。
 * - 纯本地写盘：不改变"数据不上传任何服务器"的承诺。
 * - handle 存 IndexedDB 而非 localStorage：FileSystemFileHandle 可结构化克隆，
 *   localStorage 存不了；也顺便与备份 JSON 内容隔离。
 */

const AUTO_BACKUP_FILENAME = 'fund-tracker-backup-latest.json';
const HANDLE_DB_NAME = 'fund-tracker-fs';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'backup-file';

// --- 最小类型声明（不依赖 lib.dom 的 File System Access 版本差异） ---
interface WritableLike {
  write(data: string | Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
}
export interface AutoBackupFileHandle {
  name: string;
  /** 读取既有文件内容（选文件守卫的 inspect 用） */
  getFile(): Promise<{ size: number; text(): Promise<string> }>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
  /** Chrome 扩展 API，标准 lib.dom 无类型——可用性由 isAutoBackupSupported 统一守卫 */
  queryPermission(desc?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(desc?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}
type ShowSaveFilePicker = (options?: {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}) => Promise<AutoBackupFileHandle>;

/** File System Access API 是否可用（Chrome/Edge 86+；Firefox/Safari 返回 false，UI 据此隐藏功能） */
export function isAutoBackupSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker === 'function';
}

function getPicker(): ShowSaveFilePicker | null {
  return (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker ?? null;
}

// --- 极简 IndexedDB 封装（只存一个 handle，不引依赖） ---
function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(HANDLE_DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(HANDLE_STORE);
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(HANDLE_STORE, mode);
      let request: IDBRequest<T> | void;
      try {
        request = fn(tx.objectStore(HANDLE_STORE));
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => {
        db.close();
        resolve(request && 'result' in request ? request.result : undefined);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

export async function getSavedBackupHandle(): Promise<AutoBackupFileHandle | null> {
  try {
    const handle = await withStore<AutoBackupFileHandle>('readonly', (store) => store.get(HANDLE_KEY) as IDBRequest<AutoBackupFileHandle>);
    return handle ?? null;
  } catch {
    return null;
  }
}

export async function saveBackupHandle(handle: AutoBackupFileHandle): Promise<void> {
  await withStore('readwrite', (store) => { store.put(handle, HANDLE_KEY); });
}

export async function clearBackupHandle(): Promise<void> {
  await withStore('readwrite', (store) => { store.delete(HANDLE_KEY); });
}

/** 用户选定固定备份文件（showSaveFilePicker：选已有文件或新建）。
 *  **不在此持久化 handle**——调用方应先用 inspectBackupTarget 检查既有内容
 *  （非本应用备份需确认覆盖），确认后再 saveBackupHandle。 */
export async function pickBackupTarget(): Promise<AutoBackupFileHandle | null> {
  const picker = getPicker();
  if (!picker) return null;
  return await picker({
    suggestedName: AUTO_BACKUP_FILENAME,
    types: [{ description: 'JSON 备份文件', accept: { 'application/json': ['.json'] } }],
  });
}

/* ------------------------- 内容分类（选文件守卫） ------------------------- */

/** 选定文件的既有内容分类 */
export type BackupContentKind =
  | 'empty'        // 空文件 / 新建 → 无需确认
  | 'backup'       // 本应用备份（version 数字 + funds 数组）→ 无需确认
  | 'foreign-json' // JSON 但不是本应用备份 → 需确认覆盖
  | 'invalid';     // 非 JSON → 需确认覆盖

/** 纯函数：按文本内容判断是否为本应用备份（独立可测，浏览器 API 不参与）。
 *  备份标记：顶层对象含数字 version + 数组 funds（exportAllData 的结构特征）。 */
export function classifyBackupContent(text: string): BackupContentKind {
  if (!text || text.trim().length === 0) return 'empty';
  try {
    const obj = JSON.parse(text) as unknown;
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 'foreign-json';
    const o = obj as Record<string, unknown>;
    return typeof o.version === 'number' && Array.isArray(o.funds) ? 'backup' : 'foreign-json';
  } catch {
    return 'invalid';
  }
}

/** 读取 handle 指向文件的现有内容并分类（读取异常按 'empty' 处理——宁可少一次确认） */
export async function inspectBackupTarget(handle: AutoBackupFileHandle): Promise<BackupContentKind> {
  try {
    const file = await handle.getFile();
    if (file.size === 0) return 'empty';
    return classifyBackupContent(await file.text());
  } catch {
    return 'empty';
  }
}

export type AutoBackupPermission = 'granted' | 'prompt' | 'denied' | 'none' | 'unsupported';

/** 当前自动备份权限状态：none = 未设置备份文件 */
export async function queryAutoBackupPermission(): Promise<AutoBackupPermission> {
  if (!isAutoBackupSupported()) return 'unsupported';
  const handle = await getSavedBackupHandle();
  if (!handle) return 'none';
  try {
    return (await handle.queryPermission({ mode: 'readwrite' })) as AutoBackupPermission;
  } catch {
    return 'denied';
  }
}

/* ------------------------------- 写盘路径 ------------------------------- */

/** 单一写盘实现：全量导出 → 原子写入 → 记录 lastAutoBackupAt。
 *  createWritable 默认空内容 + close 原子替换——写一半崩溃不会损坏原文件。
 *  两条入口（静默 / 手势）共用，避免导出格式变更时只改一处造成行为漂移。 */
async function writeBackupToHandle(handle: AutoBackupFileHandle): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(storage.exportAllData(), null, 2));
  await writable.close();
  const meta = storage.getBackupMeta();
  storage.saveBackupMeta({ ...meta, lastAutoBackupAt: new Date().toISOString() });
}

/**
 * 静默自动备份（应用启动 / 定时）：权限已 granted 才写。
 * 返回 false = 未设置 handle / 权限不足 / 写入失败（调用方决定 UI 反馈）。
 */
export async function runAutoBackup(): Promise<boolean> {
  const handle = await getSavedBackupHandle();
  if (!handle) return false;
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return false;
    await writeBackupToHandle(handle);
    return true;
  } catch (err) {
    console.error('[autoBackup] write failed', err);
    return false;
  }
}

/**
 * 手势链路（按钮点击）的一次性分派：读一次 handle、一次 queryPermission 后分支——
 * - granted：直接写
 * - prompt：**尽早** requestPermission（手势链中间不隔多余 await，降低
 *   transient activation 过期风险），授权成功即写
 * - denied：返回 false
 */
export async function backupNowWithGesture(): Promise<boolean> {
  const handle = await getSavedBackupHandle();
  if (!handle) return false;
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      await writeBackupToHandle(handle);
      return true;
    }
    if (perm === 'prompt') {
      if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
      await writeBackupToHandle(handle);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[autoBackup] gesture backup failed', err);
    return false;
  }
}

/** 距上次自动备份是否已到周期（days <= 0 = 功能视为关闭；从未备份过 = 立即到期） */
export function isAutoBackupDue(days: number): boolean {
  if (days <= 0) return false;
  const meta = storage.getBackupMeta();
  if (!meta.lastAutoBackupAt) return true;
  return Date.now() - new Date(meta.lastAutoBackupAt).getTime() >= days * 86400000;
}
