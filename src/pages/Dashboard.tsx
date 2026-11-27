import { useMemo } from 'react';
import { Card, Row, Col, Statistic, Table, Tag, Alert, Button, Tooltip, Space } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined, FundOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { useStore } from '../stores';
import { calcXIRR, calcDividendTotal, calcTodayInvested } from '../utils/calculator';
import { portfolioView } from '../utils/portfolio';
import { isNonTradingDay } from '../utils/chineseHolidays';
import ReturnCalendar from '../components/ReturnCalendar';
import MarketIndices from '../components/MarketIndices';
import {
  formatMoney,
  formatPercent,
  moneyStatFormatter,
  pnlColor,
  pnlBg,
  formatMoneyShortWithSign,
  today,
} from '../utils/formatter';
import { computeFundIndicators } from '../utils/indicators';
import {
  FUND_TYPE_LABELS,
  FUND_TYPE_COLORS,
  FUND_TYPE_STRIPE_COLORS,
  FUND_FETCH_FAILURE_LABELS,
  LATEST_NAV_PNL_LABEL,
  TEMPERATURE_COLORS,
  classifyTemperature,
  type Fund,
} from '../types';



export default function Dashboard() {
  const { funds, transactions, platforms, dcaPlans, getNavHistory, settings, freshNavFundIds, navRefreshedAt, refreshIssues } = useStore();
  const navigate = useNavigate();
  const isDark = settings.theme === 'dark';
  const usQdiiFilterMode = settings.usQdiiFilterMode;

  // 净值刷新失败上报（App.refreshAll 写入）：基金名/停留日期/发现时间在此解析，
  // reason 标签统一走 FUND_FETCH_FAILURE_LABELS
  const refreshIssueList = useMemo(() => {
    return Object.entries(refreshIssues).map(([fundId, issue]) => {
      const fund = funds.find((f) => f.id === fundId);
      return { fundId, name: fund?.name ?? fundId, navDate: fund?.navDate ?? '', reason: issue.reason, at: issue.at };
    });
  }, [refreshIssues, funds]);

  // todayStr 用于 ⚡ 卡片的休市态与「下次开盘自动刷新」提示（日历的 today 高亮
  // 由 ReturnCalendar 自己算）。它**不在** positions 的 deps 里——
  // positions 只依赖 funds / transactions / navHistory，与"跨日"无关。
  const todayStr = today();
  const { positions, totals } = useMemo(
    () =>
      // 「我持有什么」只有一份实现（utils/portfolio.ts）——mode 收在接口里，
      // 调用方无从漏传（漏传不报错、只是安静改变数字，是最难查的一类 bug）
      portfolioView({
        funds,
        transactions,
        navHistoryOf: getNavHistory,
        mode: usQdiiFilterMode,
      }),
    [funds, transactions, getNavHistory, usQdiiFilterMode],
  );

  // 本轮刷新是否"一无所获"：跑过刷新、但没有一只基金拿到新净值。
  // 非交易日不算（休市时本来就该没有新净值，提示反而误导）。
  const freshNavCount = funds.filter((f) => freshNavFundIds.has(f.id)).length;
  const showStaleTag =
    navRefreshedAt !== null &&
    freshNavCount === 0 &&
    totals.coveredCount > 0 &&
    !isNonTradingDay(todayStr);

  // XIRR / dividend / todayInvested 都是 O(transactions) 的重计算，用 useMemo 包裹避免每次渲染都跑
  const totalDividend = useMemo(() => calcDividendTotal(transactions), [transactions]);
  const totalXIRR = useMemo(
    () => calcXIRR(transactions, totals.totalValue),
    [transactions, totals.totalValue]
  );
  // deps 必须含 todayStr —— transactions 只在增删改时换引用（stores/index.ts:313），
  // 30 分钟净值 tick 不动它。少了 todayStr，跨零点后卡片仍是昨天的数，
  // 而链接指向今天 → 落地页 0 条。
  const todayInvested = useMemo(
    () => calcTodayInvested(transactions, dcaPlans),
    [transactions, dcaPlans, todayStr]
  );

  /* ============================================================
   *  组合信号排行 —— 按每只基金的 MA250 偏离度分两桶
   *  - 低估桶：MA250 偏离度 < −15%
   *  - 高估桶：MA250 偏离度 > +15%
   *  - 桶内按"偏离度极端程度"排序（低估最深的在顶，高估最贵的在顶）
   *  - 仅统计 hasEnoughHistory 的基金（≥ 250 个交易日）
   *  - 额外统计近 5 日 MACD 金叉/死叉计数，首页底部展示
   * ============================================================ */
  const portfolioSignals = useMemo(() => {
    const undervalued: Array<{ fund: Fund; deviation: number }> = [];
    const overvalued: Array<{ fund: Fund; deviation: number }> = [];
    let goldenCrossCount = 0;
    let deathCrossCount = 0;
    let historyReadyCount = 0;

    for (const fund of funds) {
      const history = getNavHistory(fund.id);
      const ind = computeFundIndicators(fund, history, usQdiiFilterMode);
      if (!ind.hasEnoughHistory) continue;
      historyReadyCount += 1;
      if (ind.ma250Deviation !== null) {
        if (ind.ma250Deviation <= -15) undervalued.push({ fund, deviation: ind.ma250Deviation });
        else if (ind.ma250Deviation >= 15) overvalued.push({ fund, deviation: ind.ma250Deviation });
      }
      if (ind.macdState.state === 'golden_cross') goldenCrossCount += 1;
      else if (ind.macdState.state === 'death_cross') deathCrossCount += 1;
    }

    undervalued.sort((a, b) => a.deviation - b.deviation); // 越负 → 越便宜 → 越靠前
    overvalued.sort((a, b) => b.deviation - a.deviation); // 越正 → 越贵 → 越靠前

    return { undervalued, overvalued, goldenCrossCount, deathCrossCount, historyReadyCount };
  }, [funds, getNavHistory, usQdiiFilterMode]);

  // 未确认定投(pending):不计入持仓/收益,但提示用户去确认
  const pendingTransactions = transactions.filter((t) => t.status === 'pending');
  const pendingCount = pendingTransactions.length;
  const pendingAmount = pendingTransactions
    .filter((t) => t.type === 'buy')
    .reduce((sum, t) => sum + t.amount, 0);

  const columns = [
    {
      title: '基金名称',
      key: 'name',
      width: 240,
      align: 'left' as const,
      fixed: 'left' as const,
      sorter: (a: typeof positions[0], b: typeof positions[0]) =>
        a.fund.name.localeCompare(b.fund.name, 'zh-CN'),
      render: (_: unknown, record: typeof positions[0]) => (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span
            style={{
              display: 'inline-block',
              width: 4,
              height: 28,
              background: FUND_TYPE_STRIPE_COLORS[record.fund.type],
              borderRadius: 2,
              marginRight: 10,
              flexShrink: 0,
            }}
            title={FUND_TYPE_LABELS[record.fund.type]}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {record.fund.name}
            </div>
            <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
              <Tag color={FUND_TYPE_COLORS[record.fund.type]} style={{ marginRight: 4, fontSize: 10, padding: '0 6px', lineHeight: '16px' }}>
                {FUND_TYPE_LABELS[record.fund.type]}
              </Tag>
              {record.fund.id}
            </div>
          </div>
        </div>
      ),
    },
    {
      title: '平台',
      key: 'platform',
      width: 100,
      align: 'left' as const,
      sorter: (a: typeof positions[0], b: typeof positions[0]) => {
        const an = platforms.find((p) => p.id === a.fund.platformId)?.name ?? '';
        const bn = platforms.find((p) => p.id === b.fund.platformId)?.name ?? '';
        return an.localeCompare(bn, 'zh-CN');
      },
      render: (_: unknown, record: typeof positions[0]) =>
        platforms.find((p) => p.id === record.fund.platformId)?.name ?? '—',
    },
    {
      title: '持仓成本',
      dataIndex: 'cost',
      key: 'cost',
      width: 130,
      align: 'right' as const,
      sorter: (a: typeof positions[0], b: typeof positions[0]) => a.cost - b.cost,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '当前市值',
      dataIndex: 'marketValue',
      key: 'marketValue',
      width: 130,
      align: 'right' as const,
      defaultSortOrder: 'descend' as const,
      sorter: (a: typeof positions[0], b: typeof positions[0]) => a.marketValue - b.marketValue,
      render: (v: number) => <span style={{ fontWeight: 500 }}>{formatMoney(v)}</span>,
    },
    {
      title: '持仓收益',
      dataIndex: 'totalReturn',
      key: 'totalReturn',
      width: 130,
      align: 'right' as const,
      sorter: (a: typeof positions[0], b: typeof positions[0]) => a.totalReturn - b.totalReturn,
      render: (v: number) => <span style={{ color: pnlColor(v), fontWeight: 500 }}>{formatMoney(v)}</span>,
    },
    {
      title: '收益率',
      dataIndex: 'returnRate',
      key: 'returnRate',
      width: 100,
      align: 'right' as const,
      sorter: (a: typeof positions[0], b: typeof positions[0]) => a.returnRate - b.returnRate,
      render: (v: number) => <span style={{ color: pnlColor(v) }}>{formatPercent(v)}</span>,
    },
    {
      title: LATEST_NAV_PNL_LABEL,
      dataIndex: 'dailyPnl',
      key: 'dailyPnl',
      width: 150,
      align: 'right' as const,
      sorter: (a: typeof positions[0], b: typeof positions[0]) => (a.dailyPnl ?? 0) - (b.dailyPnl ?? 0),
      render: (_v: number | null, record: typeof positions[0]) => {
        if (record.dailyPnl === null) {
          return (
            <Tooltip title="该基金可用净值不足 2 期，暂时算不出涨跌">
              <span style={{ color: '#999' }}>—</span>
            </Tooltip>
          );
        }
        // 净值日永远显示出来——这是本改造的核心：用户能看到 A 股是 09-14、QDII 是 09-11，
        // 不需要 App 去猜哪只基金延迟几天。
        return (
          <Tooltip title={`净值 ${record.currNavDate} vs ${record.prevNavDate}`}>
            <div>
              <span style={{ color: pnlColor(record.dailyPnl), fontWeight: 500 }}>
                {formatMoney(record.dailyPnl)}
              </span>
              <div style={{ fontSize: 11, color: '#999' }}>净值 {record.currNavDate.slice(5)}</div>
            </div>
          </Tooltip>
        );
      },
    },
  ];

  return (
    <div>
      {refreshIssueList.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`有 ${refreshIssueList.length} 只基金净值更新失败`}
          description={
            <div style={{ fontSize: 12 }}>
              {refreshIssueList.map((it) => (
                <div key={it.fundId}>
                  {it.name}（{FUND_FETCH_FAILURE_LABELS[it.reason]}，发现于 {dayjs(it.at).format('HH:mm')}）— 数据停留在 {it.navDate || '未知日期'}
                </div>
              ))}
              <div style={{ marginTop: 4, opacity: 0.75 }}>
                可在「基金列表」对单只基金手动刷新；失败期间不会写入错误数据，但净值/盈亏会停留在最后有效日期。
              </div>
            </div>
          }
          style={{ marginBottom: 16 }}
          closable
        />
      )}

      {pendingCount > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`您有 ${pendingCount} 笔未确认交易${pendingAmount > 0 ? `，合计 ${formatMoney(pendingAmount)}` : ''}`}
          description="这些交易还未生效（净值待发布），不影响当前持仓显示。点击下方按钮确认份额。"
          action={
            <Button size="small" type="primary" onClick={() => navigate('/transactions?status=pending')}>
              去确认
            </Button>
          }
          style={{ marginBottom: 16 }}
          closable
        />
      )}

      {/* ===== 4 大核心指标（突出样式：渐变背景 + 大字 + 涨跌色） ===== */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} md={6}>
          <Card
            hoverable
            onClick={() => navigate('/funds')}
            style={{
              background: isDark
                ? 'linear-gradient(135deg, #1f3a5f 0%, #2a4a7a 100%)'
                : 'linear-gradient(135deg, #1677ff 0%, #4096ff 100%)',
              border: 'none',
            }}
            styles={{ body: { padding: 20 } }}
          >
            <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13, marginBottom: 8 }}>💰 总资产</div>
            <div style={{ color: '#fff', fontSize: 30, fontWeight: 700, lineHeight: 1.2, fontFamily: 'DIN, "Helvetica Neue", Arial, sans-serif' }}>
              ¥{formatMoney(totals.totalValue)}
            </div>
            <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 8 }}>
              持仓 {funds.length} 只 ｜ 成本 ¥{formatMoney(totals.totalCost)}
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card
            hoverable
            onClick={() => navigate('/funds')}
            style={{
              background: pnlBg(totals.totalReturn, isDark) ?? (isDark ? '#1f1f1f' : '#fafafa'),
              border: pnlBg(totals.totalReturn, isDark) ? `1px solid ${pnlColor(totals.totalReturn)}20` : undefined,
            }}
            styles={{ body: { padding: 20 } }}
          >
            <div style={{ color: '#666', fontSize: 13, marginBottom: 8 }}>📈 累计收益</div>
            <div
              style={{
                color: pnlColor(totals.totalReturn),
                fontSize: 30,
                fontWeight: 700,
                lineHeight: 1.2,
                fontFamily: 'DIN, "Helvetica Neue", Arial, sans-serif',
                display: 'flex',
                alignItems: 'baseline',
                gap: 4,
              }}
            >
              {totals.totalReturn > 0 && <ArrowUpOutlined style={{ fontSize: 18 }} />}
              {totals.totalReturn < 0 && <ArrowDownOutlined style={{ fontSize: 18 }} />}
              <span>{totals.totalReturn >= 0 ? '+' : ''}¥{formatMoney(totals.totalReturn)}</span>
            </div>
            <div style={{ color: '#666', fontSize: 12, marginTop: 8 }}>
              累计投入 ¥{formatMoney(totals.totalCost)}
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card
            hoverable
            style={{
              background: pnlBg(totals.totalReturnRate, isDark) ?? (isDark ? '#1f1f1f' : '#fafafa'),
              border: pnlBg(totals.totalReturnRate, isDark) ? `1px solid ${pnlColor(totals.totalReturnRate)}20` : undefined,
            }}
            styles={{ body: { padding: 20 } }}
          >
            <div style={{ color: '#666', fontSize: 13, marginBottom: 8 }}>🎯 累计收益率</div>
            <div
              style={{
                color: pnlColor(totals.totalReturnRate),
                fontSize: 30,
                fontWeight: 700,
                lineHeight: 1.2,
                fontFamily: 'DIN, "Helvetica Neue", Arial, sans-serif',
              }}
            >
              {totals.totalReturnRate >= 0 ? '+' : ''}{totals.totalReturnRate.toFixed(2)}%
            </div>
            <div style={{ color: '#666', fontSize: 12, marginTop: 8 }}>
              年化 (XIRR) {totalXIRR >= 0 ? '+' : ''}{totalXIRR.toFixed(2)}%
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card
            hoverable
            style={{
              background: pnlBg(totals.totalDailyPnl ?? 0, isDark) ?? (isDark ? '#1f1f1f' : '#fafafa'),
              border: totals.totalDailyPnl !== null ? `1px solid ${pnlColor(totals.totalDailyPnl)}20` : undefined,
            }}
            styles={{ body: { padding: 20 } }}
          >
            <Tooltip
              title={
                totals.totalDailyPnl === null
                  ? '尚无基金有可用净值对'
                  : '各基金「最新已发布净值日」的盈亏合计。不同基金的净值日可能不同（A 股通常为今天，QDII 常落后 1 个交易日），卡片下方标出分布。'
              }
            >
              <div style={{ color: '#666', fontSize: 13, marginBottom: 8 }}>
                ⚡ {LATEST_NAV_PNL_LABEL}{isNonTradingDay(todayStr) ? '（休市）' : ''}
              </div>
              <div
                style={{
                  color: totals.totalDailyPnl !== null ? pnlColor(totals.totalDailyPnl) : '#999',
                  fontSize: 30,
                  fontWeight: 700,
                  lineHeight: 1.2,
                  fontFamily: 'DIN, "Helvetica Neue", Arial, sans-serif',
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 4,
                }}
              >
                {totals.totalDailyPnl !== null && totals.totalDailyPnl > 0 && <ArrowUpOutlined style={{ fontSize: 18 }} />}
                {totals.totalDailyPnl !== null && totals.totalDailyPnl < 0 && <ArrowDownOutlined style={{ fontSize: 18 }} />}
                <span>
                  {totals.totalDailyPnl === null
                    ? '—'
                    : `${totals.totalDailyPnl >= 0 ? '+' : ''}¥${formatMoney(totals.totalDailyPnl)}`}
                </span>
              </div>
              {(totals.coveredCount > 0 || isNonTradingDay(todayStr)) && (
                <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
                  {isNonTradingDay(todayStr) && <span style={{ marginRight: 6 }}>下次开盘自动刷新</span>}
                  {showStaleTag && (
                    <Tag style={{ marginRight: 6 }}>净值待更新</Tag>
                  )}
                  {totals.navDateBuckets.length > 0 &&
                    totals.navDateBuckets
                      .map((b) => `净值日 ${b.date.slice(5)} ×${b.count} 只`)
                      .join(' · ')}
                </div>
              )}
            </Tooltip>
          </Card>
        </Col>
      </Row>

      {/* ===== 次要指标（3 个，简化为一行小卡） ===== */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} sm={8}>
          <Card
            size="small"
            hoverable
            onClick={() => navigate('/transactions?type=dividend&status=confirmed')}
          >
            <Statistic
              title="累计分红"
              value={totalDividend}
              formatter={moneyStatFormatter}
              valueStyle={{ color: totalDividend > 0 ? pnlColor(totalDividend) : undefined, fontWeight: 600 }}
              prefix="💰"
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card
            size="small"
            hoverable
            onClick={() => navigate(`/transactions?date=${todayStr}&type=buy`)}
          >
            <Statistic
              title={`今日投入（${todayStr}）`}
              value={todayInvested.total}
              formatter={moneyStatFormatter}
              valueStyle={{ color: todayInvested.total > 0 ? '#1677ff' : undefined, fontWeight: 600 }}
              prefix={<FundOutlined />}
            />
            {/* 卡片合计含「今日应执行但尚未发生的定投」—— 点进去的列表里没有对应
                记录，差额必须自己说清楚，否则用户以为数字算错了。
                formatMoney 不带 ¥，这里自己加。 */}
            <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
              交易 ¥{formatMoney(todayInvested.txAmount)} ｜ 待执行定投 ¥{formatMoney(todayInvested.planAmount)}
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card
            size="small"
            hoverable
            onClick={() => navigate('/funds')}
          >
            <Statistic
              title="持仓基金"
              value={funds.length}
              suffix="只"
              valueStyle={{ color: '#1677ff', fontWeight: 600 }}
              prefix={<FundOutlined />}
            />
          </Card>
        </Col>
      </Row>

      {/* ===== 组合信号排行（按每只基金的 MA250 偏离度聚焦） ===== */}
      <div style={{ marginTop: 16 }}>
        <Row gutter={16}>
          {/* 低估信号 */}
          <Col xs={24} md={12}>
            <Card
              title={
                <span style={{ color: '#1677ff' }}>
                  ❄️ 低估信号（MA250 &lt; −15%）
                </span>
              }
              extra={
                <span style={{ fontSize: 12, color: '#999' }}>
                  {portfolioSignals.undervalued.length} 只
                </span>
              }
              styles={{ body: { padding: portfolioSignals.undervalued.length === 0 ? 24 : 12 } }}
            >
              {portfolioSignals.undervalued.length === 0 ? (
                <div style={{ color: '#999', textAlign: 'center' }}>
                  {portfolioSignals.historyReadyCount === 0
                    ? '组合尚无 ≥ 250 个交易日的基金'
                    : '组合无 MA250 偏离度 < −15% 的基金'}
                </div>
              ) : (
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {portfolioSignals.undervalued.map(({ fund, deviation }) => {
                    const color = TEMPERATURE_COLORS[classifyTemperature(deviation)!];
                    return (
                      <div
                        key={fund.id}
                        onClick={() => navigate(`/funds/${fund.id}`)}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '8px 12px',
                          borderRadius: 4,
                          background: '#f5faff',
                          cursor: 'pointer',
                          borderLeft: `3px solid ${color}`,
                        }}
                      >
                        <span style={{ flex: 1, marginRight: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {fund.name}
                        </span>
                        <Tag color={color} style={{ marginRight: 0 }}>
                          {deviation.toFixed(1)}%
                        </Tag>
                      </div>
                    );
                  })}
                </Space>
              )}
            </Card>
          </Col>

          {/* 高估信号 */}
          <Col xs={24} md={12}>
            <Card
              title={
                <span style={{ color: '#cf1322' }}>
                  🔥 高估信号（MA250 &gt; +15%）
                </span>
              }
              extra={
                <span style={{ fontSize: 12, color: '#999' }}>
                  {portfolioSignals.overvalued.length} 只
                </span>
              }
              styles={{ body: { padding: portfolioSignals.overvalued.length === 0 ? 24 : 12 } }}
            >
              {portfolioSignals.overvalued.length === 0 ? (
                <div style={{ color: '#999', textAlign: 'center' }}>
                  {portfolioSignals.historyReadyCount === 0
                    ? '组合尚无 ≥ 250 个交易日的基金'
                    : '组合无 MA250 偏离度 > +15% 的基金'}
                </div>
              ) : (
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {portfolioSignals.overvalued.map(({ fund, deviation }) => {
                    const color = TEMPERATURE_COLORS[classifyTemperature(deviation)!];
                    return (
                      <div
                        key={fund.id}
                        onClick={() => navigate(`/funds/${fund.id}`)}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '8px 12px',
                          borderRadius: 4,
                          background: '#fff5f5',
                          cursor: 'pointer',
                          borderLeft: `3px solid ${color}`,
                        }}
                      >
                        <span style={{ flex: 1, marginRight: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {fund.name}
                        </span>
                        <Tag color={color} style={{ marginRight: 0 }}>
                          {deviation.toFixed(1)}%
                        </Tag>
                      </div>
                    );
                  })}
                </Space>
              )}
            </Card>
          </Col>
        </Row>

        {/* 底部副信息：近 5 日 MACD 信号统计 + 历史就绪度 + 口径说明 */}
        <div style={{ marginTop: 12, color: '#999', fontSize: 12, textAlign: 'center' }}>
          <span>
            近 5 日 MACD：<span style={{ color: '#cf1322', fontWeight: 600 }}>金叉 {portfolioSignals.goldenCrossCount}</span>
            {' '}｜{' '}
            <span style={{ color: '#3f8600', fontWeight: 600 }}>死叉 {portfolioSignals.deathCrossCount}</span>
          </span>
          <span style={{ marginLeft: 12 }}>
            ｜ 历史就绪 {portfolioSignals.historyReadyCount} / {funds.length} 只
          </span>
          <span style={{ marginLeft: 12 }}>
            ｜ 指标按分红复权净值计算；±15% 为固定阈值，对债券等低波动基金基本无分辨力
          </span>
          <Button type="link" size="small" onClick={() => navigate('/settings')}>
            指标说明
          </Button>
        </div>
      </div>

      {/* ===== 市场指数（沪深300 / 创业板 / 中证500 / 纳指100 / 标普500 / 道琼斯） ===== */}
      <MarketIndices />

      {/* ===== 收益日历 ===== */}
      <div style={{ marginTop: 16 }}>
        <ReturnCalendar />
      </div>

      {/* ===== 持仓列表（含类型色条 + 表尾合计行） ===== */}
      <Card
        title="持仓列表"
        style={{ marginTop: 16 }}
        extra={
          <Space>
            <span style={{ color: '#999', fontSize: 12 }}>
              共 {funds.length} 只 ｜ 合计市值 {formatMoneyShortWithSign(totals.totalValue)}
            </span>
            <Button type="link" onClick={() => navigate('/funds')}>
              管理基金 →
            </Button>
          </Space>
        }
      >
        <Table
          dataSource={positions}
          columns={columns}
          rowKey={(record) => record.fund.id}
          pagination={false}
          scroll={{ x: 'max-content' }}
          onRow={(record) => ({
            onClick: () => navigate(`/funds/${record.fund.id}`),
            style: { cursor: 'pointer' },
          })}
          locale={{ emptyText: '暂无持仓，请先添加基金' }}
          summary={() => (
            <Table.Summary fixed>
              <Table.Summary.Row style={{ background: isDark ? '#1d1d1d' : '#fafafa', fontWeight: 600 }}>
                <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                <Table.Summary.Cell index={1}>—</Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="right">
                  {formatMoney(totals.totalCost)}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="right">
                  {formatMoney(totals.totalValue)}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right">
                  <span style={{ color: pnlColor(totals.totalReturn) }}>
                    {totals.totalReturn >= 0 ? '+' : ''}{formatMoney(totals.totalReturn)}
                  </span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={5} align="right">
                  <span style={{ color: pnlColor(totals.totalReturnRate) }}>
                    {totals.totalReturnRate >= 0 ? '+' : ''}{totals.totalReturnRate.toFixed(2)}%
                  </span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={6} align="right">
                  <span style={{ color: totals.totalDailyPnl !== null ? pnlColor(totals.totalDailyPnl) : '#999' }}>
                    {totals.totalDailyPnl === null ? '—' : `${totals.totalDailyPnl >= 0 ? '+' : ''}${formatMoney(totals.totalDailyPnl)}`}
                  </span>
                </Table.Summary.Cell>
              </Table.Summary.Row>
            </Table.Summary>
          )}
        />
      </Card>
    </div>
  );
}

/* ============================================================
 *  旧版组合温度计的 TemperatureBar / MiniHistogram 组件已移除 —
 *  改为上方「组合信号排行」两桶卡片。
 * ============================================================ */
