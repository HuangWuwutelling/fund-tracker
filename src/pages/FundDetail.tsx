import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Descriptions, Row, Col, Statistic, Table, Button, Tag, Modal, Form, Select, DatePicker, InputNumber, message, Space, Radio, Popconfirm, Alert, Tooltip } from 'antd';
import { ArrowLeftOutlined, PlusOutlined, ImportOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { TooltipComponent, GridComponent, LegendComponent, MarkLineComponent, MarkPointComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { calcFundSummary, calcShares, calcCost, onlyConfirmed } from '../utils/calculator';
import { STORAGE_WRITE_FAILED_MSG } from '../utils/storage';
import { pnlColor, formatDate, formatMoney, formatPercent } from '../utils/formatter';
import { lookupNavOnOrBefore } from '../utils/navLookup';
import { confirmPendingTx } from '../utils/autoConfirm';
import { usableNavSeries } from '../utils/navPair';
import { sma, computeFundIndicators, buildAdjustedSeries, navScaleFactor, INDICATOR_TOOLTIPS } from '../utils/indicators';
import InitialPositionModal from '../components/InitialPositionModal';
import FundReturnCalendar from '../components/FundReturnCalendar';
import TransactionFormModal from '../components/TransactionFormModal';
import {
  FUND_TYPE_LABELS,
  FUND_TYPE_COLORS,
  FUND_FETCH_FAILURE_LABELS,
  TRANSACTION_TYPE_LABELS,
  TX_TYPE_COLORS,
  FREQUENCY_LABELS,
  LATEST_NAV_PNL_LABEL,
  MACD_STATE_LABELS,
  MACD_STATE_COLORS,
  MACD_STATE_HINTS,
  classifyTemperature,
  TEMPERATURE_COLORS,
  TEMPERATURE_LABELS,
  TEMPERATURE_ADVICE,
} from '../types';
import type { Transaction, DcaPlan, Fund } from '../types';

echarts.use([
  LineChart,
  TooltipComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  CanvasRenderer,
]);

export default function FundDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { platforms, transactions, getNavHistory, updateTransaction, removeTransaction, getFundById, dcaPlans, addDcaPlan, updateDcaPlan, removeDcaPlan, toggleDcaPlan, settings, refreshIssues } = useStore();
  const usQdiiFilterMode = settings.usQdiiFilterMode;
  const [txModalOpen, setTxModalOpen] = useState(false);
  /** 正在编辑的交易（null = 新增）。弹窗本体在 components/TransactionFormModal.tsx */
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [initModalOpen, setInitModalOpen] = useState(false);
  const [navRange, setNavRange] = useState<'1m' | '3m' | '6m' | '1y' | 'all'>('6m');
  const [dcaModalOpen, setDcaModalOpen] = useState(false);
  const [editingDcaId, setEditingDcaId] = useState<string | null>(null);
  const [dcaForm] = Form.useForm();
  const dcaFreqWatch = Form.useWatch('frequency', dcaForm);

  const handleEditDca = (plan: DcaPlan) => {
    setEditingDcaId(plan.id);
    dcaForm.setFieldsValue({
      ...plan,
      startDate: dayjs(plan.startDate),
    });
    setDcaModalOpen(true);
  };

  const handleSaveDca = async () => {
    try {
      const values = await dcaForm.validateFields();
      const frequency = values.frequency as DcaPlan['frequency'];
      const existing = editingDcaId ? dcaPlans.find((p) => p.id === editingDcaId) : null;
      const plan: DcaPlan = {
        id: editingDcaId ?? uuid(),
        fundId: fund!.id,
        amount: values.amount as number,
        frequency,
        dayOfWeek: frequency === 'weekly' || frequency === 'biweekly' ? (values.dayOfWeek as number) : undefined,
        dayOfMonth: frequency === 'monthly' ? (values.dayOfMonth as number) : undefined,
        active: existing?.active ?? true,
        startDate: (values.startDate as dayjs.Dayjs).format('YYYY-MM-DD'),
      };
      // 写盘失败 → 内存状态没变 → 保留弹窗与用户已填的内容，不要当成成功
      const saved = editingDcaId
        ? updateDcaPlan(editingDcaId, plan)
        : addDcaPlan(plan);
      if (!saved) {
        message.error(STORAGE_WRITE_FAILED_MSG, 8);
        return;
      }
      message.success(editingDcaId ? '已更新' : '已创建');
      setDcaModalOpen(false);
      setEditingDcaId(null);
      dcaForm.resetFields();
    } catch {
      // validation failed
    }
  };

  const fund = getFundById(id ?? '');

  const navHistory = useMemo(() => (fund ? getNavHistory(fund.id) : []), [fund, getNavHistory]);
  const fundDcaPlans = useMemo(
    () => (fund ? dcaPlans.filter((p) => p.fundId === fund.id) : []),
    [fund, dcaPlans]
  );
  const summary = useMemo(
    () =>
      fund
        ? calcFundSummary(fund, transactions, navHistory, usQdiiFilterMode)
        : { shares: 0, cost: 0, marketValue: 0, totalReturn: 0, returnRate: 0, dailyPnl: null, currNavDate: '', prevNavDate: '', xirr: 0, dividend: 0 },
    [fund, transactions, navHistory, usQdiiFilterMode]
  );
  const fundTxs = useMemo(
    () =>
      fund
        ? transactions.filter((t) => t.fundId === fund.id).sort((a, b) => b.date.localeCompare(a.date))
        : [],
    [fund, transactions]
  );
  const platformName = fund ? platforms.find((p) => p.id === fund.platformId)?.name ?? '—' : '—';

  // Filter NAV history by range
  const filteredNav = useMemo(() => {
    const now = dayjs();
    let startDate = '';
    switch (navRange) {
      case '1m': startDate = now.subtract(1, 'month').format('YYYY-MM-DD'); break;
      case '3m': startDate = now.subtract(3, 'month').format('YYYY-MM-DD'); break;
      case '6m': startDate = now.subtract(6, 'month').format('YYYY-MM-DD'); break;
      case '1y': startDate = now.subtract(1, 'year').format('YYYY-MM-DD'); break;
      case 'all': startDate = ''; break;
    }
    return startDate
      ? navHistory.filter((r) => r.date >= startDate)
      : navHistory;
  }, [navHistory, navRange]);

  // 平均成本（持仓成本 / 当前份额）—— 用作图上的水平基线
  // 卖出后份额减少，cost 也按比例扣减，所以 avgCost 反映"未卖出部分的平均买入价"
  const avgCost = useMemo(() => {
    if (!fund) return 0;
    const fundTxs = onlyConfirmed(transactions).filter((t) => t.fundId === fund.id);
    const cost = calcCost(fundTxs);
    const shares = calcShares(fundTxs);
    return shares > 0 ? cost / shares : 0;
  }, [fund, transactions]);

  // 区间涨跌（首日 vs 末日 NAV）—— 右上角展示
  const periodChange = useMemo(() => {
    if (filteredNav.length < 2) return null;
    const first = filteredNav[0]!.nav;
    const last = filteredNav[filteredNav.length - 1]!.nav;
    if (first <= 0) return null;
    const change = last - first;
    const changeRate = (change / first) * 100;
    return { first, last, change, changeRate };
  }, [filteredNav]);

  // 交易点位（markPoint）：在日期轴上标注买入 / 卖出 / 分红
  // 用 lookupNavOnOrBefore 把 tx.date 映射到"该日 NAV"，与折线对齐
  const txMarkers = useMemo(() => {
    if (!fund) return { buy: [] as Array<{ name: string; coord: [string, number]; value: number }>, sell: [] as Array<{ name: string; coord: [string, number]; value: number }>, dividend: [] as Array<{ name: string; coord: [string, number]; value: number }> };
    const fundTxs = onlyConfirmed(transactions).filter((t) => t.fundId === fund.id);
    const buy: Array<{ name: string; coord: [string, number]; value: number }> = [];
    const sell: Array<{ name: string; coord: [string, number]; value: number }> = [];
    const dividend: Array<{ name: string; coord: [string, number]; value: number }> = [];
    for (const tx of fundTxs) {
      const nav = lookupNavOnOrBefore(fund.id, tx.date);
      if (!nav) continue;
      const marker = { coord: [nav.navDate, nav.nav] as [string, number], value: nav.nav };
      if (tx.type === 'buy') buy.push({ name: '买', ...marker });
      else if (tx.type === 'sell') sell.push({ name: '卖', ...marker });
      else if (tx.type === 'dividend') dividend.push({ name: '分', ...marker });
    }
    return { buy, sell, dividend };
  }, [fund, transactions]);

  const navChartOption = useMemo(() => {
    const dates = filteredNav.map((r) => r.date);
    const navs = filteredNav.map((r) => r.nav);
    // markLine 需要 series.data 里 yAxis 数值字段
    const costLineData = avgCost > 0 ? [{ yAxis: avgCost, name: `成本均价 ${avgCost.toFixed(4)}` }] : [];

    // MA250：必须基于 usableNavSeries（QDII 美股节假日过滤）上的**分红复权**序列计算，
    // 与下方 MA250 偏离度指标卡**同口径**（否则分红基金会"图上 MA250 偏低、卡片偏离度≈0%"）。
    // 复权序列是乘性缩放，直接叠加在"单位净值"折线上会量纲不符 → 用末点比值
    // navScale 缩回单位净值刻度（无分红基金 adj ≡ nav → 系数 1，图形与旧版逐点一致）。
    // 然后按日期对齐回 filteredNav。前 249 个交易日为 null（暖机期）。
    const usable = fund ? usableNavSeries(fund, navHistory, usQdiiFilterMode) : [];
    const usableDates = usable.map((r) => r.date);
    const usableDateIndex = new Map<string, number>();
    for (let i = 0; i < usableDates.length; i++) usableDateIndex.set(usableDates[i]!, i);
    const adjustedNavs = buildAdjustedSeries(usable).values;
    const navScale = navScaleFactor(adjustedNavs, usable.map((r) => r.nav));
    const usableMa = sma(adjustedNavs, 250).map((v) => (v == null ? null : v * navScale));
    const maAligned: (number | null)[] = dates.map((d) => {
      const idx = usableDateIndex.get(d);
      return idx === undefined ? null : (usableMa[idx] ?? null);
    });

    return {
      tooltip: {
        trigger: 'axis' as const,
        formatter: (params: Array<{ axisValue: string; value: number | null | undefined; seriesName: string; color: string; marker: string }>) => {
          if (!params || params.length === 0) return '';
          const date = params[0]!.axisValue;
          const lines = params
            .filter((p) => p.seriesName !== '成本均价' || p.value === avgCost)
            .map((p) => {
              // null / undefined → "—"（MA250 暖机期；或成本均价不在 yAxis 命中）
              const v = typeof p.value === 'number' ? p.value.toFixed(4) : '—';
              return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px;"></span>${p.seriesName}：<b>${v}</b>`;
            });
          return `<div style="font-weight:600;margin-bottom:4px;">${date}</div>${lines.join('<br/>')}`;
        },
      },
      legend: {
        top: 5,
        right: 80, // 留出右边 80px 给成本均价标签，避免互相挤
        data: ['单位净值', 'MA250', '成本均价'],
        textStyle: { fontSize: 12 },
        // series.name 保持简短供 Tooltip 用，legend 显示长标签让用户一眼能读懂
        formatter: (name: string) => {
          const map: Record<string, string> = {
            '单位净值': '单位净值',
            'MA250': 'MA250 · 250日均线',
            '成本均价': '成本均价',
          };
          return map[name] ?? name;
        },
      },
      grid: { left: 60, right: 20, top: 35, bottom: 30 },
      xAxis: { type: 'category' as const, data: dates, axisLabel: { fontSize: 11 } },
      yAxis: {
        type: 'value' as const,
        min: 'dataMin',
        axisLabel: { formatter: (v: number) => v.toFixed(2), fontSize: 11 },
        splitLine: { lineStyle: { type: 'dashed' as const, color: '#e8e8e8' } },
      },
      series: [
        {
          name: '单位净值',
          type: 'line' as const,
          smooth: true,
          symbol: 'none',
          data: navs,
          lineStyle: { width: 2, color: '#1677ff' },
          areaStyle: { color: 'rgba(22,119,255,0.06)' },
          markPoint: {
            symbol: 'circle',
            symbolSize: 8,
            data: [
              ...txMarkers.buy.map((m) => ({ name: '买', coord: m.coord, itemStyle: { color: '#cf1322' } })),
              ...txMarkers.sell.map((m) => ({ name: '卖', coord: m.coord, itemStyle: { color: '#3f8600' } })),
              ...txMarkers.dividend.map((m) => ({ name: '分', coord: m.coord, itemStyle: { color: '#d48806' } })),
            ],
          },
          markLine: {
            symbol: 'none',
            data: costLineData,
            lineStyle: { color: '#fa8c16', type: 'dashed' as const, width: 1.5 },
            // 标签放进图表内右侧顶部，避免出 grid 被裁
            label: {
              fontSize: 11,
              color: '#fa8c16',
              position: 'insideEndTop',
              distance: [0, -2],
              formatter: `成本均价 ${avgCost > 0 ? avgCost.toFixed(4) : ''}`,
            },
          },
        },
        {
          name: 'MA250',
          type: 'line' as const,
          smooth: true,
          symbol: 'none',
          data: maAligned,
          lineStyle: { width: 1.5, color: '#722ed1' },
          connectNulls: false,
        },
      ],
    };
  }, [filteredNav, avgCost, txMarkers, navHistory, fund, usQdiiFilterMode]);

  /* ============================================================
   *  技术指标：MA250 偏离度 / MACD / 净值回撤百分位
   *  - 基于 usableNavSeries 自动过滤 QDII 美股节假日占位
   *  - 渲染时按日期切回到 filteredNav 范围（图表只画可见区间）
   * ============================================================ */
  const indicators = useMemo(
    () => (fund ? computeFundIndicators(fund, navHistory, usQdiiFilterMode) : null),
    [fund, navHistory, usQdiiFilterMode]
  );

  // 缓存：MA250 卡要 4 处用 classifyTemperature，避免重复调用
  const ma250Level =
    indicators && indicators.ma250Deviation !== null
      ? classifyTemperature(indicators.ma250Deviation)
      : null;

  // 所有 hooks 之后再判断 fund 是否存在——避免深链接刷新时 hooks 数量不一致导致 "Rendered more hooks" 崩溃
  if (!fund) {
    return <Card>基金不存在 <Button onClick={() => navigate('/funds')}>返回</Button></Card>;
  }
  // shadow 让 TS narrow 到 Fund
  const fundRef: Fund = fund;

  const handleConfirmTx = async (tx: Transaction) => {
    // 确认口径只有一份（utils/autoConfirm.ts）：**只有交易当天的净值**能用来
    // 推算份额。本地历史陈旧时不能用「≤ 该日期的最近一条」兜底——那会把旧净值
    // 当成当日成交净值，份额直接算错（2026-08-26 实测多算 13.6 份）。
    const result = confirmPendingTx(tx, getNavHistory(tx.fundId));
    if (!result.ok) {
      message.error(
        result.latestKnownDate
          ? `未收录 ${tx.date} 当天的净值（本地最新到 ${result.latestKnownDate}），` +
            `请稍后重试或手动录入成交净值`
          : `未找到 ${tx.date} 的净值，请稍后重试或手动录入成交净值`,
      );
      return;
    }
    if (!updateTransaction(tx.id, result.patch)) {
      message.error(STORAGE_WRITE_FAILED_MSG, 8);
      return;
    }
    message.success(
      `已确认：${(result.patch.shares ?? 0).toFixed(4)} 份 @ ${(result.patch.nav ?? 0).toFixed(4)}`,
    );
  };

  const txColumns = [
    { title: '日期', dataIndex: 'date', key: 'date', render: (v: string) => formatDate(v) },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 80,
      render: (v: Transaction['type']) => <Tag color={TX_TYPE_COLORS[v]}>{TRANSACTION_TYPE_LABELS[v]}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 80,
      render: (v: string | undefined) =>
        v === 'pending' ? <Tag color="orange">待确认</Tag> : <Tag>已确认</Tag>,
    },
    { title: '金额', dataIndex: 'amount', key: 'amount', align: 'right' as const, render: (v: number) => formatMoney(v) },
    { title: '手续费', dataIndex: 'fee', key: 'fee', align: 'right' as const, render: (v: number) => formatMoney(v) },
    { title: '份额', dataIndex: 'shares', key: 'shares', align: 'right' as const, render: (v: number) => v.toFixed(4) },
    { title: '净值', dataIndex: 'nav', key: 'nav', align: 'right' as const, render: (v: number) => (v > 0 ? v.toFixed(4) : '—') },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string) => v || '—' },
    {
      title: '操作',
      key: 'actions',
      width: 180,
      render: (_: unknown, record: Transaction) => (
        <Space>
          {record.status === 'pending' && (
            <Button type="link" size="small" onClick={() => handleConfirmTx(record)}>确认</Button>
          )}
          <Button type="link" size="small" onClick={() => { setEditingTx(record); setTxModalOpen(true); }}>编辑</Button>
          <Popconfirm title="确定删除？" onConfirm={() => {
            if (!removeTransaction(record.id)) { message.error(STORAGE_WRITE_FAILED_MSG, 8); return; }
            message.success('已删除');
          }}>
            <Button type="link" danger size="small">删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/funds')} style={{ marginBottom: 16 }}>
        返回
      </Button>

      {refreshIssues[fundRef.id] && (
        <Alert
          type="warning"
          showIcon
          message={`该基金净值更新失败（${FUND_FETCH_FAILURE_LABELS[refreshIssues[fundRef.id]!.reason]}，发现于 ${dayjs(refreshIssues[fundRef.id]!.at).format('HH:mm')}）`}
          description={`刷新时被跳过，不会写入错误数据；净值/盈亏停留在最后有效日期（${fundRef.navDate || '未知'}）。可在「基金列表」手动重试。`}
          style={{ marginBottom: 16 }}
          closable
        />
      )}

      <Card>
        <Descriptions column={{ xs: 1, sm: 2, md: 4 }} bordered size="small">
          <Descriptions.Item label="基金代码">{fundRef.id}</Descriptions.Item>
          <Descriptions.Item label="基金名称">{fundRef.name}</Descriptions.Item>
          <Descriptions.Item label="平台">{platformName}</Descriptions.Item>
          <Descriptions.Item label="类型"><Tag color={FUND_TYPE_COLORS[fundRef.type]}>{FUND_TYPE_LABELS[fundRef.type]}</Tag></Descriptions.Item>
          <Descriptions.Item label="最新净值">{fundRef.currentNav.toFixed(4)}</Descriptions.Item>
          <Descriptions.Item label="净值日期">{formatDate(fundRef.navDate)}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col xs={12} sm={12} md={8}>
          <Card><Statistic title="持仓成本" value={summary.cost} precision={2} /></Card>
        </Col>
        <Col xs={12} sm={12} md={8}>
          <Card><Statistic title="当前市值" value={summary.marketValue} precision={2} /></Card>
        </Col>
        <Col xs={12} sm={12} md={8}>
          <Card>
            <Statistic
              title="收益/收益率"
              value={summary.totalReturn}
              precision={2}
              valueStyle={{ color: pnlColor(summary.totalReturn) }}
              formatter={(value) => (
                <span>
                  {formatMoney(Number(value))}
                  <span style={{ fontSize: 14, marginLeft: 8, color: pnlColor(summary.returnRate) }}>
                    {summary.returnRate.toFixed(2)}%
                  </span>
                </span>
              )}
            />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={8}>
          <Card>
            <Tooltip
              title={
                summary.dailyPnl === null
                  ? '该基金可用净值不足 2 期，暂时算不出涨跌'
                  : `净值 ${summary.currNavDate} vs ${summary.prevNavDate}`
              }
            >
              <Statistic
                title={LATEST_NAV_PNL_LABEL}
                value={summary.dailyPnl ?? '—'}
                precision={2}
                valueStyle={{ color: summary.dailyPnl !== null ? pnlColor(summary.dailyPnl) : undefined }}
              />
              {summary.dailyPnl !== null ? (
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>净值 {summary.currNavDate}</div>
              ) : (
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>暂无净值数据</div>
              )}
            </Tooltip>
          </Card>
        </Col>
        <Col xs={12} sm={12} md={8}>
          <Card>
            <Statistic
              title="年化收益率（XIRR）"
              value={summary.xirr}
              suffix="%"
              precision={2}
              valueStyle={{ color: pnlColor(summary.xirr) }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={8}>
          <Card>
            <Statistic
              title="累计分红"
              value={summary.dividend}
              precision={2}
              valueStyle={{ color: summary.dividend > 0 ? pnlColor(summary.dividend) : undefined }}
            />
          </Card>
        </Col>
      </Row>

      {indicators && (
        <Row gutter={16} style={{ marginTop: 16 }}>
          {/* MA250 偏离度 */}
          <Col xs={24} sm={8}>
            <Card>
              <Tooltip title={INDICATOR_TOOLTIPS.ma250}>
                <Statistic
                  title={
                    <span>
                      MA250 偏离度{' '}
                      <QuestionCircleOutlined style={{ color: '#999', fontSize: 12 }} />
                    </span>
                  }
                  value={indicators.ma250Deviation ?? '—'}
                  precision={2}
                  suffix={indicators.ma250Deviation !== null ? '%' : ''}
                  valueStyle={{
                    color: ma250Level ? TEMPERATURE_COLORS[ma250Level] : '#999',
                    fontWeight: 700,
                  }}
                />
              </Tooltip>
              {ma250Level ? (
                <>
                  <Tag color={TEMPERATURE_COLORS[ma250Level]} style={{ marginTop: 4 }}>
                    {TEMPERATURE_LABELS[ma250Level]}
                  </Tag>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 6, lineHeight: 1.4 }}>
                    {TEMPERATURE_ADVICE[ma250Level]}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                  需 {Math.max(0, 250 - indicators.adjustedNavs.length)} 个交易日历史
                </div>
              )}
            </Card>
          </Col>

          {/* MACD 状态 */}
          <Col xs={24} sm={8}>
            <Card>
              <Tooltip title={INDICATOR_TOOLTIPS.macd}>
                <div style={{ color: '#666', fontSize: 13, marginBottom: 8 }}>
                  MACD 状态 <QuestionCircleOutlined style={{ color: '#999', fontSize: 12 }} />
                </div>
                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 700,
                    lineHeight: 1.2,
                    color: MACD_STATE_COLORS[indicators.macdState.state],
                    fontFamily: 'DIN, "Helvetica Neue", Arial, sans-serif',
                  }}
                >
                  {MACD_STATE_LABELS[indicators.macdState.state]}
                </div>
                <div style={{ fontSize: 12, color: '#666', marginTop: 6, lineHeight: 1.4 }}>
                  {MACD_STATE_HINTS[indicators.macdState.state]}
                </div>
                {indicators.macdState.daysSinceCross !== null && (
                  <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                    {indicators.macdState.daysSinceCross === 0 ? '今日' : `${indicators.macdState.daysSinceCross} 天前`}{' '}
                    {indicators.macdState.state === 'golden_cross' ? '形成金叉' : '形成死叉'}
                  </div>
                )}
              </Tooltip>
            </Card>
          </Col>

          {/* 净值回撤百分位 */}
          <Col xs={24} sm={8}>
            <Card>
              <Tooltip title={INDICATOR_TOOLTIPS.drawdown}>
                <div style={{ color: '#666', fontSize: 13, marginBottom: 8 }}>
                  净值回撤百分位 <QuestionCircleOutlined style={{ color: '#999', fontSize: 12 }} />
                </div>
                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 700,
                    lineHeight: 1.2,
                    color: indicators.drawdownPercentile !== null ? '#1677ff' : '#999',
                    fontFamily: 'DIN, "Helvetica Neue", Arial, sans-serif',
                  }}
                >
                  {indicators.drawdownPercentile === null
                    ? '—'
                    : `${indicators.drawdownPercentile.toFixed(0)}%`}
                </div>
                <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>
                  {indicators.drawdownPercentile === null
                    ? '需 ≥ 30 个交易日数据'
                    : indicators.drawdownPercentile >= 80
                      ? '处于历史最便宜 20% 区间'
                      : indicators.drawdownPercentile >= 50
                        ? '处于历史中位偏便宜区间'
                        : '处于历史中位偏贵区间'}
                </div>
              </Tooltip>
            </Card>
          </Col>
        </Row>
      )}

      <FundReturnCalendar fund={fundRef} transactions={transactions} />

      <Card
        title="净值走势"
        style={{ marginTop: 16 }}
        extra={
          periodChange ? (
            <Space size="small">
              <span style={{ color: '#666', fontSize: 12 }}>区间涨跌</span>
              <span style={{ color: pnlColor(periodChange.change), fontWeight: 600, fontSize: 14 }}>
                {periodChange.change >= 0 ? '+' : ''}{periodChange.change.toFixed(4)}
              </span>
              <Tag color={periodChange.change >= 0 ? 'red' : 'green'}>
                {formatPercent(periodChange.changeRate)}
              </Tag>
            </Space>
          ) : null
        }
      >
        <Space style={{ marginBottom: 12 }} wrap>
          <Radio.Group value={navRange} onChange={(e) => setNavRange(e.target.value)} size="small" optionType="button" buttonStyle="solid">
            <Radio.Button value="1m">近1月</Radio.Button>
            <Radio.Button value="3m">近3月</Radio.Button>
            <Radio.Button value="6m">近6月</Radio.Button>
            <Radio.Button value="1y">近1年</Radio.Button>
            <Radio.Button value="all">全部</Radio.Button>
          </Radio.Group>
          {avgCost > 0 && (
            <span style={{ fontSize: 12, color: '#fa8c16' }}>
              <span style={{ display: 'inline-block', width: 16, height: 2, background: '#fa8c16', verticalAlign: 'middle', marginRight: 4 }} />
              成本均价 {avgCost.toFixed(4)}
            </span>
          )}
          <span style={{ fontSize: 12, color: '#999' }}>
            🔴买 🟢卖 🟡分红
          </span>
        </Space>
        {filteredNav.length > 0 ? (
          <ReactEChartsCore echarts={echarts} option={navChartOption} style={{ height: 360 }} notMerge />
        ) : (
          <div style={{ height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
            暂无净值历史数据
          </div>
        )}
      </Card>

      <Card
        title="交易记录"
        style={{ marginTop: 16 }}
        extra={
          <Space>
            <Button icon={<ImportOutlined />} onClick={() => setInitModalOpen(true)}>
              {fundTxs.length === 0 ? '设置初始持仓' : '补登初始持仓'}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingTx(null); setTxModalOpen(true); }}>
              添加交易
            </Button>
          </Space>
        }
      >
        <Table dataSource={fundTxs} columns={txColumns} rowKey="id" pagination={false} />
      </Card>

      <Card
        title="定投计划"
        style={{ marginTop: 16 }}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setDcaModalOpen(true)}>
            添加定投计划
          </Button>
        }
      >
        <Table
          size="small"
          dataSource={fundDcaPlans}
          rowKey="id"
          pagination={false}
          locale={{ emptyText: '暂无定投计划' }}
          columns={[
            {
              title: '每期金额',
              dataIndex: 'amount',
              key: 'amount',
              width: 120,
              align: 'right' as const,
              render: (v: number) => formatMoney(v),
            },
            {
              title: '频率',
              dataIndex: 'frequency',
              key: 'frequency',
              width: 100,
              render: (v: DcaPlan['frequency']) => FREQUENCY_LABELS[v] ?? v,
            },
            {
              title: '执行日',
              key: 'day',
              width: 100,
              render: (_: unknown, r: DcaPlan) => {
                if (r.frequency === 'weekly' || r.frequency === 'biweekly') {
                  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][r.dayOfWeek ?? 0];
                }
                if (r.frequency === 'monthly') return `每月 ${r.dayOfMonth ?? 1} 日`;
                return '—';
              },
            },
            {
              title: '开始日期',
              dataIndex: 'startDate',
              key: 'startDate',
              width: 120,
              render: (v: string) => formatDate(v),
            },
            {
              title: '状态',
              key: 'active',
              width: 100,
              render: (_: unknown, r: DcaPlan) => (
                <Button
                  type="link"
                  size="small"
                  onClick={() => { if (!toggleDcaPlan(r.id)) message.error(STORAGE_WRITE_FAILED_MSG, 8); }}
                  style={{ padding: 0 }}
                >
                  {r.active ? <Tag color="green">启用中</Tag> : <Tag>已停用</Tag>}
                </Button>
              ),
            },
            {
              title: '操作',
              key: 'actions',
              width: 120,
              render: (_: unknown, r: DcaPlan) => (
                <Space>
                  <Button type="link" size="small" onClick={() => handleEditDca(r)}>编辑</Button>
                  <Popconfirm title="确定删除该定投计划？" onConfirm={() => {
                  if (!removeDcaPlan(r.id)) { message.error(STORAGE_WRITE_FAILED_MSG, 8); return; }
                  message.success('已删除');
                }}>
                    <Button type="link" danger size="small">删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <TransactionFormModal
        open={txModalOpen}
        fundId={fundRef.id}
        tx={editingTx}
        onClose={() => { setTxModalOpen(false); setEditingTx(null); }}
      />

      <Modal
        title={editingDcaId ? '编辑定投计划' : '添加定投计划'}
        open={dcaModalOpen}
        onOk={handleSaveDca}
        onCancel={() => { setDcaModalOpen(false); setEditingDcaId(null); dcaForm.resetFields(); }}
        okText="保存"
        cancelText="取消"
      >
        <Form form={dcaForm} layout="vertical" initialValues={{ frequency: 'monthly', startDate: dayjs() }}>
          <Form.Item label="每期金额（元）" name="amount" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} min={0} precision={2} />
          </Form.Item>
          <Form.Item label="定投频率" name="frequency" rules={[{ required: true }]}>
            <Select>
              {Object.entries(FREQUENCY_LABELS).map(([key, label]) => (
                <Select.Option key={key} value={key}>{label}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          {(dcaFreqWatch === 'weekly' || dcaFreqWatch === 'biweekly') && (
            <Form.Item label="周几" name="dayOfWeek" rules={[{ required: true }]}>
              <Select>
                {['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, i) => (
                  <Select.Option key={i} value={i}>{label}</Select.Option>
                ))}
              </Select>
            </Form.Item>
          )}
          {dcaFreqWatch === 'monthly' && (
            <Form.Item label="每月几号" name="dayOfMonth" rules={[{ required: true }]}>
              <InputNumber style={{ width: '100%' }} min={1} max={28} />
            </Form.Item>
          )}
          <Form.Item label="开始日期" name="startDate" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <InitialPositionModal
        fundId={fundRef.id}
        open={initModalOpen}
        onClose={() => setInitModalOpen(false)}
      />
    </div>
  );
}
