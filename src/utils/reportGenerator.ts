import type { Fund, Transaction, DcaPlan, DailySnapshot, Platform, NavRecord } from '../types';
import { calcShares, onlyConfirmed, isInPlanWindow } from './calculator';
import { FUND_TYPE_LABELS } from '../types';
import { countTradingDays, lookupNavForDate } from './navLookup';
import { getNavHistory } from './storage';
import { today } from './formatter';
import dayjs from 'dayjs';

export interface FundPerformance {
  fundId: string;
  fundName: string;
  returnAmount: number;
  returnRate: number;
}

export interface DcaPlanExecution {
  planId: string;
  fundId: string;
  fundName: string;
  frequency: DcaPlan['frequency'];
  /** 本周是否落入执行周（biweekly/monthly 不是每周都执行） */
  isDueWeek: boolean;
  /** 本周内该基金的 buy 交易笔数（confirmed） */
  actual: number;
  /** 期望笔数：daily 时是本周交易天数，其他都是 0/1 */
  expected: number;
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  totalReturn: number;
  returnRate: number;
  buyCount: number;
  sellCount: number;
  dividendCount: number;
  fundRankings: FundPerformance[];
  dcaExpected: number;
  dcaActual: number;
  dcaDetails: DcaPlanExecution[];
}

export interface MonthlyReport {
  month: string;
  totalReturn: number;
  returnRate: number;
  snapshots: DailySnapshot[];
  platformContributions: { name: string; returnAmount: number }[];
  typeContributions: { type: string; returnAmount: number }[];
  bestFund: FundPerformance | null;
  worstFund: FundPerformance | null;
  fundRankings: FundPerformance[];
}

function getWeekRange(date: Date): [string, string] {
  // 用 dayjs 算本地周一/周日，避免 toISOString 的 UTC 偏移
  const monday = dayjs(date).startOf('week').add(1, 'day'); // dayjs 默认周日为周首，需要 +1 天到周一
  const sunday = monday.add(6, 'day');
  return [monday.format('YYYY-MM-DD'), sunday.format('YYYY-MM-DD')];
}

function getMonthRange(year: number, month: number): [string, string] {
  // month is 1-12 (dayjs convention); dayjs is 1-12 too
  const start = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
  const end = start.endOf('month');
  return [start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD')];
}

/** 月度收益聚合（沿用 calcPortfolioValueAtDate 算法，与 WeeklyReport/MonthlyReport 一致） */
export interface MonthlyReturn {
  month: string;        // 'YYYY-MM'
  totalReturn: number;  // 整月收益金额（元）
  returnRate: number;   // 月度收益率 %
  perFund: { fundId: string; fundName: string; returnAmount: number }[];
}

/** 年度收益聚合（同上） */
export interface YearlyReturn {
  year: string;         // 'YYYY'
  totalReturn: number;
  returnRate: number;
  perFund: { fundId: string; fundName: string; returnAmount: number }[];
}

export interface DailyReturn {
  date: string;
  /** 当天总收益（仅含价格变动 × 份额，不扣除当日净投入；当日投入见 Dashboard 顶部 StatCard） */
  totalReturn: number;
  /** 各基金贡献的收益 */
  perFund: { fundId: string; fundName: string; returnAmount: number }[];
  /**
   * 仅对"今日"生效。今天**任何一个**基金都还没有"NAV-date=今日"的最新记录时
   * 为 true（即打开 app 时所有基金今日 NAV 都还没刷新成功）：totalReturn=0、
   * perFund 全为 0，UI 用灰格 + "净值更新中" 提示。
   * 今天只要有 ≥1 只基金满足 curr.date===today（部分或全部刷新成功）即为 false；
   * 未刷新的基金对 totalReturn 贡献 0，已刷新的正常汇总——与 Dashboard
   * `latest.date === today` / "有多少个更新就汇总多少个"的口径完全一致。
   */
  isPending?: boolean;
}

/**
 * 加 N 个交易日（跳过周六、周日；不处理元旦/春节/国庆等法定节假日，因为基金公司的
 * "实际发布日"已含这部分信息，本地用日历日 + 周末跳过做近似即可）
 */
function addTradingDays(date: string, days: number): string {
  let d = dayjs(date);
  let added = 0;
  while (added < days) {
    d = d.add(1, 'day');
    const dow = d.day(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.format('YYYY-MM-DD');
}

/**
 * 收益归属日：
 * - A股/债券/指数/混合：归属日 = NAV 日（T+0）
 * - QDII：归属日 = NAV 日 + 2 交易日（T+2，跳过周末）
 *
 * 例：QDII 8/27（Thu）NAV → 8/31（Mon）；QDII 8/28（Fri）NAV → 9/1（Tue）。
 * 这样 QDII 的"8/27→8/26 NAV 变化"显示在 8/31 那天，与基金公司的"实际发布日"对齐。
 */
function getPublishDate(fund: Fund, navDate: string): string {
  return fund.type === 'qdii' ? addTradingDays(navDate, 2) : navDate;
}

interface Attribution {
  fund: Fund;
  curr: NavRecord;
  prev: NavRecord;
}

/**
 * 预计算每只基金的"相邻 NAV 变化"及其归属日：
 * 对每对相邻 NAV（prev → curr），把 (curr.nav - prev.nav) 的收益归属到 publishDate = curr.date
 * （QDII 则 +2 交易日）。返回 Map<归属日, Attribution[]>，供 generateDailyReturns 按日查找。
 *
 * 份额按 publish 日（即归属日）计算——用户在 publish 日持有的份额数 × 该日新学到的 NAV 变化。
 * 不再扣除 fundFlow（参见 generateDailyReturns 的注释）。
 */
function buildAttributionMap(funds: Fund[]): Map<string, Attribution[]> {
  const map = new Map<string, Attribution[]>();
  for (const fund of funds) {
    const hist = getNavHistory(fund.id);
    if (hist.length < 2) continue;
    const sorted = [...hist].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i++) {
      const curr = sorted[i]!;
      const prev = sorted[i - 1]!;
      const publishDate = getPublishDate(fund, curr.date);
      if (!map.has(publishDate)) map.set(publishDate, []);
      map.get(publishDate)!.push({ fund, curr, prev });
    }
  }
  return map;
}

/**
 * 生成每日收益明细（按日期升序）
 * - 不依赖 snapshot 的 totalValue：用 NAV 历史 + 交易算持仓市值
 * - **收益归属依据**：每只基金相邻 NAV 对 (prev → curr) 的 NAV 变化归属到 publishDate：
 *   - A股/债券/指数/混合：publishDate = NAV 日（T+0）
 *   - QDII：publishDate = NAV 日 + 2 交易日（跳过周末）——T+2 规则
 *   同一 NAV 变化只归属一次，不会跨日重复计入。
 * - **今日的归属口径**：必须满足 `curr.date === today`（即该基金今天有一条
 *   NAV-date=今日的最新 NAV）。这与 Dashboard `calcDailyPnl` 的
 *   `latest.date === today` 完全等价——A 股/债券/指数 T+0 自然命中；QDII
 *   T+2 延迟基金今日不命中，自动按 Dashboard 同样方式显示"净值更新中"。
 *   这样把"上周刚发布的 NAV 变化"（QDII publish-date 落到今天但 NAV-date
 *   是几天前）挡在今日格外面，避免日历当盈亏与 Dashboard 不一致。
 *   `isPending` 仅在今日**任何**基金 curr.date=今日都还不存在时为 true。
 *   只要有 ≥1 只基金今天刷出新 NAV（partial），就显示 partial 之和——
 *   与 Dashboard "有多少个更新就汇总多少个"的口径完全一致。
 * - 历史日的归属完全是确定性的（NAV 都在历史里），按 publish-date T+2 归属，
 *   不受"今天是否刷新"影响。
 */
export function generateDailyReturns(
  funds: Fund[],
  transactions: Transaction[],
  snapshots: DailySnapshot[]
): DailyReturn[] {
  // 只用 snapshot 的日期序列来驱动"哪天有数据"——不读 totalValue
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return [];

  // 一次性过滤 confirmed，避免每个循环迭代重复 filter
  const confirmed = onlyConfirmed(transactions);
  const todayStr = today();

  // 预计算归属 map：每个相邻 NAV 变化按 publishDate 分组
  // navHistory 会随用户刷新持续更新（晚间 NAV 发布后），所以"当天看"和"隔几天看"会因
  // 新 NAV 入库而触发不同归属日的归属——这正是 C 方案的预期行为
  const attributionMap = buildAttributionMap(funds);

  const result: DailyReturn[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const currDate = sorted[i]!.date;
    const isToday = currDate === todayStr;

    // 找归属于 currDate 的所有 (fund, curr NAV, prev NAV)
    const allAttributions = attributionMap.get(currDate) ?? [];

    // 今日："必须是今天才学到的 NAV 变化"才算今日盈亏
    //   - A 股 T+0：publish-date = curr.date = today → 命中 ✓
    //   - QDII T+2：publish-date 落到今天但 curr.date 是几天前 → 不命中 ✗
    //   与 Dashboard `latest.date === today` 严格对齐。
    // 历史日：保持原 publish-date T+2 归属（QDII 也命中对应日期），让历史归因
    //   在 NAV 实际到达用户视野的那天显示，与 `7889ec9` 修复的语义一致。
    const todaysAttributions = isToday
      ? allAttributions.filter((a) => a.curr.date === todayStr)
      : allAttributions;

    // 每只基金独立判断：有 attribution 就按归属算收益，没有就 0。
    const perFund = funds.map((fund) => {
      const attr = todaysAttributions.find((a) => a.fund.id === fund.id);
      if (!attr) return { fundId: fund.id, fundName: fund.name, returnAmount: 0 };

      // 日盈亏 = publish 日持仓份额 × 该日新学到的 NAV 变化（业内通用口径）
      // 不扣 fundFlow：当日的净投入由 Dashboard 顶部"当日投入"卡片独立显示，
      // 在此重复扣减会让建仓日看起来"亏了一大笔"，与 Dashboard 当日盈亏口径也不一致。
      const txs = confirmed.filter((t) => t.fundId === fund.id && t.date <= currDate);
      const shares = calcShares(txs);
      if (shares <= 0) return { fundId: fund.id, fundName: fund.name, returnAmount: 0 };

      return {
        fundId: fund.id,
        fundName: fund.name,
        returnAmount: shares * (attr.curr.nav - attr.prev.nav),
      };
    });

    // 总收益 = 各基金当日价格变动之和（不扣 fundFlow，参见上方注释）
    const totalReturn = perFund.reduce((sum, p) => sum + p.returnAmount, 0);

    // 今日「全员待刷新」才标 pending：没有 fund 的 attribution 满足 curr.date=今天，
    // 即今天还没任何一只刷出"NAV-date=今日"的新 NAV；只要有 ≥1 只贡献了，就走 partial
    // 求和路径，UI 显示真实数字 + perFund 明细（含未更新的 0 项）。
    const isPending = isToday && todaysAttributions.length === 0;

    result.push({ date: currDate, totalReturn, perFund, isPending });
  }
  return result;
}

/**
 * 计算某日期的总持仓市值（基于交易 + 历史净值查询）
 * 替代 snapshot.totalValue：解决"没有期初快照时 startValue=0，把本金算成收益"的 bug
 * 调用方传入已 confirmed 过滤的数组，避免每次循环重新 filter
 */
function calcPortfolioValueAtDate(
  date: string,
  funds: Fund[],
  transactions: Transaction[]
): number {
  let total = 0;
  for (const fund of funds) {
    const txs = transactions.filter((t) => t.fundId === fund.id && t.date <= date);
    const shares = calcShares(txs);
    if (shares <= 0) continue;
    const nav = lookupNavForDate(fund.id, date);
    if (nav) total += shares * nav.nav;
  }
  return total;
}

function calcFundPerformanceInRange(
  fund: Fund,
  transactions: Transaction[],
  startDate: string,
  endDate: string
): FundPerformance {
  // 只看已确认交易——pending 买入尚未成交，不计入持仓份额也不计入本期投入
  const confirmed = onlyConfirmed(transactions);
  const txBeforeStart = confirmed.filter((t) => t.fundId === fund.id && t.date < startDate);
  const txBeforeEnd = confirmed.filter((t) => t.fundId === fund.id && t.date <= endDate);

  const sharesStart = calcShares(txBeforeStart);
  const sharesEnd = calcShares(txBeforeEnd);

  const navStart = lookupNavForDate(fund.id, startDate);
  const navEnd = lookupNavForDate(fund.id, endDate);

  // 拿不到期初或期末净值，无法计算区间收益
  if (!navStart || !navEnd) {
    return { fundId: fund.id, fundName: fund.name, returnAmount: 0, returnRate: 0 };
  }

  const valueStart = sharesStart * navStart.nav;
  const valueEnd = sharesEnd * navEnd.nav;

  // fee 内扣：用户的总付出/总收入就是 tx.amount（不再额外加/减 fee，否则重复计算）
  const buyInRange = confirmed
    .filter((t) => t.fundId === fund.id && t.type === 'buy' && t.date >= startDate && t.date <= endDate)
    .reduce((sum, t) => sum + t.amount, 0);
  const sellInRange = confirmed
    .filter((t) => t.fundId === fund.id && t.type === 'sell' && t.date >= startDate && t.date <= endDate)
    .reduce((sum, t) => sum + (t.amount - t.fee), 0);

  const returnAmount = valueEnd - valueStart - buyInRange + sellInRange;
  const returnRate = valueStart > 0 ? (returnAmount / valueStart) * 100 : 0;
  return { fundId: fund.id, fundName: fund.name, returnAmount, returnRate };
}

export function generateWeeklyReport(
  date: Date,
  funds: Fund[],
  transactions: Transaction[],
  dcaPlans: DcaPlan[],
  _snapshots: DailySnapshot[]
): WeeklyReport {
  const [weekStart, weekEnd] = getWeekRange(date);

  // 用"期初持仓×期初净值"和"期末持仓×期末净值"算总市值——比 snapshot 更可靠：
  //   1) 没有期初快照时 startValue 不会是 0（不再把本金算成收益）
  //   2) 净值用真实历史数据，能正确反映期内涨跌
  const startValue = calcPortfolioValueAtDate(weekStart, funds, transactions);
  const endValue = calcPortfolioValueAtDate(weekEnd, funds, transactions);

  // 区间内交易只看已确认的——pending 买入尚未成交，不计入本期投入/笔数
  const weekTxs = onlyConfirmed(transactions).filter((t) => t.date >= weekStart && t.date <= weekEnd);
  const buyCount = weekTxs.filter((t) => t.type === 'buy').length;
  const sellCount = weekTxs.filter((t) => t.type === 'sell').length;
  const dividendCount = weekTxs.filter((t) => t.type === 'dividend').length;

  const buyTotal = weekTxs
    .filter((t) => t.type === 'buy')
    .reduce((sum, t) => sum + t.amount, 0);
  const sellTotal = weekTxs
    .filter((t) => t.type === 'sell')
    .reduce((sum, t) => sum + (t.amount - t.fee), 0);

  const totalReturn = endValue - startValue - buyTotal + sellTotal;
  const returnRate = startValue > 0 ? (totalReturn / startValue) * 100 : 0;

  const fundRankings = funds
    .map((f) => calcFundPerformanceInRange(f, transactions, weekStart, weekEnd))
    .sort((a, b) => b.returnRate - a.returnRate);

  // DCA: count expected vs actual for active plans
  let dcaExpected = 0;
  let dcaActual = 0;
  const dcaDetails: DcaPlanExecution[] = [];
  for (const plan of dcaPlans.filter((p) => p.active)) {
    const fund = funds.find((f) => f.id === plan.fundId);
    const fundName = fund?.name ?? plan.fundId;

    // 计划还没到 startDate，整周都不算执行周（不管什么频率）
    const planStart = new Date(plan.startDate);
    const weekEndDate = new Date(weekEnd);
    if (planStart.getTime() > weekEndDate.getTime()) {
      dcaDetails.push({
        planId: plan.id,
        fundId: plan.fundId,
        fundName,
        frequency: plan.frequency,
        isDueWeek: false,
        actual: 0,
        expected: 0,
      });
      continue;
    }

    let isDueWeek = true;
    let expected = 0;
    if (plan.frequency === 'weekly') {
      expected = 1;
    } else if (plan.frequency === 'biweekly') {
      // Check if this week falls on a DCA week based on start date
      const weekMonday = new Date(weekStart);
      const diffDays = Math.round((weekMonday.getTime() - planStart.getTime()) / (1000 * 60 * 60 * 24));
      const diffWeeks = Math.floor(diffDays / 7);
      isDueWeek = diffWeeks >= 0 && diffWeeks % 2 === 0;
      expected = isDueWeek ? 1 : 0;
    } else if (plan.frequency === 'monthly') {
      const planDay = plan.dayOfMonth ?? 1;
      const weekDays = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        return d.getDate();
      });
      isDueWeek = weekDays.includes(planDay);
      expected = isDueWeek ? 1 : 0;
    } else if (plan.frequency === 'daily') {
      // Count actual trading days in this week from the fund's NAV history
      expected = countTradingDays(plan.fundId, weekStart, weekEnd);
    }
    // 实际笔数：金额匹配 + 日期落在计划执行窗口内的 buy 交易（含 pending——定投自动生成的
    // 待确认记录应立刻计入"定投执行"，否则周报/月报要等 T+1（QDII 还要 T+2）净值确认
    // 后才显示数字，与累计投入口径不一致）。
    // 手动买入也会被命中（同样满足"金额±¥1 + 窗口内"），但这是预期行为：
    // 手动操作本身就是在执行计划，无需区分自动/手动来源。
    const planBuyTxs = transactions.filter(
      (t) =>
        t.fundId === plan.fundId &&
        t.type === 'buy' &&
        t.date >= weekStart &&
        t.date <= weekEnd &&
        Math.abs(t.amount - plan.amount) < 1 &&
        isInPlanWindow(plan, t.date)
    );
    const actual = planBuyTxs.length;

    dcaExpected += expected;
    dcaActual += actual;
    dcaDetails.push({
      planId: plan.id,
      fundId: plan.fundId,
      fundName,
      frequency: plan.frequency,
      isDueWeek,
      actual,
      expected,
    });
  }

  return {
    weekStart,
    weekEnd,
    totalReturn,
    returnRate,
    buyCount,
    sellCount,
    dividendCount,
    fundRankings,
    dcaExpected,
    dcaActual,
    dcaDetails,
  };
}

export function generateMonthlyReport(
  year: number,
  month: number,
  funds: Fund[],
  transactions: Transaction[],
  snapshots: DailySnapshot[],
  platforms: Platform[]
): MonthlyReport {
  const [monthStart, monthEnd] = getMonthRange(year, month);
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;

  const monthSnapshots = snapshots
    .filter((s) => s.date >= monthStart && s.date <= monthEnd)
    .sort((a, b) => a.date.localeCompare(b.date));

  // 用"期初持仓×期初净值"和"期末持仓×期末净值"算总市值
  const startValue = calcPortfolioValueAtDate(monthStart, funds, transactions);
  const endValue = calcPortfolioValueAtDate(monthEnd, funds, transactions);

  // 区间内交易只看已确认的——pending 买入尚未成交，不计入本期投入
  const monthTxs = onlyConfirmed(transactions).filter((t) => t.date >= monthStart && t.date <= monthEnd);
  const buyTotal = monthTxs
    .filter((t) => t.type === 'buy')
    .reduce((sum, t) => sum + t.amount, 0);
  const sellTotal = monthTxs
    .filter((t) => t.type === 'sell')
    .reduce((sum, t) => sum + (t.amount - t.fee), 0);

  const totalReturn = endValue - startValue - buyTotal + sellTotal;
  const returnRate = startValue > 0 ? (totalReturn / startValue) * 100 : 0;

  // 每只基金算一次，Map 缓存供下面三处复用
  const perfByFund = new Map<string, FundPerformance>();
  for (const f of funds) {
    perfByFund.set(f.id, calcFundPerformanceInRange(f, transactions, monthStart, monthEnd));
  }

  // Per-platform contribution
  const platformContributions = platforms.map((p) => {
    const platformFunds = funds.filter((f) => f.platformId === p.id);
    const returnAmount = platformFunds.reduce(
      (sum, f) => sum + (perfByFund.get(f.id)?.returnAmount ?? 0),
      0
    );
    return { name: p.name, returnAmount };
  });

  // Per-type contribution
  const types: Fund['type'][] = ['index', 'bond', 'qdii', 'mixed'];
  const typeContributions = types.map((type) => {
    const typeFunds = funds.filter((f) => f.type === type);
    const returnAmount = typeFunds.reduce(
      (sum, f) => sum + (perfByFund.get(f.id)?.returnAmount ?? 0),
      0
    );
    return { type: FUND_TYPE_LABELS[type], returnAmount };
  });

  // Fund rankings
  const fundRankings = Array.from(perfByFund.values()).sort((a, b) => b.returnRate - a.returnRate);

  const bestFund = fundRankings[0] ?? null;
  const worstFund = fundRankings[fundRankings.length - 1] ?? null;

  return {
    month: monthStr,
    totalReturn,
    returnRate,
    snapshots: monthSnapshots,
    platformContributions,
    typeContributions,
    bestFund,
    worstFund,
    fundRankings,
  };
}

/**
 * 生成指定年份 12 个月的月度收益列表（升序）
 * - 不依赖 snapshot 全覆盖：用 calcPortfolioValueAtDate(monthStart) vs calcPortfolioValueAtDate(monthEnd)
 * - perFund 拆分复用 calcFundPerformanceInRange
 * - 空月：totalReturn=0, perFund=[]（保证 12 格完整）
 * - 只算 confirmed 交易
 */
export function generateMonthlyReturns(
  funds: Fund[],
  transactions: Transaction[],
  year: number,
  _platforms?: Platform[]  // 暂未使用，与 generateMonthlyReport 签名保持一致；后续可加平台/类型分布
): MonthlyReturn[] {
  const result: MonthlyReturn[] = [];
  for (let month = 1; month <= 12; month++) {
    const [monthStart, monthEnd] = getMonthRange(year, month);
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;

    const startValue = calcPortfolioValueAtDate(monthStart, funds, transactions);
    const endValue = calcPortfolioValueAtDate(monthEnd, funds, transactions);

    const confirmed = onlyConfirmed(transactions);
    const monthTxs = confirmed.filter((t) => t.date >= monthStart && t.date <= monthEnd);
    const buyTotal = monthTxs
      .filter((t) => t.type === 'buy')
      .reduce((sum, t) => sum + t.amount, 0);
    const sellTotal = monthTxs
      .filter((t) => t.type === 'sell')
      .reduce((sum, t) => sum + (t.amount - t.fee), 0);

    const totalReturn = endValue - startValue - buyTotal + sellTotal;
    const returnRate = startValue > 0 ? (totalReturn / startValue) * 100 : 0;

    const perFund: MonthlyReturn['perFund'] = funds.map((f) => {
      const perf = calcFundPerformanceInRange(f, transactions, monthStart, monthEnd);
      return { fundId: perf.fundId, fundName: perf.fundName, returnAmount: perf.returnAmount };
    });

    result.push({ month: monthStr, totalReturn, returnRate, perFund });
  }
  return result;
}

/**
 * 生成从首笔交易年到今年的年度收益列表（升序）
 * - 范围推断：Math.min(...transactions.map(t => t.date.slice(0,4))) 到今年
 * - 算法与 generateMonthlyReturns 一致（用 calcPortfolioValueAtDate）
 * - 无交易时返回仅含今年一格
 */
export function generateYearlyReturns(
  funds: Fund[],
  transactions: Transaction[],
  _platforms?: Platform[]
): YearlyReturn[] {
  const currentYear = new Date().getFullYear();
  const confirmedTxs = onlyConfirmed(transactions);
  const startYear = confirmedTxs.length > 0
    ? Math.min(...confirmedTxs.map((t) => parseInt(t.date.slice(0, 4), 10)))
    : currentYear;

  const result: YearlyReturn[] = [];
  for (let year = startYear; year <= currentYear; year++) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const yearStr = String(year);

    const startValue = calcPortfolioValueAtDate(yearStart, funds, transactions);
    const endValue = calcPortfolioValueAtDate(yearEnd, funds, transactions);

    const yearTxs = confirmedTxs.filter((t) => t.date >= yearStart && t.date <= yearEnd);
    const buyTotal = yearTxs
      .filter((t) => t.type === 'buy')
      .reduce((sum, t) => sum + t.amount, 0);
    const sellTotal = yearTxs
      .filter((t) => t.type === 'sell')
      .reduce((sum, t) => sum + (t.amount - t.fee), 0);

    const totalReturn = endValue - startValue - buyTotal + sellTotal;
    const returnRate = startValue > 0 ? (totalReturn / startValue) * 100 : 0;

    const perFund: YearlyReturn['perFund'] = funds.map((f) => {
      const perf = calcFundPerformanceInRange(f, transactions, yearStart, yearEnd);
      return { fundId: perf.fundId, fundName: perf.fundName, returnAmount: perf.returnAmount };
    });

    result.push({ year: yearStr, totalReturn, returnRate, perFund });
  }
  return result;
}
