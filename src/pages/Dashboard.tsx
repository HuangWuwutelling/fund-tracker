import { useMemo } from 'react';
import { Card, Row, Col, Statistic, Table, Tag, Alert, Button, Tooltip } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../stores';
import { calcFundSummary, calcXIRR, calcDividendTotal, calcTodayInvested } from '../utils/calculator';
import { today } from '../utils/formatter';
import ReturnCalendar from '../components/ReturnCalendar';
import { formatMoney, formatPercent, pnlColor } from '../utils/formatter';



export default function Dashboard() {
  const { funds, transactions, platforms, dcaPlans, getNavHistory } = useStore();
  const navigate = useNavigate();

  const summaries = useMemo(() => {
    const todayStr = today();
    return funds.map((fund) => ({
      fund,
      ...calcFundSummary(fund, transactions, getNavHistory(fund.id), todayStr),
    }));
  }, [funds, transactions, getNavHistory]);

  // 衍生统计：memoize 避免每次渲染重算 + 重复 getNavHistory 调用
  const totals = useMemo(() => {
    const totalValue = summaries.reduce((sum, s) => sum + s.marketValue, 0);
    const totalCost = summaries.reduce((sum, s) => sum + s.cost, 0);
    const totalReturn = totalValue - totalCost;
    const totalReturnRate = totalCost > 0 ? (totalReturn / totalCost) * 100 : 0;
    // 当日盈亏：必须所有基金都有 NAV（即都是交易日）才算总和
    // 任一基金缺失（如新加基金 NAV 还没拉到、或刷新失败）→ 显示"—"，避免误导
    const dailyPnlValues = summaries.map((s) => s.dailyPnl);
    const allHavePnl = summaries.length > 0 && dailyPnlValues.every((v): v is number => v !== null);
    const totalDailyPnl = allHavePnl
      ? (dailyPnlValues as number[]).reduce((sum, v) => sum + v, 0)
      : null;
    return { totalValue, totalCost, totalReturn, totalReturnRate, totalDailyPnl };
  }, [summaries]);

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

  // Pie charts removed per user request.

  const columns = [
    {
      title: '基金名称',
      dataIndex: ['fund', 'name'],
      key: 'name',
      width: 220,
      align: 'left' as const,
      sorter: (a: typeof summaries[0], b: typeof summaries[0]) =>
        a.fund.name.localeCompare(b.fund.name, 'zh-CN'),
      render: (text: string, record: typeof summaries[0]) => (
        <span>
          {text}
          <Tag style={{ marginLeft: 8 }}>{record.fund.id}</Tag>
        </span>
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
      render: (v: number) => formatMoney(v),
    },
    {
      title: '持仓收益',
      dataIndex: 'totalReturn',
      key: 'totalReturn',
      width: 130,
      align: 'right' as const,
      sorter: (a: typeof summaries[0], b: typeof summaries[0]) => a.totalReturn - b.totalReturn,
      render: (v: number) => <span style={{ color: pnlColor(v) }}>{formatMoney(v)}</span>,
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
      title: '当日盈亏',
      dataIndex: 'dailyPnl',
      key: 'dailyPnl',
      width: 130,
      align: 'right' as const,
      sorter: (a: typeof summaries[0], b: typeof summaries[0]) => (a.dailyPnl ?? 0) - (b.dailyPnl ?? 0),
      render: (v: number | null) =>
        v !== null ? (
          <span style={{ color: pnlColor(v) }}>{formatMoney(v)}</span>
        ) : (
          '—'
        ),
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
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic title="总资产" value={totals.totalValue} precision={2} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic
              title="总收益"
              value={totals.totalReturn}
              precision={2}
              valueStyle={{ color: pnlColor(totals.totalReturn) }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic
              title="总收益率"
              value={totals.totalReturnRate}
              suffix="%"
              precision={2}
              valueStyle={{ color: pnlColor(totals.totalReturnRate) }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic
              title={`当日盈亏（${today()}）`}
              value={totals.totalDailyPnl ?? '—'}
              precision={2}
              valueStyle={{ color: totals.totalDailyPnl !== null ? pnlColor(totals.totalDailyPnl) : undefined }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8}>
          <Card>
            <Statistic
              title="年化收益率（XIRR）"
              value={totalXIRR}
              suffix="%"
              precision={2}
              valueStyle={{ color: pnlColor(totalXIRR) }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8}>
          <Card>
            <Statistic
              title="累计分红"
              value={totalDividend}
              precision={2}
              valueStyle={{ color: totalDividend > 0 ? pnlColor(totalDividend) : undefined }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8}>
          <Card>
            <Tooltip
              title={`交易：${formatMoney(todayInvested.txAmount)}  +  定投预期：${formatMoney(todayInvested.planAmount)}`}
            >
              <Statistic
                title={`当日投入（${today()})`}
                value={todayInvested.total}
                precision={2}
                valueStyle={{ color: todayInvested.total > 0 ? '#1677ff' : undefined }}
              />
            </Tooltip>
          </Card>
        </Col>
      </Row>

      <div style={{ marginTop: 16 }}>
        <ReturnCalendar />
      </div>

      <Card title="持仓列表" style={{ marginTop: 16 }}>
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
        />
      </Card>
    </div>
  );
}
