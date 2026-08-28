import { useState, useMemo } from 'react';
import { Card, Tabs, DatePicker, Descriptions, Table, Statistic, Row, Col } from 'antd';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { TitleComponent, TooltipComponent, LegendComponent, GridComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import dayjs from 'dayjs';
import { useStore } from '../stores';
import { generateWeeklyReport, generateMonthlyReport } from '../utils/reportGenerator';
import { formatMoney, formatPercent, pnlColor } from '../utils/formatter';

echarts.use([LineChart, BarChart, TitleComponent, TooltipComponent, LegendComponent, GridComponent, CanvasRenderer]);

function WeeklyReportView() {
  const { funds, transactions, dcaPlans, snapshots } = useStore();
  const [date, setDate] = useState(dayjs());

  const report = useMemo(
    () => generateWeeklyReport(date.toDate(), funds, transactions, dcaPlans, snapshots),
    [date, funds, transactions, dcaPlans, snapshots]
  );

  const rankingColumns = [
    { title: '排名', key: 'rank', render: (_: unknown, __: unknown, i: number) => i + 1, width: 60 },
    { title: '基金', dataIndex: 'fundName', key: 'fundName' },
    { title: '收益', dataIndex: 'returnAmount', key: 'returnAmount', align: 'right' as const, render: (v: number) => `${formatMoney(v)}` },
    {
      title: '收益率',
      dataIndex: 'returnRate',
      key: 'returnRate',
      align: 'right' as const,
      render: (v: number) => <span style={{ color: pnlColor(v) }}>{formatPercent(v)}</span>,
    },
  ];

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
              valueStyle={{ color: pnlColor(report.totalReturn) }}
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
              valueStyle={{ color: pnlColor(report.returnRate) }}
            />
          </Card>
        </Col>
        <Col xs={8}>
          <Card>
            <Statistic title="操作笔数" value={`${report.buyCount}买 / ${report.sellCount}卖 / ${report.dividendCount}分红`} />
          </Card>
        </Col>
      </Row>

      <Card title="定投执行" style={{ marginBottom: 16 }}>
        <Descriptions>
          <Descriptions.Item label="计划执行">
            {report.dcaActual} / {report.dcaExpected} 笔
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="各基金表现排名">
        <Table
          dataSource={report.fundRankings}
          columns={rankingColumns}
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

  const report = useMemo(
    () => generateMonthlyReport(date.year(), date.month() + 1, funds, transactions, snapshots, platforms),
    [date, funds, transactions, snapshots, platforms]
  );

  const lineOption = {
    tooltip: { trigger: 'axis' as const },
    grid: { left: 60, right: 20, top: 10, bottom: 30 },
    xAxis: { type: 'category' as const, data: report.snapshots.map((s) => s.date) },
    yAxis: { type: 'value' as const, axisLabel: { formatter: '{value}' } },
    series: [{ type: 'line', data: report.snapshots.map((s) => s.totalValue), smooth: true, areaStyle: { opacity: 0.1 } }],
  };

  const platformBarOption = {
    tooltip: { trigger: 'axis' as const },
    grid: { left: 100, right: 20, top: 10, bottom: 30 },
    xAxis: { type: 'value' as const, axisLabel: { formatter: '{value}' } },
    yAxis: { type: 'category' as const, data: report.platformContributions.map((p) => p.name) },
    series: [{ type: 'bar', data: report.platformContributions.map((p) => p.returnAmount) }],
  };

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
                {report.bestFund ? `${report.bestFund.fundName} (${formatPercent(report.bestFund.returnRate)})` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="最差基金">
                {report.worstFund ? `${report.worstFund.fundName} (${formatPercent(report.worstFund.returnRate)})` : '—'}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      <Card title="资产变化" style={{ marginBottom: 16 }}>
        {report.snapshots.length > 0 ? (
          <ReactEChartsCore echarts={echarts} option={lineOption} style={{ height: 250 }} />
        ) : (
          <div style={{ height: 250, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
            本月暂无快照数据
          </div>
        )}
      </Card>

      <Card title="各平台收益贡献">
        <ReactEChartsCore echarts={echarts} option={platformBarOption} style={{ height: 200 }} />
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
