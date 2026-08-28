import { useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Descriptions, Row, Col, Statistic, Table, Button, Tag, Modal, Form, Input, Select, DatePicker, InputNumber, message, Space, Radio, Alert } from 'antd';
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
import { formatMoney, pnlColor, formatDate } from '../utils/formatter';
import { FUND_TYPE_LABELS, TRANSACTION_TYPE_LABELS } from '../types';
import type { Transaction } from '../types';

echarts.use([LineChart, TooltipComponent, GridComponent, CanvasRenderer]);

export default function FundDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { platforms, transactions, getNavHistory, addTransaction, getFundById } = useStore();
  const [txModalOpen, setTxModalOpen] = useState(false);
  const [txForm] = Form.useForm();
  const txTypeWatch = Form.useWatch('type', txForm);
  const [initModalOpen, setInitModalOpen] = useState(false);
  const [initForm] = Form.useForm();
  const prevFilledCount = useRef(0);
  const [navRange, setNavRange] = useState<'1m' | '3m' | '6m' | '1y' | 'all'>('6m');

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

  const navChartOption = {
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
  };

  const handleAddTransaction = async () => {
    try {
      const values = await txForm.validateFields();
      const txType = values.type as Transaction['type'];
      const amount = values.amount as number;
      const fee = (values.fee as number) ?? 0;
      const nav = values.nav as number;
      const shares = txType === 'dividend'
        ? (values.shares as number) ?? 0
        : calcSharesFromAmount(amount, fee, nav);

      const tx: Transaction = {
        id: uuid(),
        fundId: fund.id,
        type: txType,
        date: (values.date as dayjs.Dayjs).format('YYYY-MM-DD'),
        amount,
        fee,
        shares: Math.round(shares * 10000) / 10000,
        nav,
        note: values.note as string | undefined,
      };

      addTransaction(tx);
      message.success('交易记录已添加');
      setTxModalOpen(false);
      txForm.resetFields();
    } catch {
      // validation failed
    }
  };

  const handleSetInitialPosition = async () => {
    try {
      const values = await initForm.validateFields();
      const shares = values.shares as number;
      const totalCost = values.cost as number;
      const startDate = (values.startDate as dayjs.Dayjs).format('YYYY-MM-DD');
      const nav = values.price as number;

      const tx: Transaction = {
        id: uuid(),
        fundId: fund.id,
        type: 'buy',
        date: startDate,
        amount: totalCost,
        fee: 0,
        shares,
        nav,
        note: '初始持仓',
      };

      addTransaction(tx);
      message.success(`已设置初始持仓：${shares.toFixed(2)} 份，累计成本 ${formatMoney(totalCost)}`);
      setInitModalOpen(false);
      initForm.resetFields();
      prevFilledCount.current = 0;
    } catch {
      // validation failed
    }
  };

  const txColumns = [
    { title: '日期', dataIndex: 'date', key: 'date', render: (v: string) => formatDate(v) },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (v: Transaction['type']) => <Tag color={v === 'buy' ? 'red' : v === 'sell' ? 'green' : 'gold'}>{TRANSACTION_TYPE_LABELS[v]}</Tag>,
    },
    { title: '金额', dataIndex: 'amount', key: 'amount', align: 'right' as const, render: (v: number) => `${formatMoney(v)}` },
    { title: '手续费', dataIndex: 'fee', key: 'fee', align: 'right' as const, render: (v: number) => `${formatMoney(v)}` },
    { title: '份额', dataIndex: 'shares', key: 'shares', align: 'right' as const, render: (v: number) => v.toFixed(4) },
    { title: '净值', dataIndex: 'nav', key: 'nav', align: 'right' as const, render: (v: number) => v.toFixed(4) },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string) => v || '—' },
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
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setTxModalOpen(true)}>
              添加交易
            </Button>
          </Space>
        }
      >
        <Table dataSource={fundTxs} columns={txColumns} rowKey="id" pagination={false} />
      </Card>

      <Modal
        title="添加交易"
        open={txModalOpen}
        onOk={handleAddTransaction}
        onCancel={() => { setTxModalOpen(false); txForm.resetFields(); }}
        okText="添加"
        cancelText="取消"
      >
        <Form form={txForm} layout="vertical" initialValues={{ date: dayjs(), type: 'buy', fee: 0 }}>
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
          <Form.Item label="成交净值" name="nav" rules={[{ required: true, message: '请输入成交净值' }]}>
            <InputNumber style={{ width: '100%' }} min={0} step={0.0001} precision={4} />
          </Form.Item>
          <Form.Item label="备注" name="note">
            <Input placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="设置初始持仓"
        open={initModalOpen}
        onOk={handleSetInitialPosition}
        onCancel={() => { setInitModalOpen(false); initForm.resetFields(); prevFilledCount.current = 0; }}
        okText="确认设置"
        cancelText="取消"
      >
        <Alert
          type="info"
          showIcon
          message="适合已有持仓的情况"
          description="如果你已经定投了一段时间，输入当前持有的份额、平均成本单价和累计投入本金中的任意两项，第三项会自动算出。"
          style={{ marginBottom: 16 }}
        />
        <Form
          form={initForm}
          layout="vertical"
          initialValues={{ startDate: dayjs().subtract(2, 'month') }}
          onValuesChange={(changed, all) => {
            const changedField = Object.keys(changed)[0] as string | undefined;
            if (!changedField || !['shares', 'price', 'cost'].includes(changedField)) return;
            const isFilled = (v: unknown) => typeof v === 'number' && v > 0;
            const { shares, price, cost } = all;
            const filled = [isFilled(shares), isFilled(price), isFilled(cost)].filter(Boolean).length;
            if (filled === 2 && prevFilledCount.current === 1) {
              if (!isFilled(shares) && isFilled(price) && isFilled(cost)) {
                initForm.setFieldValue('shares', +(cost! / price!).toFixed(4));
              } else if (!isFilled(price) && isFilled(shares) && isFilled(cost)) {
                initForm.setFieldValue('price', +(cost! / shares!).toFixed(4));
              } else if (!isFilled(cost) && isFilled(shares) && isFilled(price)) {
                initForm.setFieldValue('cost', +(shares! * price).toFixed(2));
              }
            }
            prevFilledCount.current = filled;
          }}
        >
          <Form.Item label="持仓开始日期" name="startDate" rules={[{ required: true, message: '请选择开始日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="当前持有份额" name="shares" rules={[{ required: true, message: '请输入持有份额' }]}>
            <InputNumber style={{ width: '100%' }} min={0} precision={4} placeholder="例如：1500.50" />
          </Form.Item>
          <Form.Item label="持仓单价（元）" name="price" rules={[{ required: true, message: '请输入持仓单价' }]}>
            <InputNumber style={{ width: '100%' }} min={0} step={0.0001} precision={4} placeholder="例如：1.0928" />
          </Form.Item>
          <Form.Item label="累计投入本金（元）" name="cost" rules={[{ required: true, message: '请输入累计投入' }]}>
            <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="例如：5000" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
