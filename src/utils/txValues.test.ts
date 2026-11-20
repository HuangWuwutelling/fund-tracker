import { describe, it, expect } from 'vitest';
import { resolveTxValues, type TxInput } from './txValues';

function input(over: Partial<TxInput> = {}): TxInput {
  return {
    type: 'buy',
    dividendType: 'cash',
    amount: 0,
    fee: 0,
    shares: 0,
    nav: 0,
    pending: false,
    ...over,
  };
}

describe('resolveTxValues（录入值 → 交易存储口径）', () => {
  /* ---------------- 买入：金额为准，口径不变 ---------------- */
  describe('买入', () => {
    it('已确认：份额 = (金额 − 手续费) / 净值，金额原样保留', () => {
      const r = resolveTxValues(input({ type: 'buy', amount: 1000, fee: 1.5, nav: 1.2345 }));
      expect(r.amount).toBe(1000);
      expect(r.fee).toBe(1.5);
      expect(r.nav).toBe(1.2345);
      expect(r.shares).toBeCloseTo((1000 - 1.5) / 1.2345, 10);
    });

    it('待确认：净值未知 → 份额记 0，金额与手续费照记', () => {
      const r = resolveTxValues(input({ type: 'buy', amount: 1000, fee: 1.5, pending: true }));
      expect(r.amount).toBe(1000);
      expect(r.fee).toBe(1.5);
      expect(r.shares).toBe(0);
      expect(r.nav).toBe(0);
    });

    it('净值缺失（0）→ 不产生 NaN 份额', () => {
      const r = resolveTxValues(input({ type: 'buy', amount: 1000, nav: 0 }));
      expect(Number.isFinite(r.shares)).toBe(true);
      expect(r.shares).toBe(0);
    });
  });

  /* ---------------- 卖出：份额为准（本次修正） ---------------- */
  describe('卖出', () => {
    it('已确认：成交额 = 份额 × 净值，**手续费不减少份额**', () => {
      const r = resolveTxValues(input({
        type: 'sell', fee: 11.04, shares: 12498.5567, nav: 1.1294,
      }));
      expect(r.shares).toBe(12498.5567);
      expect(r.amount).toBeCloseTo(12498.5567 * 1.1294, 8);
      expect(r.fee).toBe(11.04);
      expect(r.nav).toBe(1.1294);
    });

    it('待确认：净值未知 → 成交额记 0，份额照记（份额已知、金额未知）', () => {
      const r = resolveTxValues(input({
        type: 'sell', fee: 11.04, shares: 12498.5567, pending: true,
      }));
      expect(r.shares).toBe(12498.5567);
      expect(r.amount).toBe(0);
      expect(r.fee).toBe(11.04);
      expect(r.nav).toBe(0);
    });

    it('回归：旧口径 (金额−手续费)/净值 会侵蚀份额，新口径不会', () => {
      // 旧公式：用户只能填平台显示的净额 14104.83 + 手续费 11.04
      const legacyShares = (14104.83 - 11.04) / 1.1294;
      expect(legacyShares).toBeLessThan(12498.5567); // 少了 19.5 份
      // 新口径：用户直接填份额，份额不被手续费侵蚀
      const r = resolveTxValues(input({
        type: 'sell', fee: 11.04, shares: 12498.5567, nav: 1.1294,
      }));
      expect(r.shares).toBe(12498.5567);
      // 且成交额回到平台口径（到手 = 成交额 − 手续费 = 14104.83）
      expect(r.amount - r.fee).toBeCloseTo(14115.87 - 11.04, 1);
    });

    it('份额为 0 → 成交额为 0（不产生 NaN）', () => {
      const r = resolveTxValues(input({ type: 'sell', shares: 0, nav: 1.1294 }));
      expect(r.amount).toBe(0);
      expect(r.shares).toBe(0);
    });
  });

  /* ---------------- 分红 ---------------- */
  describe('分红', () => {
    it('现金分红：金额为准，份额 0', () => {
      const r = resolveTxValues(input({
        type: 'dividend', dividendType: 'cash', amount: 62.8986, nav: 1.1,
      }));
      expect(r.amount).toBe(62.8986);
      expect(r.shares).toBe(0);
    });

    it('红利再投资：份额为准，成交额 = 份额 × 净值，手续费恒为 0', () => {
      const r = resolveTxValues(input({
        type: 'dividend', dividendType: 'reinvest', shares: 57.61, nav: 1.0918, fee: 99,
      }));
      expect(r.shares).toBe(57.61);
      expect(r.amount).toBeCloseTo(57.61 * 1.0918, 8);
      expect(r.fee).toBe(0);
    });
  });
});
