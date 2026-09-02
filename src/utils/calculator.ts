import type { Transaction, Fund, NavRecord, DcaPlan } from '../types';
import { findPublishedNavPair } from './tradingDays';
import dayjs from 'dayjs';

/** 过滤掉 pending(待确认)交易;只保留 confirmed 或未设状态的(向后兼容) */
export function onlyConfirmed(transactions: Transaction[]): Transaction[] {
  return transactions.filter((t) => t.status !== 'pending');
}

/** 计算某只基金的持有份额（按日期排序，加法交换律保证结果正确） */
export function calcShares(transactions: Transaction[]): number {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.reduce((sum, tx) => {
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

/** 计算某只基金的持仓成本（卖出时按成本比例扣减）
 *  约定：fee 内扣——用户总付出 = tx.amount，其中 tx.fee 从中扣减用于支付手续费，
 *  净买入 = (amount - fee) / nav。所以 cost 直接累加 amount。
 *  按日期排序处理，确保卖出不会超过当前持有份额。
 */
export function calcCost(transactions: Transaction[]): number {
  let totalCost = 0;
  let totalShares = 0;

  // 按日期排序，确保时序正确（用户可能先录入后面的交易再补前面的）
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));

  for (const tx of sorted) {
    switch (tx.type) {
      case 'buy':
        totalCost += tx.amount;
        totalShares += tx.shares;
        break;
      case 'sell': {
        // 按平均成本比例扣减，卖出不超过实际持有
        if (totalShares > 0) {
          const actualSell = Math.min(tx.shares, totalShares);
          const avgCost = totalCost / totalShares;
          totalCost -= avgCost * actualSell;
          totalShares -= actualSell;
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

/**
 * 计算单只基金的当日盈亏（按"发布日"对齐）
 * 返回 { pnl, currDate, prevDate, isReady }：
 *   - pnl = null：完全无 NAV 历史或不足 2 条
 *   - isReady = false：今日还没有"已发布的最新 NAV 对"（A 股白天 / QDII T+2 延迟 / 节假日 / 刷新失败）
 *     → UI 显示"— 净值更新中"
 *   - isReady = true：今日发布日已对齐，pnl = shares × (curr.nav − prev.nav)
 *     - A 股：curr/prev 是今天 vs 昨天 NAV
 *     - QDII：curr/prev 是 QDII "今日发布"对应的那对 NAV（归属日落后 A 股 2 个交易日）
 *       例：今天 = 9/3，QDII 9/1 NAV 在 9/3 晚上发布 → pnl = 9/1 NAV − 8/29 NAV
 *
 * 口径：A 股与 QDII 行为完全对称，都是"等到发布 → 才有数字"，区别只在 QDII 的 NAV 归属日落后 2 个交易日。
 * 历史格归属（reportGenerator）按 navDate（即"准确日期"），与本函数解耦。
 */
export function calcDailyPnl(
  shares: number,
  navHistory: NavRecord[],
  fund: Fund,
  todayStr: string
): { pnl: number | null; currDate: string; prevDate: string; isReady: boolean } {
  if (navHistory.length < 2) return { pnl: null, currDate: '', prevDate: '', isReady: false };
  // 找 publishDate === todayStr 的最新 NAV 对（A 股 publishDate = navDate；QDII = navDate + 2 交易日）
  const pair = findPublishedNavPair(fund, navHistory, (pd) => pd === todayStr);
  if (!pair) return { pnl: null, currDate: '', prevDate: '', isReady: false };
  return {
    pnl: shares * (pair.curr.nav - pair.prev.nav),
    currDate: pair.curr.date,
    prevDate: pair.prev.date,
    isReady: true,
  };
}

/**
 * 累计分红金额（所有 dividend 类型交易）
 * - 现金分红：amount = 现金金额, shares = 0
 * - 红利再投资：amount = 0, shares = 再投资份额（×nav 折算）
 * 取 amount 优先；amount=0 时用 shares × nav
 */
export function calcDividendTotal(transactions: Transaction[]): number {
  return onlyConfirmed(transactions)
    .filter((tx) => tx.type === 'dividend')
    .reduce((sum, tx) => {
      if (tx.amount > 0) return sum + tx.amount;
      // 红利再投资：amount 在保存时已经 = shares × nav，所以这里 max(amount, shares) 都能命中
      return sum + Math.max(tx.amount, tx.shares * tx.nav);
    }, 0);
}

/**
 * 计算 XIRR（不规则现金流的年化收益率）
 * 约定（fee 内扣）:
 *   - 买入: 用户总付出 = amount，现金流 = -amount
 *   - 卖出: 用户净收入 = amount - fee，现金流 = +(amount - fee)
 *   - 分红: 现金流 = +amount（或 +shares，取较大值，兼容现金分红/红利再投资）
 *   - currentValue 作为终值（正现金流）
 * 返回: 年化收益率(百分比,例如 12.5 表示 12.5%);无数据或不收敛返回 0
 */
export function calcXIRR(transactions: Transaction[], currentValue: number): number {
  if (transactions.length === 0 || currentValue <= 0) return 0;
  transactions = onlyConfirmed(transactions);

  const flows: { t: number; amount: number }[] = [];
  for (const tx of transactions) {
    let amount = 0;
    if (tx.type === 'buy') amount = -tx.amount; // fee 内扣：用户总付出就是 amount
    else if (tx.type === 'sell') amount = tx.amount - tx.fee;
    else if (tx.type === 'dividend') amount = Math.max(tx.amount, tx.shares); // 兼容现金分红(amount=0, shares=现金) 和红利再投资(amount=金额)
    if (amount !== 0) {
      flows.push({ t: new Date(tx.date).getTime(), amount });
    }
  }
  if (flows.length === 0) return 0;

  flows.sort((a, b) => a.t - b.t);
  flows.push({ t: Date.now(), amount: currentValue });

  const t0 = flows[0]!.t;
  const tEnd = flows[flows.length - 1]!.t;
  const totalDays = (tEnd - t0) / (24 * 60 * 60 * 1000);

  // 持仓不足 7 天：年化收益率无实际参考意义，返回 0
  if (totalDays < 7) return 0;

  // 必须有负现金流（投入），否则方程无解
  if (!flows.some((f) => f.amount < 0)) return 0;

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

  // Newton-Raphson with generous bounds to handle large gains/losses
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
    // 上界放到 100，足以覆盖 1 万倍以内的回报率；下界 -0.99 避免 (1+r) 变负
    r = Math.max(-0.99, Math.min(next, 100));
  }

  // Bisection fallback if NR didn't converge
  if (!converged) {
    let lo = -0.99;
    let hi = 100;
    let flo = npv(lo);
    let fhi = npv(hi);
    if (flo * fhi > 0) return r * 100; // no sign change → 返回 NR 最后一步的最佳估计
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
    // 不收敛也返回当前 r（总比 0 更有信息量）
  }

  return r * 100;
}

/** 根据金额和净值计算份额（含手续费） */
export function calcSharesFromAmount(amount: number, fee: number, nav: number): number {
  if (nav === 0) return 0;
  return (amount - fee) / nav;
}

/**
 * 判断某笔 buy 交易是否可能是某个定投计划的执行
 * 修复"金额相同的手动买入被算进定投投入"的 bug：加上日期窗口约束
 * - 必须在 plan.startDate 之后
 * - 交易日期必须落在该计划"预期执行日"的合理窗口内
 *   - daily: 任意交易日
 *   - weekly: weekday 偏差 ≤ 1 天（容忍"周一忘了周二补"，拒绝"周三手动买入"被误算）
 *   - biweekly: 同 weekly + 与 startDate 所在周奇偶相同
 *   - monthly: 与当月目标日偏差 ≤ 3 天（容忍节假日顺延到下周一）
 */
export function isInPlanWindow(plan: DcaPlan, txDate: string): boolean {
  const tx = dayjs(txDate);
  const start = dayjs(plan.startDate);
  if (tx.isBefore(start, 'day')) return false;

  if (plan.frequency === 'daily') return true;

  if (plan.frequency === 'weekly' || plan.frequency === 'biweekly') {
    if (plan.dayOfWeek === undefined) return false;
    if (Math.abs(tx.day() - plan.dayOfWeek) > 1) return false;
    if (plan.frequency === 'biweekly') {
      const txWeekStart = tx.startOf('week');
      const startWeekStart = start.startOf('week');
      const weekDiff = Math.round(txWeekStart.diff(startWeekStart, 'day') / 7);
      if (weekDiff < 0 || weekDiff % 2 !== 0) return false;
    }
    return true;
  }

  if (plan.frequency === 'monthly') {
    if (plan.dayOfMonth === undefined) return false;
    const txDay = tx.date();
    const daysInMonth = tx.daysInMonth();
    const actualTargetDay = Math.min(plan.dayOfMonth, daysInMonth);
    return Math.abs(txDay - actualTargetDay) <= 3;
  }

  return false;
}

/**
 * 判断某个 DCA 计划今天是否应执行
 * - daily: 当前时间 < 15:00 → 今天；否则 → 明天（这里只判断"今天"，用于 Dashboard 实时显示）
 * - weekly: 今天星期几 == plan.dayOfWeek
 * - biweekly: 满足 weekly 条件 + 与 startDate 所在周奇偶相同
 * - monthly: 今天是 plan.dayOfMonth 号
 * 跳过周末（不补录周六/周日的定投）
 */
export function isDcaPlanDueToday(plan: DcaPlan, today: Date = new Date()): boolean {
  if (!plan.active) return false;
  const now = dayjs(today);
  // 周末不计入（避免补录上周遗漏的定投）
  if (now.day() === 0 || now.day() === 6) return false;

  switch (plan.frequency) {
    case 'daily': {
      const cutoff = now.hour(15).minute(0).second(0).millisecond(0);
      return now.isBefore(cutoff);
    }
    case 'weekly':
      return now.day() === plan.dayOfWeek;
    case 'biweekly': {
      if (now.day() !== plan.dayOfWeek) return false;
      const start = dayjs(plan.startDate);
      const diffDays = now.startOf('day').diff(start.startOf('day'), 'day');
      const diffWeeks = Math.floor(diffDays / 7);
      return diffDays >= 0 && diffWeeks % 2 === 0;
    }
    case 'monthly':
      return now.date() === plan.dayOfMonth;
    default:
      return false;
  }
}

/**
 * 生成某个定投计划从 startDate 到 endDate（含）之间所有"应执行日"。
 * 语义与 isDcaPlanDueToday 对齐：跳过周末；daily 每个工作日；
 * weekly 按 dayOfWeek；biweekly 额外校验与 startDate 所在周奇偶一致；
 * monthly 按 dayOfMonth（月末 clamp，与 isInPlanWindow 一致）。
 * 用于"定投自动生成交易记录"：把到期日批量补成待确认买入。
 */
export function getPlanDueDates(plan: DcaPlan, endDate: string | Date): string[] {
  const end = dayjs(endDate).format('YYYY-MM-DD');
  const start = dayjs(plan.startDate).format('YYYY-MM-DD');
  if (end < start) return [];

  const dates: string[] = [];
  let cursor = dayjs(start);
  while (cursor.format('YYYY-MM-DD') <= end) {
    const isWeekend = cursor.day() === 0 || cursor.day() === 6;
    let due = false;

    switch (plan.frequency) {
      case 'daily':
        due = !isWeekend;
        break;
      case 'weekly':
        due = !isWeekend && plan.dayOfWeek !== undefined && cursor.day() === plan.dayOfWeek;
        break;
      case 'biweekly': {
        if (isWeekend || plan.dayOfWeek === undefined || cursor.day() !== plan.dayOfWeek) break;
        const startWeekStart = dayjs(start).startOf('week');
        const weekDiff = Math.round(cursor.startOf('week').diff(startWeekStart, 'day') / 7);
        due = weekDiff >= 0 && weekDiff % 2 === 0;
        break;
      }
      case 'monthly': {
        if (isWeekend || plan.dayOfMonth === undefined) break;
        const target = Math.min(plan.dayOfMonth, cursor.daysInMonth());
        due = cursor.date() === target;
        break;
      }
    }

    if (due) dates.push(cursor.format('YYYY-MM-DD'));
    cursor = cursor.add(1, 'day');
  }
  return dates;
}

/**
 * 计算当日投入金额（交易记录 + 定投计划预期）
 * - 交易记录：今天所有买入的 amount 之和（含 pending 和 confirmed）
 * - 定投计划：今天应执行的计划 amount 之和（去重：若当日已有该基金的买入交易，则该计划不重复计入）
 * 返回：{ txAmount, planAmount, total }
 */
export function calcTodayInvested(
  transactions: Transaction[],
  dcaPlans: DcaPlan[],
  today: Date = new Date()
): { txAmount: number; planAmount: number; total: number } {
  const todayStr = dayjs(today).format('YYYY-MM-DD');

  // 交易部分：今天所有买入
  const txAmount = transactions
    .filter((t) => t.type === 'buy' && t.date === todayStr)
    .reduce((sum, t) => sum + t.amount, 0);

  // 定投部分：今天应执行、且当日没有对应交易（避免重复计数）
  const fundsWithTxToday = new Set(
    transactions.filter((t) => t.type === 'buy' && t.date === todayStr).map((t) => t.fundId)
  );
  const planAmount = dcaPlans
    .filter((p) => isDcaPlanDueToday(p, today) && !fundsWithTxToday.has(p.fundId))
    .reduce((sum, p) => sum + p.amount, 0);

  return { txAmount, planAmount, total: txAmount + planAmount };
}

/** 计算基金汇总信息 */
export function calcFundSummary(
  fund: Fund,
  transactions: Transaction[],
  navHistory: NavRecord[],
  todayStr: string
) {
  const fundTransactions = onlyConfirmed(transactions).filter((t) => t.fundId === fund.id);
  const shares = calcShares(fundTransactions);
  const cost = calcCost(fundTransactions);
  const marketValue = calcMarketValue(shares, fund.currentNav);
  const totalReturn = calcReturn(marketValue, cost);
  const returnRate = calcReturnRate(totalReturn, cost);
  const dailyPnlResult = calcDailyPnl(shares, navHistory, fund, todayStr);
  const xirr = calcXIRR(fundTransactions, marketValue);
  const dividend = calcDividendTotal(fundTransactions);

  return {
    shares,
    cost,
    marketValue,
    totalReturn,
    returnRate,
    dailyPnl: dailyPnlResult.pnl,
    currNavDate: dailyPnlResult.currDate,
    prevNavDate: dailyPnlResult.prevDate,
    isDailyPnlToday: dailyPnlResult.isReady,
    xirr,
    dividend,
  };
}
