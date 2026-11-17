import { describe, it, expect } from 'vitest';
import { classifyBackupContent } from './autoBackup';

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
