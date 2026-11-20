import { describe, it, expect } from 'vitest';
import { decideNavEntry } from './navEntry';

const TX_DATE = '2026-08-26';

describe('decideNavEntry（录入时的净值可用性判定）', () => {
  it('净值正是交易当日的 → confirmed，用它推算份额', () => {
    const d = decideNavEntry({
      txDate: TX_DATE,
      lookedUp: { nav: 1.048, navDate: TX_DATE },
    });
    expect(d.status).toBe('confirmed');
    expect(d.isExact).toBe(true);
    expect(d.nav).toBe(1.048);
    expect(d.warning).toBe('');
  });

  it('净值只到前一个交易日 → pending，不用它推算份额', () => {
    const d = decideNavEntry({
      txDate: TX_DATE,
      lookedUp: { nav: 1.0437, navDate: '2026-08-25' },
    });
    expect(d.status).toBe('pending');
    expect(d.isExact).toBe(false);
    expect(d.nav).toBe(0);
    expect(d.warning).toContain('2026-08-25');
    expect(d.warning).toContain('待确认');
  });

  it('缺口很大时（本地历史陈旧）同样 pending', () => {
    const d = decideNavEntry({
      txDate: TX_DATE,
      lookedUp: { nav: 1.0386, navDate: '2026-08-06' },
    });
    expect(d.status).toBe('pending');
    expect(d.nav).toBe(0);
  });

  it('完全没有净值 → pending', () => {
    const d = decideNavEntry({ txDate: TX_DATE, lookedUp: null });
    expect(d.status).toBe('pending');
    expect(d.nav).toBe(0);
    expect(d.warning).toContain('未找到');
  });

  it('用户手动录入的成交净值 → 视为交易当日的真实净值，confirmed', () => {
    const d = decideNavEntry({
      txDate: TX_DATE,
      lookedUp: { nav: 1.0386, navDate: '2026-08-06' },
      manualNav: 1.048,
    });
    expect(d.status).toBe('confirmed');
    expect(d.isExact).toBe(true);
    expect(d.nav).toBe(1.048);
    expect(d.navDate).toBe(TX_DATE);
  });

  it('手动录入优先于查到的净值（用户说的是平台确认的成交净值）', () => {
    const d = decideNavEntry({
      txDate: TX_DATE,
      lookedUp: { nav: 1.048, navDate: TX_DATE },
      manualNav: 1.05,
    });
    expect(d.nav).toBe(1.05);
  });

  it('手动录入 0 / 负数 / 缺省 → 视为没填，走查询结果', () => {
    for (const manualNav of [0, -1, undefined, null]) {
      const d = decideNavEntry({
        txDate: TX_DATE,
        lookedUp: { nav: 1.048, navDate: TX_DATE },
        manualNav: manualNav ?? undefined,
      });
      expect(d.nav).toBe(1.048);
      expect(d.status).toBe('confirmed');
    }
  });
});
