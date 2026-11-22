import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from './index';
import { installFakeStorage, type FakeStorage } from '../test/fakeStorage';
import type { Transaction, Fund, DcaPlan } from '../types';

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1', fundId: 'f1', type: 'buy', date: '2026-08-26',
    amount: 1575, fee: 0, shares: 1516.4645, nav: 1.0386, ...over,
  };
}

let fake: FakeStorage;

beforeEach(() => {
  fake = installFakeStorage();
  useStore.setState({ transactions: [], funds: [], dcaPlans: [], platforms: [] });
});

describe('store：写盘失败时不改内存状态（内存 == 磁盘）', () => {
  it('addTransaction：写盘失败 → 返回 false，账本没变', () => {
    fake.failOnWrite = true;
    const ok = useStore.getState().addTransaction(tx());
    expect(ok).toBe(false);
    expect(useStore.getState().transactions).toHaveLength(0);
  });

  it('addTransaction：写盘成功 → 返回 true，账本已更新', () => {
    const ok = useStore.getState().addTransaction(tx());
    expect(ok).toBe(true);
    expect(useStore.getState().transactions).toHaveLength(1);
    expect(fake.getItem('fund-tracker:transactions')).toContain('2026-08-26');
  });

  it('updateTransaction：写盘失败 → 返回 false，原记录不变', () => {
    useStore.getState().addTransaction(tx());
    fake.failOnWrite = true;
    const ok = useStore.getState().updateTransaction('t1', { amount: 999 });
    expect(ok).toBe(false);
    expect(useStore.getState().transactions[0]!.amount).toBe(1575);
  });

  it('removeTransaction：写盘失败 → 返回 false，记录还在', () => {
    useStore.getState().addTransaction(tx());
    fake.failOnWrite = true;
    const ok = useStore.getState().removeTransaction('t1');
    expect(ok).toBe(false);
    expect(useStore.getState().transactions).toHaveLength(1);
  });

  it('updateSettings：写盘失败 → 返回 false，设置没变', () => {
    const before = useStore.getState().settings.theme;
    fake.failOnWrite = true;
    const ok = useStore.getState().updateSettings({ theme: 'dark' });
    expect(ok).toBe(false);
    expect(useStore.getState().settings.theme).toBe(before);
  });

  it('交易变动后今日快照立即重算（组合趋势图与账本一致）', () => {
    // 固定到交易日（2026-11-20 周五）——非交易日 generateSnapshot 返回 null
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T10:00:00'));
    try {
      useStore.setState({
        funds: [{ id: 'f1', name: '测试基金', platformId: 'p1', type: 'mixed', currentNav: 1, navDate: '2026-11-20' }],
        transactions: [],
        snapshots: [],
      });
      // 买入 100 份 → 市值 100
      useStore.getState().addTransaction(tx({ shares: 100, nav: 1 }));
      const afterBuy = useStore.getState().snapshots.find((s) => s.date === '2026-11-20');
      expect(afterBuy?.totalValue).toBe(100);

      // 删掉这笔 → 份额归零 → 快照要跟着归零（不能等下次刷新）
      useStore.getState().removeTransaction('t1');
      const afterDelete = useStore.getState().snapshots.find((s) => s.date === '2026-11-20');
      expect(afterDelete?.totalValue).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('失败后恢复写入 → 下一次操作正常保存（状态位会清）', () => {
    fake.failOnWrite = true;
    expect(useStore.getState().addTransaction(tx())).toBe(false);
    fake.failOnWrite = false;
    expect(useStore.getState().addTransaction(tx())).toBe(true);
    expect(useStore.getState().transactions).toHaveLength(1);
  });
});

describe('store：写盘 seam（commitLedger）—— 一组关键数据要么全成、要么全不成', () => {
  const fund: Fund = {
    id: 'f1', name: '纳斯达克100(QDII)', platformId: 'p1',
    type: 'index', currentNav: 1, navDate: '2026-11-20',
  };
  const plan: DcaPlan = {
    id: 'p1', fundId: 'f1', amount: 100, frequency: 'monthly',
    dayOfMonth: 1, active: true, startDate: '2026-01-01',
  };

  it('reclassifyFunds：写盘失败 → 不改内存状态（类型保持原样）', () => {
    useStore.setState({ funds: [fund] });
    fake.failOnWrite = true;
    const changed = useStore.getState().reclassifyFunds();
    expect(changed).toBe(0);
    expect(useStore.getState().funds[0]!.type).toBe('index');
  });

  it('removeFund：其中一个 key 写失败 → 整体回滚，基金和交易都还在（磁盘也是）', () => {
    useStore.getState().addFund(fund);
    useStore.getState().addTransaction(tx());
    useStore.getState().addDcaPlan(plan);
    // 让定投计划这个 key 写失败（基金和交易的写会先成功）
    fake.failOnKey = 'fund-tracker:dca-plans';
    const ok = useStore.getState().removeFund('f1');
    expect(ok).toBe(false);
    expect(useStore.getState().funds).toHaveLength(1);
    expect(useStore.getState().transactions).toHaveLength(1);
    // 磁盘也必须保持原样 —— 写进去的基金要被回滚掉
    expect(fake.getItem('fund-tracker:funds')).toContain('"f1"');
  });

  it('importData：设置写失败 → 返回 -1，内存状态不变（不能假装导入成功）', () => {
    useStore.setState({ funds: [fund] });
    fake.failOnKey = 'fund-tracker:settings';
    const r = useStore.getState().importData({
      version: 2,
      platforms: [],
      funds: [{ ...fund, id: 'imported' }],
      transactions: [],
      dcaPlans: [],
      snapshots: [],
      settings: { ...useStore.getState().settings, theme: 'dark' },
      navHistories: {},
    });
    expect(r).toBe(-1);
    expect(useStore.getState().funds[0]!.id).toBe('f1');
    expect(useStore.getState().settings.theme).not.toBe('dark');
  });
});
