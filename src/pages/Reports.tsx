import { useState, useMemo } from 'react';
import { Card, Tabs, DatePicker, Descriptions, Table, Statistic, Row, Col, Tag, Empty } from 'antd';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { TooltipComponent, GridComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useStore } from '../stores';
import { generateWeeklyReport, generateMonthlyReport, generateDailyReturns, generateMonthlyReturns } from '../utils/reportGenerator';
import { formatMoney, formatPercent, pnlColor } from '../utils/formatter';
import { FREQUENCY_LABELS } from '../types';
import type { Fund, Transaction } from '../types';
import NavLink from '../components/NavLink';
import type { DcaPlanExecution } from '../utils/reportGenerator';

echarts.use([BarChart, LineChart, PieChart, TooltipComponent, GridComponent, LegendComponent, CanvasRenderer]);

const rankingColumns = (navigate: (path: string) => void) => [
  { title: '排名', key: 'rank', render: (_: unknown, __: unknown, i: number) => i + 1, width: 60 },
  {
    title: '基金',
    dataIndex: 'fundName',
    key: 'fundName',
    sorter: (a: { fundName: string }, b: { fundName: string }) => a.fundName.localeCompare(b.fundName, 'zh-CN'),
    render: (name: string, r: { fundId: string }) => (
      <NavLink onClick={() => navigate(`/funds/${r.fundId}`)}>{name}</NavLink>
    ),
  },
  {
    title: '收益',
    dataIndex: 'returnAmount',
    key: 'returnAmount',
    align: 'right' as const,
    sorter: (a: { returnAmount: number }, b: { returnAmount: number }) => a.returnAmount - b.returnAmount,
    render: (v: number) => formatMoney(v),
  },
  {
    title: '收益率',
    dataIndex: 'returnRate',
    key: 'returnRate',
    align: 'right' as const,
    sorter: (a: { returnRate: number }, b: { returnRate: number }) => a.returnRate - b.returnRate,
    render: (v: number) => <span style={{ color: pnlColor(v) }}>{formatPercent(v)}</span>,
  },
];

function WeeklyReportView() {
  const { funds, transactions, dcaPlans, snapshots } = useStore();
  const [date, setDate] = useState(dayjs());
  const navigate = useNavigate();

  const report = useMemo(
    () => generateWeeklyReport(date.toDate(), funds, transactions, dcaPlans, snapshots),
    [date, funds, transactions, dcaPlans, snapshots]
  );

  return (
    <div>
      <DatePicker picker="week" value={date} onChange={(d) => d && setDate(d)} style={{ marginBottom: 16 }} />

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={8}>
          <Card>
            <Statistic
              title="本周收益"
              value={report.totalReturn}
              precision={2}
              valueStyle={{ color: pnlColor(report.totalReturn), fontWeight: 600, fontSize: 24 }}
            />
          </Card>
        </Col>
        <Col xs={8}>
          <Card>
            <Statistic
              title="本周收益率"
              value={report.returnRate}
              suffix="%"
              precision={2}
              valueStyle={{ color: pnlColor(report.returnRate), fontWeight: 600, fontSize: 24 }}
            />
          </Card>
        </Col>
        <Col xs={8}>
          <Card>
            <Statistic title="操作笔数" value={`${report.buyCount}买 / ${report.sellCount}卖 / ${report.dividendCount}分红`} />
          </Card>
        </Col>
      </Row>

      <WeeklyChartCard weekStart={report.weekStart} weekEnd={report.weekEnd} funds={funds} transactions={transactions} />

      <Card
        title={`定投执行（${report.dcaActual} / ${report.dcaExpected} 笔）`}
        style={{ marginBottom: 16 }}
      >
        <Table
          size="small"
          dataSource={report.dcaDetails}
          rowKey="planId"
          pagination={false}
          locale={{ emptyText: '本周无活跃定投计划' }}
          columns={[
            {
              title: '基金',
              dataIndex: 'fundName',
              key: 'fundName',
              render: (name: string, r: DcaPlanExecution) => (
                <NavLink onClick={() => navigate(`/funds/${r.fundId}`)}>{name}</NavLink>
              ),
            },
            {
              title: '频率',
              dataIndex: 'frequency',
              key: 'frequency',
              width: 100,
              render: (v: DcaPlanExecution['frequency']) => FREQUENCY_LABELS[v] ?? v,
            },
            {
              title: '本周',
              key: 'isDueWeek',
              width: 120,
              render: (_: unknown, r: DcaPlanExecution) =>
                r.isDueWeek ? <Tag color="blue">执行周</Tag> : <Tag>非执行周</Tag>,
            },
            {
              title: '期望',
              dataIndex: 'expected',
              key: 'expected',
              width: 80,
              align: 'right' as const,
            },
            {
              title: '实际',
              dataIndex: 'actual',
              key: 'actual',
              width: 80,
              align: 'right' as const,
              render: (v: number, r: DcaPlanExecution) => {
                if (!r.isDueWeek) return <span style={{ color: '#999' }}>—</span>;
                if (v === 0) return <span style={{ color: '#ff4d4f' }}>{v}</span>;
                if (v < r.expected) return <span style={{ color: '#faad14' }}>{v}</span>;
                return <span style={{ color: '#52c41a' }}>{v}</span>;
              },
            },
          ]}
        />
      </Card>

      <Card title="各基金表现排名">
        <Table
          dataSource={report.fundRankings}
          columns={rankingColumns(navigate)}
          rowKey="fundId"
          pagination={false}
          locale={{ emptyText: '暂无基金数据' }}
        />
      </Card>
    </div>
  );
}

function MonthlyReportView() {
  const { funds, transactions, snapshots, platforms } = useStore();
  const [date, setDate] = useState(dayjs());
  const navigate = useNavigate();

  const report = useMemo(
    () => generateMonthlyReport(date.year(), date.month() + 1, funds, transactions, snapshots, platforms),
    [date, funds, transactions, snapshots, platforms]
  );

  return (
    <div>
      <DatePicker picker="month" value={date} onChange={(d) => d && setDate(d)} style={{ marginBottom: 16 }} />

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={8}>
          <Card>
            <Statistic
              title="本月收益"
              value={report.totalReturn}
              precision={2}
              valueStyle={{ color: pnlColor(report.totalReturn) }}
            />
          </Card>
        </Col>
        <Col xs={8}>
          <Card>
            <Statistic
              title="本月收益率"
              value={report.returnRate}
              suffix="%"
              precision={2}
              valueStyle={{ color: pnlColor(report.returnRate) }}
            />
          </Card>
        </Col>
        <Col xs={8}>
          <Card>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="最佳基金">
                {report.bestFund ? (
                  <NavLink onClick={() => navigate(`/funds/${report.bestFund!.fundId}`)}>
                    {report.bestFund.fundName} ({formatPercent(report.bestFund.returnRate)})
                  </NavLink>
                ) : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="最差基金">
                {report.worstFund ? (
                  <NavLink onClick={() => navigate(`/funds/${report.worstFund!.fundId}`)}>
                    {report.worstFund.fundName} ({formatPercent(report.worstFund.returnRate)})
                  </NavLink>
                ) : '—'}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      <MonthlyChartCard
        year={date.year()}
        month={date.month() + 1}
        funds={funds}
        transactions={transactions}
      />

      <Card title="各基金表现排名">
        <Table
          dataSource={report.fundRankings}
          columns={rankingColumns(navigate)}
          rowKey="fundId"
          pagination={false}
          locale={{ emptyText: '暂无基金数据' }}
        />
      </Card>
    </div>
  );
}

export default function Reports() {
  return (
    <Card title="投资报告">
      <Tabs
        items={[
          { key: 'weekly', label: '周报', children: <WeeklyReportView /> },
          { key: 'monthly', label: '月报', children: <MonthlyReportView /> },
        ]}
      />
    </Card>
  );
}

/** 周内每日盈亏柱状图（涨红跌绿） */
function WeeklyChartCard({
  weekStart,
  weekEnd,
  funds,
  transactions,
}: {
  weekStart: string;
  weekEnd: string;
  funds: Fund[];
  transactions: Transaction[];
}) {
  const option = useMemo(() => {
    const all = generateDailyReturns(funds, transactions);
    const inWeek = all.filter((d) => d.date >= weekStart && d.date <= weekEnd);
    if (inWeek.length === 0) return null;
    return {
      tooltip: {
        trigger: 'axis' as const,
        formatter: (params: Array<{ axisValue: string; value: number }>) => {
          const p = params[0];
          if (!p) return '';
          const sign = p.value >= 0 ? '+' : '';
          return `<div style="font-weight:600;margin-bottom:4px;">${p.axisValue}</div>${sign}¥${formatMoney(p.value)}`;
        },
      },
      grid: { left: 60, right: 20, top: 20, bottom: 30 },
      xAxis: { type: 'category' as const, data: inWeek.map((d) => d.date.slice(5)) },
      yAxis: {
        type: 'value' as const,
        axisLabel: {
          formatter: (v: number) => {
            if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
            return v.toFixed(0);
          },
        },
        splitLine: { lineStyle: { type: 'dashed' as const, color: '#e8e8e8' } },
      },
      series: [
        {
          type: 'bar' as const,
          data: inWeek.map((d) => ({
            value: Math.round(d.totalReturn * 100) / 100,
            itemStyle: { color: d.totalReturn >= 0 ? '#cf1322' : '#3f8600' },
          })),
          barMaxWidth: 36,
        },
      ],
    };
  }, [funds, transactions, weekStart, weekEnd]);

  return (
    <Card title="周内每日盈亏" style={{ marginBottom: 16 }}>
      {option ? (
        <ReactEChartsCore echarts={echarts} option={option} style={{ height: 240 }} notMerge />
      ) : (
        <Empty description="本周内无交易日数据" />
      )}
    </Card>
  );
}

/** 月度收益柱状图（全年 12 个月） */
function MonthlyChartCard({
  year,
  month: _month,
  funds,
  transactions,
}: {
  year: number;
  month: number;
  funds: Fund[];
  transactions: Transaction[];
}) {
  const dailyReturns = useMemo(() => generateDailyReturns(funds, transactions), [funds, transactions]);
  const monthlyReturns = useMemo(
    () => generateMonthlyReturns(funds, transactions, dailyReturns, year),
    [funds, transactions, dailyReturns, year]
  );

  const monthOption = useMemo(() => {
    return {
      tooltip: { trigger: 'axis' as const },
      legend: { bottom: 0, data: ['月度收益'] },
      grid: { left: 60, right: 20, top: 20, bottom: 40 },
      xAxis: {
        type: 'category' as const,
        data: monthlyReturns.map((m) => m.month.slice(5) + '月'),
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: {
          formatter: (v: number) => {
            if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
            return v.toFixed(0);
          },
        },
        splitLine: { lineStyle: { type: 'dashed' as const, color: '#e8e8e8' } },
      },
      series: [
        {
          name: '月度收益',
          type: 'bar' as const,
          data: monthlyReturns.map((m) => ({
            value: Math.round(m.totalReturn * 100) / 100,
            itemStyle: { color: m.totalReturn >= 0 ? '#cf1322' : '#3f8600' },
          })),
          barMaxWidth: 32,
        },
      ],
    };
  }, [monthlyReturns]);

  // 平台贡献饼图（数据从外层 MonthlyReport 拿，这里用 useMemo 重算太重，干脆接 props）
  return (
    <Card title="全年月度收益" style={{ marginBottom: 16 }}>
      <ReactEChartsCore echarts={echarts} option={monthOption} style={{ height: 260 }} notMerge />
    </Card>
  );
}
