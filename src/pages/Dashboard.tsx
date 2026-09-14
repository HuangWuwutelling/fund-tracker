import { useMemo } from 'react';
import { Card, Row, Col, Statistic, Table, Tag, Alert, Button, Tooltip, Space } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined, FundOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../stores';
import { calcFundSummary, calcXIRR, calcDividendTotal, calcTodayInvested } from '../utils/calculator';
import { today } from '../utils/formatter';
import { isNonTradingDay } from '../utils/chineseHolidays';
import ReturnCalendar from '../components/ReturnCalendar';
import HoldingsSummary from '../components/HoldingsSummary';
import PortfolioTrendChart from '../components/PortfolioTrendChart';
import {
  formatMoney,
  formatPercent,
  pnlColor,
  pnlBg,
  formatMoneyShortWithSign,
} from '../utils/formatter';
import { FUND_TYPE_LABELS, FUND_TYPE_COLORS, FUND_TYPE_STRIPE_COLORS, LATEST_NAV_PNL_LABEL } from '../types';



export default function Dashboard() {
  const { funds, transactions, platforms, dcaPlans, getNavHistory, settings, freshNavFundIds, navRefreshedAt } = useStore();
  const navigate = useNavigate();
  const isDark = settings.theme === 'dark';

  // todayStr 提到组件层，让 useMemo deps 能感知"跨日"——深夜跨过午夜时下一次渲染
  // 会自动重算 today 格（避免 today 高亮 / 当日盈亏判定卡在前一天）。
  const todayStr = today();
  const summaries = useMemo(() => {
    return funds.map((fund) => ({
      fund,
      ...calcFundSummary(fund, transactions, getNavHistory(fund.id)),
    }));
  }, [funds, transactions, getNavHistory]);

  // 衍生统计：memoize 避免每次渲染重算 + 重复 getNavHistory 调用
  const totals = useMemo(() => {
    const totalValue = summaries.reduce((sum, s) => sum + s.marketValue, 0);
    const totalCost = summaries.reduce((sum, s) => sum + s.cost, 0);
    const totalReturn = totalValue - totalCost;
    const totalReturnRate = totalCost > 0 ? (totalReturn / totalCost) * 100 : 0;

    // 最新净值日盈亏：汇总所有"有可用 NAV 对"的基金。
    // 不做任何发布节奏假设——数字就是各基金最新一对已发布 NAV 的涨跌；
    // 因为不同基金的最新净值日可能不同（A 股今天、QDII 常落后 1 个交易日），
    // 按 currNavDate 分桶展示，把口径直接写在卡片上而不是藏进 tooltip。
    let totalDailyPnl: number | null = null;
    const bucketCount = new Map<string, number>();
    let noNavCount = 0;
    for (const s of summaries) {
      if (s.dailyPnl === null) {
        noNavCount++;
        continue;
      }
      totalDailyPnl = (totalDailyPnl ?? 0) + s.dailyPnl;
      bucketCount.set(s.currNavDate, (bucketCount.get(s.currNavDate) ?? 0) + 1);
    }
    const navDateBuckets = [...bucketCount.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => b.date.localeCompare(a.date));

    return {
      totalValue,
      totalCost,
      totalReturn,
      totalReturnRate,
      totalDailyPnl,
      navDateBuckets,
      noNavCount,
      coveredCount: summaries.length - noNavCount,
    };
  }, [summaries]);

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
  const todayInvested = useMemo(
    () => calcTodayInvested(transactions, dcaPlans),
    [transactions, dcaPlans]
  );

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
      sorter: (a: typeof summaries[0], b: typeof summaries[0]) =>
        a.fund.name.localeCompare(b.fund.name, 'zh-CN'),
      render: (_: unknown, record: typeof summaries[0]) => (
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
      sorter: (a: typeof summaries[0], b: typeof summaries[0]) => {
        const an = platforms.find((p) => p.id === a.fund.platformId)?.name ?? '';
        const bn = platforms.find((p) => p.id === b.fund.platformId)?.name ?? '';
        return an.localeCompare(bn, 'zh-CN');
      },
      render: (_: unknown, record: typeof summaries[0]) =>
        platforms.find((p) => p.id === record.fund.platformId)?.name ?? '—',
    },
    {
      title: '持仓成本',
      dataIndex: 'cost',
      key: 'cost',
      width: 130,
      align: 'right' as const,
      sorter: (a: typeof summaries[0], b: typeof summaries[0]) => a.cost - b.cost,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '当前市值',
      dataIndex: 'marketValue',
      key: 'marketValue',
      width: 130,
      align: 'right' as const,
      defaultSortOrder: 'descend' as const,
      sorter: (a: typeof summaries[0], b: typeof summaries[0]) => a.marketValue - b.marketValue,
      render: (v: number) => <span style={{ fontWeight: 500 }}>{formatMoney(v)}</span>,
    },
    {
      title: '持仓收益',
      dataIndex: 'totalReturn',
      key: 'totalReturn',
      width: 130,
      align: 'right' as const,
      sorter: (a: typeof summaries[0], b: typeof summaries[0]) => a.totalReturn - b.totalReturn,
      render: (v: number) => <span style={{ color: pnlColor(v), fontWeight: 500 }}>{formatMoney(v)}</span>,
    },
    {
      title: '收益率',
      dataIndex: 'returnRate',
      key: 'returnRate',
      width: 100,
      align: 'right' as const,
      sorter: (a: typeof summaries[0], b: typeof summaries[0]) => a.returnRate - b.returnRate,
      render: (v: number) => <span style={{ color: pnlColor(v) }}>{formatPercent(v)}</span>,
    },
    {
      title: LATEST_NAV_PNL_LABEL,
      dataIndex: 'dailyPnl',
      key: 'dailyPnl',
      width: 150,
      align: 'right' as const,
      sorter: (a: typeof summaries[0], b: typeof summaries[0]) => (a.dailyPnl ?? 0) - (b.dailyPnl ?? 0),
      render: (_v: number | null, record: typeof summaries[0]) => {
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
      {pendingCount > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`您有 ${pendingCount} 笔未确认交易${pendingAmount > 0 ? `，合计 ${formatMoney(pendingAmount)}` : ''}`}
          description="这些交易还未生效（T+1 净值待发布），不影响当前持仓显示。点击下方按钮确认份额。"
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
          <Card size="small">
            <Statistic
              title="累计分红"
              value={totalDividend}
              precision={2}
              valueStyle={{ color: totalDividend > 0 ? pnlColor(totalDividend) : undefined, fontWeight: 600 }}
              prefix="💰"
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Tooltip title={`交易：${formatMoney(todayInvested.txAmount)}  +  定投预期：${formatMoney(todayInvested.planAmount)}`}>
            <Card size="small">
              <Statistic
                title={`今日投入（${today()}）`}
                value={todayInvested.total}
                precision={2}
                valueStyle={{ color: todayInvested.total > 0 ? '#1677ff' : undefined, fontWeight: 600 }}
                prefix={<FundOutlined />}
              />
            </Card>
          </Tooltip>
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

      {/* ===== 组合走势图 ===== */}
      <PortfolioTrendChart />

      {/* ===== 收益日历 ===== */}
      <div style={{ marginTop: 16 }}>
        <ReturnCalendar />
      </div>

      {/* ===== 持仓汇总（按平台 / 类型） ===== */}
      <HoldingsSummary summaries={summaries} platforms={platforms} />

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
          dataSource={summaries}
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
