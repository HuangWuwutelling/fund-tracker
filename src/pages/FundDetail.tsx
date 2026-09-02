import { useMemo, useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Descriptions, Row, Col, Statistic, Table, Button, Tag, Modal, Form, Input, Select, DatePicker, InputNumber, message, Space, Radio, Checkbox, Popconfirm, Alert, Tooltip } from 'antd';
import { ArrowLeftOutlined, PlusOutlined, ImportOutlined } from '@ant-design/icons';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { TooltipComponent, GridComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { calcFundSummary, calcSharesFromAmount, calcShares, onlyConfirmed } from '../utils/calculator';
import { pnlColor, formatDate, formatMoney, today } from '../utils/formatter';
import { lookupNavForDate } from '../utils/navLookup';
import { isNonTradingDay } from '../utils/chineseHolidays';
import InitialPositionModal from '../components/InitialPositionModal';
import { FUND_TYPE_LABELS, TRANSACTION_TYPE_LABELS, FREQUENCY_LABELS } from '../types';
import type { Transaction, DcaPlan, Fund } from '../types';

echarts.use([LineChart, TooltipComponent, GridComponent, CanvasRenderer]);

export default function FundDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { platforms, transactions, getNavHistory, addTransaction, updateTransaction, removeTransaction, getFundById, dcaPlans, addDcaPlan, updateDcaPlan, removeDcaPlan, toggleDcaPlan } = useStore();
  const [txModalOpen, setTxModalOpen] = useState(false);
  const [editingTxId, setEditingTxId] = useState<string | null>(null);
  const [txForm] = Form.useForm();
  const txTypeWatch = Form.useWatch('type', txForm);
  const pendingWatch = Form.useWatch('pending', txForm);
  const [initModalOpen, setInitModalOpen] = useState(false);
  const [navRange, setNavRange] = useState<'1m' | '3m' | '6m' | '1y' | 'all'>('6m');
  const [navPreview, setNavPreview] = useState<{ nav: number; navDate: string } | null>(null);
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
      if (editingDcaId) {
        updateDcaPlan(editingDcaId, plan);
        message.success('已更新');
      } else {
        addDcaPlan(plan);
        message.success('已创建');
      }
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
        ? calcFundSummary(fund, transactions, navHistory, today())
        : { shares: 0, cost: 0, marketValue: 0, totalReturn: 0, returnRate: 0, dailyPnl: null, currNavDate: '', prevNavDate: '', isDailyPnlToday: false, xirr: 0, dividend: 0 },
    [fund, transactions, navHistory]
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

  const navChartOption = useMemo(() => ({
    tooltip: {
      trigger: 'axis' as const,
      formatter: (params: Array<{ name: string; value: number }>) => {
        const p = params[0];
        return p ? `${p.name}<br/>净值: ${p.value.toFixed(4)}` : '';
      },
    },
    grid: { left: 60, right: 20, top: 10, bottom: 30 },
    xAxis: { type: 'category' as const, data: filteredNav.map((r) => r.date) },
    yAxis: { type: 'value' as const, min: 'dataMin', axisLabel: { formatter: (v: number) => v.toFixed(2) } },
    series: [{ type: 'line', data: filteredNav.map((r) => r.nav), smooth: true }],
  }), [filteredNav]);

  const handleSaveTransaction = async () => {
    try {
      const values = await txForm.validateFields();
      const txType = values.type as Transaction['type'];
      const amount = values.amount as number;
      const fee = (values.fee as number) ?? 0;
      const pending = (values.pending as boolean) ?? false;
      // 新增时用自动查到的净值；编辑时用表单里用户确认的值
      const nav = pending
        ? 0
        : editingTxId
          ? ((values.nav as number) ?? 0)
          : (navPreview?.nav ?? 0);
      if (!pending && !editingTxId && (!navPreview || navPreview.nav <= 0)) {
        message.error('无法保存：未找到该日期的成交净值，请检查历史净值或切换为待确认');
        return;
      }
      // 分红：根据 dividendType 决定 amount 和 shares 的语义
      // - 现金分红: amount = 现金金额, shares = 0
      // - 红利再投资: shares = 获得的份额, amount = shares × nav（自动折算）
      let finalAmount: number;
      let finalShares: number;
      let finalFee: number;
      if (txType === 'dividend') {
        const dt = (values.dividendType as 'cash' | 'reinvest') ?? 'cash';
        if (dt === 'cash') {
          finalAmount = (values.amount as number) ?? 0;
          finalShares = 0;
          finalFee = 0;
        } else {
          finalShares = (values.shares as number) ?? 0;
          finalAmount = finalShares * nav;
          finalFee = 0;
        }
      } else {
        finalAmount = amount;
        finalFee = fee;
        finalShares = pending ? 0 : calcSharesFromAmount(amount, fee, nav);
      }

      // 卖出校验：截至当前交易日期的持仓必须 >= 卖出份额
      // 编辑时排除自身，避免重复计算
      if (txType === 'sell' && !pending && finalShares > 0) {
        const txDate = (values.date as dayjs.Dayjs).format('YYYY-MM-DD');
        const priorShares = calcShares(
          onlyConfirmed(transactions).filter(
            (t) => t.fundId === fundRef.id && t.id !== editingTxId && t.date <= txDate
          )
        );
        if (finalShares > priorShares + 0.0001) {
          message.error(
            `卖出份额超过当前持仓：当前 ${priorShares.toFixed(4)} 份，最多可卖 ${priorShares.toFixed(4)} 份`
          );
          return;
        }
      }

      const txData: Partial<Transaction> = {
        type: txType,
        date: (values.date as dayjs.Dayjs).format('YYYY-MM-DD'),
        amount: finalAmount,
        fee: finalFee,
        shares: Math.round(finalShares * 10000) / 10000,
        nav,
        note: values.note as string | undefined,
        status: pending ? 'pending' : 'confirmed',
      };

      if (editingTxId) {
        updateTransaction(editingTxId, txData);
        message.success('已更新');
      } else {
        addTransaction({
          ...txData,
          id: uuid(),
          fundId: fundRef.id,
        } as Transaction);
        message.success(pending ? '已记录为待确认交易' : '交易记录已添加');
      }

      setTxModalOpen(false);
      setEditingTxId(null);
      txForm.resetFields();
    } catch {
      // validation failed
    }
  };

  const handleEditTx = (tx: Transaction) => {
    setEditingTxId(tx.id);
    // 推断分红方式：amount > 0 → 现金分红；shares > 0 → 红利再投资
    const dividendType: 'cash' | 'reinvest' | undefined =
      tx.type === 'dividend' ? (tx.amount > 0 ? 'cash' : 'reinvest') : undefined;
    // 同步 pending 表单字段，否则编辑 pending 交易时 checkbox 默认未勾选，
    // 会触发 nav 缺失校验导致无法保存（T+1 净值未发布的 pending 交易 nav=0）
    txForm.setFieldsValue({
      ...tx,
      date: dayjs(tx.date),
      dividendType,
      pending: tx.status === 'pending',
    });
    // 编辑时同步预览该笔交易的净值
    const dateStr = tx.date;
    const result = lookupNavForDate(fundRef.id, dateStr);
    setNavPreview(result ?? null);
    setTxModalOpen(true);
  };

  /** 表单值变化时：自动从历史净值查找成交净值（新增时） */
  const handleTxFormChange = (changedValues: Record<string, unknown>) => {
    if (!('date' in changedValues) && !('amount' in changedValues) && !('fee' in changedValues) && !('type' in changedValues)) return;
    if (editingTxId) return; // 编辑时不覆盖用户已填的 nav

    const date = txForm.getFieldValue('date') as dayjs.Dayjs | null;
    if (!date) {
      setNavPreview(null);
      return;
    }
    const result = lookupNavForDate(fundRef.id, date.toDate());
    setNavPreview(result ?? null);
  };

  /** 手动刷新净值（用于用户想要取最近交易日的净值） */
  const handleRefreshNav = () => {
    const date = txForm.getFieldValue('date') as dayjs.Dayjs | null;
    if (!date) {
      message.warning('请先选择交易日期');
      return;
    }
    const result = lookupNavForDate(fundRef.id, date.toDate());
    if (result) {
      setNavPreview(result);
      message.success(`使用 ${result.navDate} 的净值 ${result.nav.toFixed(4)}`);
    } else {
      message.warning('未找到该日期之前的净值');
    }
  };

  // 关闭弹窗时清空预览
  useEffect(() => {
    if (!txModalOpen) setNavPreview(null);
  }, [txModalOpen]);

  // 所有 hooks 之后再判断 fund 是否存在——避免深链接刷新时 hooks 数量不一致导致 "Rendered more hooks" 崩溃
  if (!fund) {
    return <Card>基金不存在 <Button onClick={() => navigate('/funds')}>返回</Button></Card>;
  }
  // shadow 让 TS narrow 到 Fund
  const fundRef: Fund = fund;

  const handleConfirmTx = async (tx: Transaction) => {
    if (tx.type === 'dividend') {
      updateTransaction(tx.id, { status: 'confirmed' });
      message.success('已确认');
      return;
    }
    const result = lookupNavForDate(tx.fundId, new Date(tx.date));
    if (!result) {
      message.error(`未找到 ${tx.date} 之前的净值，请稍后重试`);
      return;
    }
    const shares = calcSharesFromAmount(tx.amount, tx.fee, result.nav);
    updateTransaction(tx.id, {
      status: 'confirmed',
      nav: result.nav,
      shares: Math.round(shares * 10000) / 10000,
    });
    message.success(`已确认：${shares.toFixed(4)} 份 @ ${result.nav.toFixed(4)}`);
  };

  const txColumns = [
    { title: '日期', dataIndex: 'date', key: 'date', render: (v: string) => formatDate(v) },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (v: Transaction['type']) => <Tag color={v === 'buy' ? 'red' : v === 'sell' ? 'green' : 'gold'}>{TRANSACTION_TYPE_LABELS[v]}</Tag>,
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
    { title: '净值', dataIndex: 'nav', key: 'nav', align: 'right' as const, render: (v: number) => v.toFixed(4) },
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
          <Button type="link" size="small" onClick={() => handleEditTx(record)}>编辑</Button>
          <Popconfirm title="确定删除？" onConfirm={() => { removeTransaction(record.id); message.success('已删除'); }}>
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

      <Card>
        <Descriptions column={{ xs: 1, sm: 2, md: 4 }} bordered size="small">
          <Descriptions.Item label="基金代码">{fundRef.id}</Descriptions.Item>
          <Descriptions.Item label="基金名称">{fundRef.name}</Descriptions.Item>
          <Descriptions.Item label="平台">{platformName}</Descriptions.Item>
          <Descriptions.Item label="类型"><Tag>{FUND_TYPE_LABELS[fundRef.type]}</Tag></Descriptions.Item>
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
                isNonTradingDay(today())
                  ? '今日为非交易日（A 股 / QDII 休市）'
                  : summary.dailyPnl === null
                  ? summary.currNavDate
                    ? `今日净值未发布（最新 ${summary.currNavDate}，QDII 通常 T+2 延迟）`
                    : '尚无净值数据'
                  : `NAV 归属日 ${summary.currNavDate}（vs ${summary.prevNavDate}）`
              }
            >
              <Statistic
                title="当日盈亏"
                value={summary.dailyPnl ?? '—'}
                precision={2}
                valueStyle={{ color: summary.dailyPnl !== null ? pnlColor(summary.dailyPnl) : undefined }}
              />
              {summary.dailyPnl === null && isNonTradingDay(today()) && (
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>今日休市</div>
              )}
              {summary.dailyPnl === null && !isNonTradingDay(today()) && summary.currNavDate && (
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>净值更新中（最新 {summary.currNavDate}）</div>
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

      <Card title="净值走势" style={{ marginTop: 16 }}>
        <Space style={{ marginBottom: 12 }}>
          <Radio.Group value={navRange} onChange={(e) => setNavRange(e.target.value)} size="small">
            <Radio.Button value="1m">近1月</Radio.Button>
            <Radio.Button value="3m">近3月</Radio.Button>
            <Radio.Button value="6m">近6月</Radio.Button>
            <Radio.Button value="1y">近1年</Radio.Button>
            <Radio.Button value="all">全部</Radio.Button>
          </Radio.Group>
        </Space>
        {filteredNav.length > 0 ? (
          <ReactEChartsCore echarts={echarts} option={navChartOption} style={{ height: 300 }} />
        ) : (
          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
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
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingTxId(null); txForm.resetFields(); setNavPreview(null); setTxModalOpen(true); }}>
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
                  onClick={() => toggleDcaPlan(r.id)}
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
                  <Popconfirm title="确定删除该定投计划？" onConfirm={() => { removeDcaPlan(r.id); message.success('已删除'); }}>
                    <Button type="link" danger size="small">删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={editingTxId ? '编辑交易' : '添加交易'}
        open={txModalOpen}
        onOk={handleSaveTransaction}
        onCancel={() => { setTxModalOpen(false); setEditingTxId(null); setNavPreview(null); txForm.resetFields(); }}
        okText="保存"
        cancelText="取消"
      >
        <Form form={txForm} layout="vertical" initialValues={{ date: dayjs(), type: 'buy', fee: 0, dividendType: 'cash' }} onValuesChange={handleTxFormChange}>
          <Form.Item label="交易类型" name="type" rules={[{ required: true }]}>
            <Select>
              {Object.entries(TRANSACTION_TYPE_LABELS).map(([key, label]) => (
                <Select.Option key={key} value={key}>{label}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="交易日期" name="date" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          {txTypeWatch !== 'dividend' && (
            <>
              <Form.Item label="金额（元）" name="amount" rules={[{ required: true, message: '请输入金额' }]}>
                <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="交易金额" />
              </Form.Item>
              <Form.Item label="手续费（元）" name="fee">
                <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="0" />
              </Form.Item>
            </>
          )}
          {txTypeWatch === 'dividend' && (
            <>
              <Form.Item label="分红方式" name="dividendType" rules={[{ required: true }]}>
                <Radio.Group>
                  <Radio.Button value="cash">现金分红</Radio.Button>
                  <Radio.Button value="reinvest">红利再投资</Radio.Button>
                </Radio.Group>
              </Form.Item>
              <Form.Item shouldUpdate noStyle>
                {() => {
                  const dt = txForm.getFieldValue('dividendType') ?? 'cash';
                  return dt === 'cash' ? (
                    <Form.Item label="分红金额（元）" name="amount" rules={[{ required: true, message: '请输入分红金额' }]}>
                      <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="现金分红金额" />
                    </Form.Item>
                  ) : (
                    <Form.Item label="再投资份额" name="shares" rules={[{ required: true, message: '请输入再投资份额' }]}>
                      <InputNumber style={{ width: '100%' }} min={0} precision={4} placeholder="红利再投资获得的份额" />
                    </Form.Item>
                  );
                }}
              </Form.Item>
            </>
          )}
          <Form.Item name="pending" valuePropName="checked" style={{ marginBottom: 16 }}>
            <Checkbox>待确认（T+1 净值未出，先记账不进入持仓）</Checkbox>
          </Form.Item>

          {/* 新增交易：自动从历史查净值，展示预览 */}
          {!pendingWatch && !editingTxId && navPreview && (
            <Alert
              type="success"
              showIcon
              message={`成交净值：${navPreview.nav.toFixed(4)}（${navPreview.navDate}${navPreview.navDate !== (txForm.getFieldValue('date') as dayjs.Dayjs | null)?.format('YYYY-MM-DD') ? '，最近交易日' : ''}）`}
              description={(() => {
                const amt = (txForm.getFieldValue('amount') as number) ?? 0;
                const fe = (txForm.getFieldValue('fee') as number) ?? 0;
                const s = txTypeWatch !== 'dividend' && amt ? calcSharesFromAmount(amt, fe, navPreview.nav) : null;
                return s !== null ? <>预计份额：<strong>{s.toFixed(4)}</strong> 份<br />（{amt} - {fe}）÷ {navPreview.nav.toFixed(4)}</> : '请输入金额后查看预计份额';
              })()}
              action={<Button size="small" onClick={handleRefreshNav}>刷新净值</Button>}
              style={{ marginBottom: 16 }}
            />
          )}
          {!pendingWatch && !editingTxId && !navPreview && txForm.getFieldValue('date') && (
            <Alert
              type="warning"
              showIcon
              message="未找到该日期的净值"
              description="该日期之前无历史净值数据，请切换为待确认，或先刷新净值"
              action={<Button size="small" onClick={handleRefreshNav}>刷新净值</Button>}
              style={{ marginBottom: 16 }}
            />
          )}

          {/* 编辑交易：保留手动输入净值（默认回填原值） */}
          {!pendingWatch && editingTxId && (
            <Form.Item label="成交净值" name="nav" rules={[{ required: true, message: '请输入成交净值' }]}>
              <InputNumber style={{ width: '100%' }} min={0} step={0.0001} precision={4} />
            </Form.Item>
          )}
          <Form.Item label="备注" name="note">
            <Input placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>

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
