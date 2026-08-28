import type { Transaction, Fund, NavRecord } from '../types';

/** 过滤掉 pending(待确认)交易;只保留 confirmed 或未设状态的(向后兼容) */
export function onlyConfirmed(transactions: Transaction[]): Transaction[] {
  return transactions.filter((t) => t.status !== 'pending');
}

/** 计算某只基金的持有份额 */
export function calcShares(transactions: Transaction[]): number {
  return transactions.reduce((sum, tx) => {
    switch (tx.type) {
      case 'buy':
        return sum + tx.shares;
      case 'sell':
        return sum - tx.shares;
      case 'dividend':
        return sum + tx.shares;
      default:
        return sum;
    }
  }, 0);
}

/** 计算某只基金的持仓成本（卖出时按成本比例扣减） */
export function calcCost(transactions: Transaction[]): number {
  let totalCost = 0;
  let totalShares = 0;

  for (const tx of transactions) {
    switch (tx.type) {
      case 'buy':
        totalCost += tx.amount + tx.fee;
        totalShares += tx.shares;
        break;
      case 'sell': {
        // 按平均成本比例扣减
        if (totalShares > 0) {
          const avgCost = totalCost / totalShares;
          totalCost -= avgCost * tx.shares;
          totalShares -= tx.shares;
        }
        break;
      }
      case 'dividend':
        totalShares += tx.shares;
        break;
    }
  }

  return Math.max(0, totalCost);
}

/** 计算当前市值 */
export function calcMarketValue(shares: number, currentNav: number): number {
  return shares * currentNav;
}

/** 计算总收益 */
export function calcReturn(marketValue: number, cost: number): number {
  return marketValue - cost;
}

/** 计算收益率 */
export function calcReturnRate(totalReturn: number, cost: number): number {
  if (cost === 0) return 0;
  return (totalReturn / cost) * 100;
}

/** 计算当日盈亏 */
export function calcDailyPnl(shares: number, navHistory: NavRecord[]): number | null {
  if (navHistory.length < 2) return null;
  const sorted = [...navHistory].sort((a, b) => b.date.localeCompare(a.date));
  const today = sorted[0];
  const yesterday = sorted[1];
  if (!today || !yesterday) return null;
  return shares * (today.nav - yesterday.nav);
}

/** 累计分红金额（所有 dividend 类型交易） */
export function calcDividendTotal(transactions: Transaction[]): number {
  return onlyConfirmed(transactions)
    .filter((tx) => tx.type === 'dividend')
    .reduce((sum, tx) => sum + tx.amount, 0);
}

/**
 * 计算 XIRR（不规则现金流的年化收益率）
 * 约定: 买入 amount+fee 为负现金流,卖出 amount-fee 为正,分红 amount 为正;currentValue 作为终值
 * 返回: 年化收益率(百分比,例如 12.5 表示 12.5%);无数据或不收敛返回 0
 */
export function calcXIRR(transactions: Transaction[], currentValue: number): number {
  if (transactions.length === 0 || currentValue <= 0) return 0;
  transactions = onlyConfirmed(transactions);

  const flows: { t: number; amount: number }[] = [];
  for (const tx of transactions) {
    let amount = 0;
    if (tx.type === 'buy') amount = -(tx.amount + tx.fee);
    else if (tx.type === 'sell') amount = tx.amount - tx.fee;
    else if (tx.type === 'dividend') amount = tx.amount;
    if (amount !== 0) {
      flows.push({ t: new Date(tx.date).getTime(), amount });
    }
  }
  if (flows.length === 0) return 0;

  flows.sort((a, b) => a.t - b.t);
  flows.push({ t: Date.now(), amount: currentValue });

  const t0 = flows[0]!.t;
  const years = flows.map((f) => (f.t - t0) / (365.25 * 24 * 60 * 60 * 1000));

  const npv = (r: number): number => {
    let sum = 0;
    for (let i = 0; i < flows.length; i++) {
      sum += flows[i]!.amount / Math.pow(1 + r, years[i]!);
    }
    return sum;
  };
  const dnpv = (r: number): number => {
    let sum = 0;
    for (let i = 0; i < flows.length; i++) {
      const y = years[i]!;
      sum -= flows[i]!.amount * y / Math.pow(1 + r, y + 1);
    }
    return sum;
  };

  // Newton-Raphson
  let r = 0.1;
  let converged = false;
  for (let i = 0; i < 100; i++) {
    const f = npv(r);
    const fp = dnpv(r);
    if (Math.abs(fp) < 1e-12) break;
    const next = r - f / fp;
    if (!isFinite(next)) break;
    if (Math.abs(next - r) < 1e-7) {
      r = next;
      converged = true;
      break;
    }
    r = Math.max(-0.99, Math.min(next, 10));
  }

  // Bisection fallback if NR didn't converge
  if (!converged) {
    let lo = -0.99;
    let hi = 10;
    let flo = npv(lo);
    let fhi = npv(hi);
    if (flo * fhi > 0) return 0; // no sign change → no real IRR in range
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const fmid = npv(mid);
      if (Math.abs(fmid) < 1e-6 || hi - lo < 1e-7) {
        r = mid;
        converged = true;
        break;
      }
      if (flo * fmid < 0) {
        hi = mid;
        fhi = fmid;
      } else {
        lo = mid;
        flo = fmid;
      }
    }
    if (!converged) return 0;
  }

  return r * 100;
}

/** 根据金额和净值计算份额（含手续费） */
export function calcSharesFromAmount(amount: number, fee: number, nav: number): number {
  if (nav === 0) return 0;
  return (amount - fee) / nav;
}

/** 计算基金汇总信息 */
export function calcFundSummary(
  fund: Fund,
  transactions: Transaction[],
  navHistory: NavRecord[]
) {
  const fundTransactions = onlyConfirmed(transactions).filter((t) => t.fundId === fund.id);
  const shares = calcShares(fundTransactions);
  const cost = calcCost(fundTransactions);
  const marketValue = calcMarketValue(shares, fund.currentNav);
  const totalReturn = calcReturn(marketValue, cost);
  const returnRate = calcReturnRate(totalReturn, cost);
  const dailyPnl = calcDailyPnl(shares, navHistory);
  const xirr = calcXIRR(fundTransactions, marketValue);
  const dividend = calcDividendTotal(fundTransactions);

  return { shares, cost, marketValue, totalReturn, returnRate, dailyPnl, xirr, dividend };
}
