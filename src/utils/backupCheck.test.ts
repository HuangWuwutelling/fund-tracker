import { describe, it, expect } from 'vitest';
import { checkBackup, CURRENT_BACKUP_VERSION, type CurrentBackupData } from './backupCheck';

/**
 * 备份预检的测试。
 *
 * 导入是**覆盖**操作。此前校验只做到「顶层是不是数组」，于是：
 * - 来自更新版本的备份被照单全收
 * - 某张表里一条字段类型不对的记录能通过校验、被原样写进账本
 * - 用户看不到导入后会冲掉什么（备份是上周的，这周的交易就这么没了）
 */

/** 一份结构完整、可以导入的备份 */
function goodBackup(over: Record<string, unknown> = {}) {
  return {
    version: CURRENT_BACKUP_VERSION,
    platforms: [{ id: 'p1', name: '南方基金' }],
    funds: [
      { id: '008163', name: '测试基金', platformId: 'p1', type: 'mixed', currentNav: 1.2, navDate: '2026-11-20' },
    ],
    transactions: [
      { id: 't1', fundId: '008163', type: 'buy', date: '2026-08-26', amount: 1575, fee: 0, shares: 1502.8626, nav: 1.048 },
    ],
    dcaPlans: [
      { id: 'd1', fundId: '008163', amount: 100, frequency: 'monthly', dayOfMonth: 1, active: true, startDate: '2026-01-01' },
    ],
    snapshots: [{ date: '2026-11-20', totalValue: 1800, totalCost: 1575 }],
    navHistories: { '008163': [{ date: '2026-08-26', nav: 1.048, accNav: 1.048 }] },
    ...over,
  };
}

/** 当前设备上的数据 */
function currentData(): CurrentBackupData {
  return {
    platforms: [{ id: 'p1', name: '南方基金' }],
    funds: [
      { id: '008163', name: '测试基金', platformId: 'p1', type: 'mixed', currentNav: 1.2, navDate: '2026-11-20' },
      { id: '160140', name: '另一只基金', platformId: 'p1', type: 'index', currentNav: 1.5, navDate: '2026-11-20' },
    ],
    transactions: [
      { id: 't1', fundId: '008163', type: 'buy', date: '2026-08-26', amount: 1575, fee: 0, shares: 1502.8626, nav: 1.048 },
      { id: 't2', fundId: '160140', type: 'buy', date: '2026-11-01', amount: 800, fee: 0, shares: 533.3333, nav: 1.5 },
    ],
    dcaPlans: [],
    snapshots: [],
  };
}

describe('checkBackup —— 版本检查', () => {
  it('版本号与当前一致 → 没有版本相关的提示', () => {
    const report = checkBackup(goodBackup());
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.table === '版本')).toHaveLength(0);
    expect(report.version).toBe(CURRENT_BACKUP_VERSION);
  });

  it('备份来自更新版本 → 警告（仍然允许导入）', () => {
    const report = checkBackup(goodBackup({ version: CURRENT_BACKUP_VERSION + 1 }));
    expect(report.ok).toBe(true);
    const v = report.issues.find((i) => i.table === '版本');
    expect(v?.level).toBe('warn');
    expect(v?.message).toContain('更新版本');
  });

  it('备份来自旧版本 → 警告（缺失字段按默认值处理）', () => {
    const report = checkBackup(goodBackup({ version: 1 }));
    expect(report.ok).toBe(true);
    const v = report.issues.find((i) => i.table === '版本');
    expect(v?.level).toBe('warn');
    expect(v?.message).toContain('旧版本');
  });

  it('备份没有版本号（很早的备份）→ 警告', () => {
    const b = goodBackup();
    delete (b as Record<string, unknown>).version;
    const report = checkBackup(b);
    expect(report.ok).toBe(true);
    expect(report.version).toBeNull();
    expect(report.issues.find((i) => i.table === '版本')?.message).toContain('没有版本号');
  });
});

describe('checkBackup —— 逐表校验（精确到第几条）', () => {
  it('结构完整 → 通过', () => {
    const report = checkBackup(goodBackup());
    expect(report.ok).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it('顶层不是对象 → 阻断', () => {
    expect(checkBackup('nope').ok).toBe(false);
    expect(checkBackup(null).ok).toBe(false);
    expect(checkBackup([]).ok).toBe(false);
  });

  it('必填表缺失 → 阻断', () => {
    const b = goodBackup();
    delete (b as Record<string, unknown>).transactions;
    const report = checkBackup(b);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.table === '交易' && i.message === '字段缺失')).toBe(true);
  });

  it('可选表缺失不算错（snapshots / navHistories / settings）', () => {
    const b = goodBackup();
    delete (b as Record<string, unknown>).snapshots;
    delete (b as Record<string, unknown>).navHistories;
    delete (b as Record<string, unknown>).settings;
    expect(checkBackup(b).ok).toBe(true);
  });

  it('交易里第 2 条的 amount 不是数字 → 精确报到第 2 条', () => {
    const b = goodBackup();
    (b.transactions as unknown[]).push({
      id: 't2', fundId: '008163', type: 'buy', date: '2026-11-01',
      amount: '八百', fee: 0, shares: 100, nav: 1.2,
    });
    const report = checkBackup(b);
    expect(report.ok).toBe(false);
    const issue = report.issues.find((i) => i.table === '交易');
    expect(issue?.index).toBe(2);
    expect(issue?.message).toContain('amount');
  });

  it('定投计划的字段类型不对 → 精确报到那一条', () => {
    const b = goodBackup();
    (b.dcaPlans as unknown[])[0] = { id: 'd1', fundId: '008163', amount: '一百', frequency: 'monthly', startDate: '2026-01-01' };
    const report = checkBackup(b);
    expect(report.ok).toBe(false);
    const issue = report.issues.find((i) => i.table === '定投计划');
    expect(issue?.index).toBe(1);
    expect(issue?.message).toContain('amount');
  });

  it('净值历史里某条的 accNav 不是数字 → 报错', () => {
    const b = goodBackup();
    (b.navHistories as Record<string, unknown>)['008163'] = [{ date: '2026-08-26', nav: 1.048 }];
    const report = checkBackup(b);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.table === '净值历史' && i.message.includes('accNav'))).toBe(true);
  });

  it('设置不是对象 → 阻断', () => {
    const report = checkBackup(goodBackup({ settings: 'dark' }));
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.table === '设置')).toBe(true);
  });
});

describe('checkBackup —— 计数', () => {
  it('每张表的条数如实反映文件内容', () => {
    const report = checkBackup(goodBackup());
    expect(report.counts.platforms).toBe(1);
    expect(report.counts.funds).toBe(1);
    expect(report.counts.transactions).toBe(1);
    expect(report.counts.dcaPlans).toBe(1);
    expect(report.counts.snapshots).toBe(1);
    expect(report.counts.navHistoryFunds).toBe(1);
  });

  it('坏掉的条目也计入条数（计数要如实反映文件内容）', () => {
    const b = goodBackup();
    (b.transactions as unknown[]).push({ id: 't2', amount: 'x' });
    const report = checkBackup(b);
    expect(report.counts.transactions).toBe(2);
    expect(report.ok).toBe(false);
  });
});

describe('checkBackup —— 导入差异（导入后会冲掉什么）', () => {
  it('没给 current → diff 为 null', () => {
    expect(checkBackup(goodBackup()).diff).toBeNull();
  });

  it('每张表：当前 N 条 → 备份 M 条', () => {
    const report = checkBackup(goodBackup(), currentData());
    const tables = report.diff!.tables;
    const tx = tables.find((t) => t.table === '交易')!;
    expect(tx.current).toBe(2);
    expect(tx.incoming).toBe(1);
  });

  it('备份里没有的基金 → 列为 fundsLost，并算出随它消失的交易笔数', () => {
    // 当前有 008163 与 160140；备份里只有 008163 → 160140 连同它的 1 笔交易会消失
    const report = checkBackup(goodBackup(), currentData());
    expect(report.diff!.fundsLost).toEqual(['160140']);
    expect(report.diff!.fundsGained).toEqual([]);
    expect(report.diff!.transactionsLostWithFunds).toBe(1);
  });

  it('备份里多出来的基金 → 列为 fundsGained', () => {
    const b = goodBackup();
    (b.funds as unknown[]).push({
      id: '110022', name: '易方达消费', platformId: 'p1', type: 'mixed', currentNav: 3, navDate: '2026-11-20',
    });
    const report = checkBackup(b, currentData());
    expect(report.diff!.fundsGained).toEqual(['110022']);
    expect(report.diff!.fundsLost).toEqual(['160140']);
  });

  it('完全一致的备份 → 没有基金会消失', () => {
    const cur = currentData();
    const b = goodBackup({
      funds: cur.funds,
      transactions: cur.transactions,
    });
    const report = checkBackup(b, cur);
    expect(report.diff!.fundsLost).toEqual([]);
    expect(report.diff!.transactionsLostWithFunds).toBe(0);
  });
});
