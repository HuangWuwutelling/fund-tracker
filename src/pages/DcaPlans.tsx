import { useState, useMemo } from 'react';
import { Card, Table, Button, Modal, Form, Select, DatePicker, InputNumber, Switch, Space, Statistic, Row, Col, message, Popconfirm } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { calcShares, calcCost, calcMarketValue } from '../utils/calculator';
import { formatMoney, pnlColor } from '../utils/formatter';
import { FREQUENCY_LABELS } from '../types';
import type { DcaPlan } from '../types';

const DAY_OF_WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export default function DcaPlans() {
  const { funds, dcaPlans, transactions, addDcaPlan, updateDcaPlan, removeDcaPlan, toggleDcaPlan } = useStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form] = Form.useForm();

  // DCA statistics: count each fund only once, use only DCA-linked amounts
  const stats = useMemo(() => {
    const seenFundIds = new Set<string>();
    let totalInvested = 0;
    let totalMarketValue = 0;

    for (const plan of dcaPlans) {
      const fund = funds.find((f) => f.id === plan.fundId);
      if (!fund || seenFundIds.has(plan.fundId)) continue;
      seenFundIds.add(plan.fundId);

      // Only count buy transactions that match the DCA amount (approximate DCA buys)
      const planTxs = transactions.filter(
        (t) => t.fundId === plan.fundId && t.type === 'buy' && Math.abs(t.amount - plan.amount) < 1
      );
      const shares = calcShares(planTxs);
      const cost = calcCost(planTxs);
      const marketValue = calcMarketValue(shares, fund.currentNav);
      totalInvested += cost;
      totalMarketValue += marketValue;
    }

    const totalReturn = totalMarketValue - totalInvested;
    const returnRate = totalInvested > 0 ? (totalReturn / totalInvested) * 100 : 0;
    return { totalInvested, totalMarketValue, totalReturn, returnRate };
  }, [dcaPlans, funds, transactions]);
  // Note: when a fund has multiple DCA plans, only the first plan's transactions are counted.
  // For accurate aggregation, ensure each fund has at most one plan, or filter transactions by all plan amounts.

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const frequency = values.frequency as DcaPlan['frequency'];

      const existing = editingId ? dcaPlans.find((p) => p.id === editingId) : null;
      const plan: DcaPlan = {
        id: editingId ?? uuid(),
        fundId: values.fundId as string,
        amount: values.amount as number,
        frequency,
        dayOfWeek: frequency === 'weekly' || frequency === 'biweekly' ? (values.dayOfWeek as number) : undefined,
        dayOfMonth: frequency === 'monthly' ? (values.dayOfMonth as number) : undefined,
        active: existing?.active ?? true,
        startDate: (values.startDate as dayjs.Dayjs).format('YYYY-MM-DD'),
      };

      if (editingId) {
        updateDcaPlan(editingId, plan);
        message.success('已更新');
      } else {
        addDcaPlan(plan);
        message.success('已创建');
      }

      setModalOpen(false);
      setEditingId(null);
      form.resetFields();
    } catch {
      // validation failed
    }
  };

  const handleEdit = (plan: DcaPlan) => {
    setEditingId(plan.id);
    form.setFieldsValue({
      ...plan,
      startDate: dayjs(plan.startDate),
    });
    setModalOpen(true);
  };

  const getNextDate = (plan: DcaPlan): string => {
    const now = dayjs();
    if (plan.frequency === 'daily') {
      // Next trading day: if today is a weekday and past 15:00, assume tomorrow
      // For simplicity, just show next weekday
      let next = now.add(1, 'day');
      while (next.day() === 0 || next.day() === 6) {
        next = next.add(1, 'day');
      }
      return next.format('YYYY-MM-DD');
    }
    if (plan.frequency === 'monthly' && plan.dayOfMonth) {
      let next = now.date(plan.dayOfMonth);
      if (next.isBefore(now, 'day')) next = next.add(1, 'month');
      return next.format('YYYY-MM-DD');
    }
    if (plan.dayOfWeek !== undefined) {
      let next = now.day(plan.dayOfWeek);
      if (next.isBefore(now, 'day')) next = next.add(plan.frequency === 'weekly' ? 1 : 2, 'week');
      return next.format('YYYY-MM-DD');
    }
    return '—';
  };

  const columns = [
    {
      title: '基金',
      dataIndex: 'fundId',
      key: 'fund',
      render: (id: string) => funds.find((f) => f.id === id)?.name ?? id,
    },
    { title: '每期金额', dataIndex: 'amount', key: 'amount', render: (v: number) => `${formatMoney(v)}` },
    {
      title: '频率',
      dataIndex: 'frequency',
      key: 'frequency',
      render: (v: DcaPlan['frequency']) => FREQUENCY_LABELS[v],
    },
    {
      title: '下次定投',
      key: 'nextDate',
      render: (_: unknown, record: DcaPlan) => record.active ? getNextDate(record) : '已停用',
    },
    {
      title: '状态',
      key: 'active',
      render: (_: unknown, record: DcaPlan) => (
        <Switch
          checked={record.active}
          onChange={() => toggleDcaPlan(record.id)}
          checkedChildren="启用"
          unCheckedChildren="停用"
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_: unknown, record: DcaPlan) => (
        <Space>
          <Button type="link" size="small" onClick={() => handleEdit(record)}>编辑</Button>
          <Popconfirm title="确定删除？" onConfirm={() => { removeDcaPlan(record.id); message.success('已删除'); }}>
            <Button type="link" danger size="small">删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={8}>
          <Card><Statistic title="累计投入" value={stats.totalInvested} precision={2} /></Card>
        </Col>
        <Col xs={8}>
          <Card><Statistic title="当前市值" value={stats.totalMarketValue} precision={2} /></Card>
        </Col>
        <Col xs={8}>
          <Card>
            <Statistic
              title="定投收益率"
              value={stats.returnRate}
              suffix="%"
              precision={2}
              valueStyle={{ color: pnlColor(stats.returnRate) }}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title="定投计划"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingId(null); form.resetFields(); setModalOpen(true); }}>
            创建计划
          </Button>
        }
      >
        <Table dataSource={dcaPlans} columns={columns} rowKey="id" pagination={false} locale={{ emptyText: '暂无定投计划' }} />
      </Card>

      <Modal
        title={editingId ? '编辑定投计划' : '创建定投计划'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => { setModalOpen(false); setEditingId(null); form.resetFields(); }}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" initialValues={{ frequency: 'monthly', startDate: dayjs() }}>
          <Form.Item label="基金" name="fundId" rules={[{ required: true }]}>
            <Select placeholder="选择基金">
              {funds.map((f) => (
                <Select.Option key={f.id} value={f.id}>{f.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
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
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.frequency !== cur.frequency}>
            {({ getFieldValue }) => {
              const freq = getFieldValue('frequency');
              if (freq === 'weekly' || freq === 'biweekly') {
                return (
                  <Form.Item label="周几" name="dayOfWeek" rules={[{ required: true }]}>
                    <Select>
                      {DAY_OF_WEEK_LABELS.map((label, i) => (
                        <Select.Option key={i} value={i}>{label}</Select.Option>
                      ))}
                    </Select>
                  </Form.Item>
                );
              }
              if (freq === 'monthly') {
                return (
                  <Form.Item label="每月几号" name="dayOfMonth" rules={[{ required: true }]}>
                    <InputNumber style={{ width: '100%' }} min={1} max={28} />
                  </Form.Item>
                );
              }
              return null;
            }}
          </Form.Item>
          <Form.Item label="开始日期" name="startDate" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
