import { describe, it, expect } from 'vitest';
import { classifyBackupContent, isAutoBackupDue, backupMetaAfterWrite } from './autoBackup';

describe('classifyBackupContent（备份文件内容分类，选文件守卫）', () => {
  const validBackup = JSON.stringify({
    version: 2,
    platforms: [],
    funds: [{ id: '016452', name: 'x' }],
    transactions: [],
    navHistories: {},
  });

  it('空文本 / 纯空白 → empty（新建文件，无需确认）', () => {
    expect(classifyBackupContent('')).toBe('empty');
    expect(classifyBackupContent('   \n\t ')).toBe('empty');
  });

  it('本应用备份（数字 version + 数组 funds）→ backup', () => {
    expect(classifyBackupContent(validBackup)).toBe('backup');
  });

  it('JSON 但缺标记字段（其他工具的配置）→ foreign-json', () => {
    expect(classifyBackupContent('{"name":"demo","items":[1,2]}')).toBe('foreign-json');
  });

  it('version 是字符串（伪造/旧格式）→ foreign-json', () => {
    expect(classifyBackupContent('{"version":"2","funds":[]}')).toBe('foreign-json');
  });

  it('顶层数组 → foreign-json', () => {
    expect(classifyBackupContent('[1,2,3]')).toBe('foreign-json');
  });

  it('null 字面量 → foreign-json', () => {
    expect(classifyBackupContent('null')).toBe('foreign-json');
  });

  it('非 JSON（截断 / 其他格式）→ invalid', () => {
    expect(classifyBackupContent('<html>404</html>')).toBe('invalid');
    expect(classifyBackupContent('{"version":2,"funds":[')).toBe('invalid');
    expect(classifyBackupContent('not json at all')).toBe('invalid');
  });

  it('version 存在但 funds 缺失 → foreign-json（保守判定，宁可多一次确认）', () => {
    expect(classifyBackupContent('{"version":2}')).toBe('foreign-json');
  });
});

/* ============================================================
 *  isAutoBackupDue —— 自动备份到期判定
 * ============================================================ */

describe('isAutoBackupDue（自动备份到期判定）', () => {
  const NEVER = { lastBackupAt: null, lastAutoBackupAt: null };
  const NOW = Date.parse('2026-11-20T00:00:00.000Z');

  it('days=0 → 自动备份已关闭，永不到期', () => {
    expect(isAutoBackupDue(0, NEVER, NOW)).toBe(false);
  });

  it('从未自动备份过 → 立即到期', () => {
    expect(isAutoBackupDue(7, NEVER, NOW)).toBe(true);
  });

  it('距上次自动备份不足周期 → 未到期', () => {
    const meta = { lastBackupAt: null, lastAutoBackupAt: '2026-11-18T00:00:00.000Z' };
    expect(isAutoBackupDue(7, meta, NOW)).toBe(false);
  });

  it('距上次自动备份超过周期 → 到期', () => {
    const meta = { lastBackupAt: null, lastAutoBackupAt: '2026-11-10T00:00:00.000Z' };
    expect(isAutoBackupDue(7, meta, NOW)).toBe(true);
  });

  it('到期只看自动备份时间，与手动备份时间无关（手动导出不推迟自动备份）', () => {
    const meta = {
      lastBackupAt: '2026-11-19T00:00:00.000Z',
      lastAutoBackupAt: '2026-11-10T00:00:00.000Z',
    };
    expect(isAutoBackupDue(7, meta, NOW)).toBe(true);
  });

  it('周期天数可精细到 1 天（自动备份周期与手动提醒周期各自独立）', () => {
    const meta = { lastBackupAt: null, lastAutoBackupAt: '2026-11-19T00:00:00.000Z' };
    expect(isAutoBackupDue(1, meta, NOW)).toBe(true);
    expect(isAutoBackupDue(7, meta, NOW)).toBe(false);
  });
});

/* ============================================================
 *  backupMetaAfterWrite —— 自动备份写盘后的备份时间更新
 * ============================================================ */

describe('backupMetaAfterWrite（自动备份写盘成功后刷新备份时间）', () => {
  const AT = '2026-11-20T10:00:00.000Z';

  it('写盘成功 → 同时刷新 lastBackupAt 与 lastAutoBackupAt', () => {
    expect(backupMetaAfterWrite({ lastBackupAt: null, lastAutoBackupAt: null }, AT)).toEqual({
      lastBackupAt: AT,
      lastAutoBackupAt: AT,
    });
  });

  it('已有的手动备份时间也被刷新（自动备份同样是"备份"，提醒条不该继续报警）', () => {
    const next = backupMetaAfterWrite(
      { lastBackupAt: '2026-01-01T00:00:00.000Z', lastAutoBackupAt: null },
      AT,
    );
    expect(next.lastBackupAt).toBe(AT);
    expect(next.lastAutoBackupAt).toBe(AT);
  });
});
