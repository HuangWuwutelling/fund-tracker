import { useMemo, useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Descriptions, Row, Col, Statistic, Table, Button, Tag, Modal, Form, Input, Select, DatePicker, InputNumber, message, Space, Radio, Checkbox, Popconfirm, Alert } from 'antd';
import { ArrowLeftOutlined, PlusOutlined, ImportOutlined } from '@ant-design/icons';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { TooltipComponent, GridComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { calcFundSummary, calcSharesFromAmount } from '../utils/calculator';
import { pnlColor, formatDate, formatMoney } from '../utils/formatter';
import { lookupNavForDate } from '../utils/navLookup';
import InitialPositionModal from '../components/InitialPositionModal';
import { FUND_TYPE_LABELS, TRANSACTION_TYPE_LABELS } from '../types';
import type { Transaction } from '../types';

echarts.use([LineChart, TooltipComponent, GridComponent, CanvasRenderer]);

export default function FundDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { platforms, transactions, getNavHistory, addTransaction, updateTransaction, removeTransaction, getFundById } = useStore();
  const [txModalOpen, setTxModalOpen] = useState(false);
  const [editingTxId, setEditingTxId] = useState<string | null>(null);
  const [txForm] = Form.useForm();
  const txTypeWatch = Form.useWatch('type', txForm);
  const pendingWatch = Form.useWatch('pending', txForm);
  const [initModalOpen, setInitModalOpen] = useState(false);
  const [navRange, setNavRange] = useState<'1m' | '3m' | '6m' | '1y' | 'all'>('6m');
  const [navPreview, setNavPreview] = useState<{ nav: number; navDate: string } | null>(null);

  const fund = getFundById(id ?? '');
  if (!fund) {
    return <Card>基金不存在 <Button onClick={() => navigate('/funds')}>返回</Button></Card>;
  }

  const navHistory = getNavHistory(fund.id);
  const summary = calcFundSummary(fund, transactions, navHistory);
  const fundTxs = transactions.filter((t) => t.fundId === fund.id).sort((a, b) => b.date.localeCompare(a.date));
  const platformName = platforms.find((p) => p.id === fund.platformId)?.name ?? '—';

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
      // 分红：表单"获得份额"字段实际存的是现金金额(元)，挪到 amount 字段，shares=0
      const dividendCash = txType === 'dividend' ? ((values.shares as number) ?? 0) : 0;
      const shares = txType === 'dividend'
        ? 0
        : pending ? 0 : calcSharesFromAmount(amount, fee, nav);

      const txData: Partial<Transaction> = {
        type: txType,
        date: (values.date as dayjs.Dayjs).format('YYYY-MM-DD'),
        amount: txType === 'dividend' ? dividendCash : amount,
        fee: txType === 'dividend' ? 0 : fee,
        shares: Math.round(shares * 10000) / 10000,
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
          fundId: fund.id,
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
    txForm.setFieldsValue({
      ...tx,
      date: dayjs(tx.date),
    });
    // 编辑时同步预览该笔交易的净值
    const dateStr = tx.date;
    const result = lookupNavForDate(fund.id, dateStr);
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
    const result = lookupNavForDate(fund.id, date.toDate());
    setNavPreview(result ?? null);
  };

  /** 手动刷新净值（用于用户想要取最近交易日的净值） */
  const handleRefreshNav = () => {
    const date = txForm.getFieldValue('date') as dayjs.Dayjs | null;
    if (!date) {
      message.warning('请先选择交易日期');
      return;
    }
    const result = lookupNavForDate(fund.id, date.toDate());
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
    { title: '金额', dataIndex: 'amount', key: 'amount', align: 'right' as const, render: (v: number) => `${formatMoney(v)}` },
    { title: '手续费', dataIndex: 'fee', key: 'fee', align: 'right' as const, render: (v: number) => `${formatMoney(v)}` },
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
          <Descriptions.Item label="基金代码">{fund.id}</Descriptions.Item>
          <Descriptions.Item label="基金名称">{fund.name}</Descriptions.Item>
          <Descriptions.Item label="平台">{platformName}</Descriptions.Item>
          <Descriptions.Item label="类型"><Tag>{FUND_TYPE_LABELS[fund.type]}</Tag></Descriptions.Item>
          <Descriptions.Item label="最新净值">{fund.currentNav.toFixed(4)}</Descriptions.Item>
          <Descriptions.Item label="净值日期">{formatDate(fund.navDate)}</Descriptions.Item>
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
              title="收益率"
              value={summary.returnRate}
              suffix="%"
              precision={2}
              valueStyle={{ color: pnlColor(summary.returnRate) }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={8}>
          <Card>
            <Statistic
              title="当日盈亏"
              value={summary.dailyPnl ?? 0}
              precision={2}
              valueStyle={{ color: pnlColor(summary.dailyPnl ?? 0) }}
            />
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

      <Modal
        title={editingTxId ? '编辑交易' : '添加交易'}
        open={txModalOpen}
        onOk={handleSaveTransaction}
        onCancel={() => { setTxModalOpen(false); setEditingTxId(null); setNavPreview(null); txForm.resetFields(); }}
        okText="保存"
        cancelText="取消"
      >
        <Form form={txForm} layout="vertical" initialValues={{ date: dayjs(), type: 'buy', fee: 0 }} onValuesChange={handleTxFormChange}>
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
          <Form.Item label="金额（元）" name="amount" rules={[{ required: true, message: '请输入金额' }]}>
            <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="交易金额" />
          </Form.Item>
          <Form.Item label="手续费（元）" name="fee">
            <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="0" />
          </Form.Item>
          {txTypeWatch === 'dividend' && (
            <Form.Item label="获得份额" name="shares" rules={[{ required: true, message: '请输入获得份额（现金分红填 0）' }]}>
              <InputNumber style={{ width: '100%' }} min={0} precision={4} placeholder="现金分红填 0" />
            </Form.Item>
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

      <InitialPositionModal
        fundId={fund.id}
        open={initModalOpen}
        onClose={() => setInitModalOpen(false)}
      />
    </div>
  );
}
