import { useState, useMemo } from 'react';
import { Card, Table, Button, Modal, Form, Select, DatePicker, InputNumber, Switch, Space, Statistic, Row, Col, message, Popconfirm, Tooltip } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { formatMoney } from '../utils/formatter';
import { FREQUENCY_LABELS } from '../types';
import type { DcaPlan } from '../types';

const DAY_OF_WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 判断某笔 buy 交易是否可能是某个定投计划的执行
 * 修复"金额相同的手动买入被算进定投投入"的 bug：加上日期窗口约束
 * - 必须在 plan.startDate 之后
 * - 交易日期必须落在该计划"预期执行日"的合理窗口内
 *   - daily: 任意交易日
 *   - weekly: weekday 偏差 ≤ 3 天（容忍周末顺延）
 *   - biweekly: 同 weekly + 与 startDate 所在周奇偶相同
 *   - monthly: 与当月目标日偏差 ≤ 5 天
 */
function isInPlanWindow(plan: DcaPlan, txDate: string): boolean {
  const tx = dayjs(txDate);
  const start = dayjs(plan.startDate);
  if (tx.isBefore(start, 'day')) return false;

  if (plan.frequency === 'daily') return true;

  if (plan.frequency === 'weekly' || plan.frequency === 'biweekly') {
    if (plan.dayOfWeek === undefined) return false;
    if (Math.abs(tx.day() - plan.dayOfWeek) > 3) return false;
    if (plan.frequency === 'biweekly') {
      // tx 所在周与 startDate 所在周的奇偶性需一致
      const txWeekStart = tx.startOf('week');
      const startWeekStart = start.startOf('week');
      const weekDiff = Math.round(txWeekStart.diff(startWeekStart, 'day') / 7);
      if (weekDiff < 0 || weekDiff % 2 !== 0) return false;
    }
    return true;
  }

  if (plan.frequency === 'monthly') {
    if (plan.dayOfMonth === undefined) return false;
    const txDay = tx.date();
    const daysInMonth = tx.daysInMonth();
    const actualTargetDay = Math.min(plan.dayOfMonth, daysInMonth);
    return Math.abs(txDay - actualTargetDay) <= 5;
  }

  return false;
}

export default function DcaPlans() {
  const { funds, dcaPlans, transactions, addDcaPlan, updateDcaPlan, removeDcaPlan, toggleDcaPlan } = useStore();
  const navigate = useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form] = Form.useForm();

  // DCA statistics: 一笔交易要算作某个计划的执行，必须同时满足：
  //   1) 同基金、买入、已确认
  //   2) 金额匹配（±¥1）
  //   3) 落在该计划的预期执行窗口内（避免金额相同的非定投买入被误算）
  // 多个计划按 dcaPlans 顺序 claim，每笔交易只归属第一个匹配的 plan，避免重复计算。
  const stats = useMemo(() => {
    let totalInvested = 0;
    const usedTxIds = new Set<string>();
    const perFund = new Map<string, { fundId: string; fundName: string; invested: number; txCount: number }>();
    const matchedTxs: Array<{ planId: string; fundName: string; date: string; amount: number }> = [];

    for (const plan of dcaPlans) {
      const fund = funds.find((f) => f.id === plan.fundId);
      if (!fund) continue;

      const planTxs = transactions.filter(
        (t) =>
          t.fundId === plan.fundId &&
          t.type === 'buy' &&
          t.status !== 'pending' &&
          !usedTxIds.has(t.id) &&
          Math.abs(t.amount - plan.amount) < 1 &&
          isInPlanWindow(plan, t.date)
      );
      let planInvested = 0;
      for (const t of planTxs) {
        usedTxIds.add(t.id);
        matchedTxs.push({ planId: plan.id, fundName: fund.name, date: t.date, amount: t.amount });
        planInvested += t.amount;
      }
      totalInvested += planInvested;
      const existing = perFund.get(fund.id) ?? { fundId: fund.id, fundName: fund.name, invested: 0, txCount: 0 };
      perFund.set(fund.id, {
        fundId: fund.id,
        fundName: fund.name,
        invested: existing.invested + planInvested,
        txCount: existing.txCount + planTxs.length,
      });
    }

    return {
      totalInvested,
      perFund: Array.from(perFund.values()).sort((a, b) => b.invested - a.invested),
      matchedTxs,
    };
  }, [dcaPlans, funds, transactions]);

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
      // 15:00 之前定投当天，15:00 之后顺延到下一交易日（周末顺延到周一）
      const cutoff = now.hour(15).minute(0).second(0).millisecond(0);
      let next = now.isBefore(cutoff) ? now : now.add(1, 'day');
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
      align: 'left' as const,
      sorter: (a: DcaPlan, b: DcaPlan) => {
        const an = funds.find((f) => f.id === a.fundId)?.name ?? a.fundId;
        const bn = funds.find((f) => f.id === b.fundId)?.name ?? b.fundId;
        return an.localeCompare(bn, 'zh-CN');
      },
      render: (id: string) => funds.find((f) => f.id === id)?.name ?? id,
    },
    {
      title: '每期金额',
      dataIndex: 'amount',
      key: 'amount',
      align: 'right' as const,
      sorter: (a: DcaPlan, b: DcaPlan) => a.amount - b.amount,
      render: (v: number) => `${formatMoney(v)}`,
    },
    {
      title: '频率',
      dataIndex: 'frequency',
      key: 'frequency',
      align: 'left' as const,
      sorter: (a: DcaPlan, b: DcaPlan) =>
        FREQUENCY_LABELS[a.frequency].localeCompare(FREQUENCY_LABELS[b.frequency], 'zh-CN'),
      render: (v: DcaPlan['frequency']) => FREQUENCY_LABELS[v],
    },
    {
      title: '下次定投',
      key: 'nextDate',
      align: 'left' as const,
      sorter: (a: DcaPlan, b: DcaPlan) => {
        const an = a.active ? getNextDate(a) : '~';
        const bn = b.active ? getNextDate(b) : '~';
        return an.localeCompare(bn);
      },
      render: (_: unknown, record: DcaPlan) => record.active ? getNextDate(record) : '已停用',
    },
    {
      title: '状态',
      key: 'active',
      align: 'center' as const,
      sorter: (a: DcaPlan, b: DcaPlan) => Number(a.active) - Number(b.active),
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
      align: 'center' as const,
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
        <Col xs={24} sm={8}>
          <Card>
            <Tooltip
              title={
                stats.matchedTxs.length > 0 ? (
                  <div>
                    <div>以下已确认买入交易被计入：</div>
                    {stats.matchedTxs.map((m, i) => (
                      <div key={i}>{m.fundName} · {m.date} · {formatMoney(m.amount)}</div>
                    ))}
                  </div>
                ) : '尚无匹配的买入交易'
              }
            >
              <Statistic title="累计投入" value={stats.totalInvested} precision={2} />
            </Tooltip>
          </Card>
        </Col>
      </Row>

      {stats.perFund.length > 0 && (
        <Card title="各基金累计投入" size="small" style={{ marginBottom: 16 }}>
          <Table
            size="small"
            dataSource={stats.perFund}
            rowKey="fundId"
            pagination={false}
            columns={[
              {
                title: '基金',
                dataIndex: 'fundName',
                key: 'fundName',
                align: 'left' as const,
                sorter: (a: typeof stats.perFund[0], b: typeof stats.perFund[0]) =>
                  a.fundName.localeCompare(b.fundName, 'zh-CN'),
                render: (name: string, r: typeof stats.perFund[0]) => (
                  <a onClick={() => navigate(`/funds/${r.fundId}`)}>{name}</a>
                ),
              },
              {
                title: '交易笔数',
                dataIndex: 'txCount',
                key: 'txCount',
                align: 'right' as const,
                width: 100,
                sorter: (a: typeof stats.perFund[0], b: typeof stats.perFund[0]) => a.txCount - b.txCount,
              },
              {
                title: '累计投入',
                dataIndex: 'invested',
                key: 'invested',
                align: 'right' as const,
                width: 160,
                defaultSortOrder: 'descend' as const,
                sorter: (a: typeof stats.perFund[0], b: typeof stats.perFund[0]) => a.invested - b.invested,
                render: (v: number) => formatMoney(v),
              },
            ]}
          />
        </Card>
      )}

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
