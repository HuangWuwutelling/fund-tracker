import { useState, useMemo, useEffect } from 'react';
import { Card, Table, Button, Modal, Form, Input, Select, DatePicker, InputNumber, Tag, Space, message, Popconfirm, Alert } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { calcSharesFromAmount } from '../utils/calculator';
import { formatMoney, formatDate } from '../utils/formatter';
import { lookupNavForDate } from '../utils/navLookup';
import { TRANSACTION_TYPE_LABELS } from '../types';
import type { Transaction } from '../types';

export default function Transactions() {
  const { funds, transactions, addTransaction, updateTransaction, removeTransaction } = useStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [filterFund, setFilterFund] = useState<string>('');
  const [filterType, setFilterType] = useState<string>('');
  const [preview, setPreview] = useState<{ shares: number | null; nav: number | null; navDate: string | null }>({
    shares: null,
    nav: null,
    navDate: null,
  });

  const filteredTxs = useMemo(() => {
    let list = [...transactions];
    if (filterFund) list = list.filter((t) => t.fundId === filterFund);
    if (filterType) list = list.filter((t) => t.type === filterType);
    return list.sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, filterFund, filterType]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const txType = values.type as Transaction['type'];
      const amount = (values.amount as number) ?? 0;
      const fee = (values.fee as number) ?? 0;
      const nav = preview.nav;

      // Block save when NAV is missing for non-dividend types
      if (txType !== 'dividend' && (nav === null || nav <= 0)) {
        message.error('无法保存：未找到该日期的成交净值，请先加载该基金的历史净值');
        return;
      }

      const shares = txType === 'dividend'
        ? 0
        : calcSharesFromAmount(amount, fee, nav ?? 0);

      const txData: Transaction = {
        id: editingId ?? uuid(),
        fundId: values.fundId as string,
        type: txType,
        date: (values.date as dayjs.Dayjs).format('YYYY-MM-DD'),
        amount,
        fee,
        shares: Math.round(shares * 10000) / 10000,
        nav: nav ?? 0,
        note: values.note as string | undefined,
      };

      if (editingId) {
        updateTransaction(editingId, txData);
        message.success('已更新');
      } else {
        addTransaction(txData);
        message.success('已添加');
      }

      setModalOpen(false);
      setEditingId(null);
      form.resetFields();
      setPreview({ shares: null, nav: null, navDate: null });
    } catch {
      // validation failed
    }
  };

  const handleEdit = (tx: Transaction) => {
    setEditingId(tx.id);
    form.setFieldsValue({
      ...tx,
      date: dayjs(tx.date),
    });
    setPreview({ shares: tx.shares, nav: tx.nav, navDate: tx.date });
    setModalOpen(true);
  };

  // Recompute preview whenever relevant fields change
  const handleFormChange = (changedValues: Record<string, unknown>) => {
    const fundId = (form.getFieldValue('fundId') as string) || '';
    const date = form.getFieldValue('date') as dayjs.Dayjs | null;
    const amount = form.getFieldValue('amount') as number;
    const fee = (form.getFieldValue('fee') as number) ?? 0;
    const txType = form.getFieldValue('type') as Transaction['type'];

    let nav: number | null = preview.nav;
    let navDate: string | null = preview.navDate;

    // Re-lookup NAV when fund or date changes
    if ('fundId' in changedValues || 'date' in changedValues) {
      if (fundId && date) {
        const result = lookupNavForDate(fundId, date.toDate());
        if (result) {
          nav = result.nav;
          navDate = result.navDate;
        } else {
          nav = null;
          navDate = null;
        }
      } else {
        nav = null;
        navDate = null;
      }
    }

    // Compute shares preview
    let shares: number | null = null;
    if (txType !== 'dividend' && nav && amount) {
      shares = calcSharesFromAmount(amount, fee, nav);
    }

    setPreview({ shares, nav, navDate });
  };

  // Manual NAV refresh button (in case user picks a date that needs fallback to prior trading day)
  const handleRefreshNav = () => {
    const fundId = (form.getFieldValue('fundId') as string) || '';
    const date = form.getFieldValue('date') as dayjs.Dayjs | null;
    if (!fundId || !date) {
      message.warning('请先选择基金和日期');
      return;
    }
    const result = lookupNavForDate(fundId, date.toDate());
    if (result) {
      setPreview((p) => ({ ...p, nav: result.nav, navDate: result.navDate }));
      message.success(`使用 ${result.navDate} 的净值 ${result.nav.toFixed(4)}`);
    } else {
      message.warning('未找到该日期之前的净值');
    }
  };

  // Reset preview when modal closes
  useEffect(() => {
    if (!modalOpen) {
      setPreview({ shares: null, nav: null, navDate: null });
    }
  }, [modalOpen]);

  const columns = [
    { title: '日期', dataIndex: 'date', key: 'date', render: (v: string) => formatDate(v) },
    {
      title: '基金',
      dataIndex: 'fundId',
      key: 'fund',
      render: (id: string) => funds.find((f) => f.id === id)?.name ?? id,
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (v: Transaction['type']) => (
        <Tag color={v === 'buy' ? 'red' : v === 'sell' ? 'green' : 'gold'}>
          {TRANSACTION_TYPE_LABELS[v]}
        </Tag>
      ),
    },
    { title: '金额', dataIndex: 'amount', key: 'amount', align: 'right' as const, render: (v: number) => `${formatMoney(v)}` },
    { title: '手续费', dataIndex: 'fee', key: 'fee', align: 'right' as const, render: (v: number) => `${formatMoney(v)}` },
    { title: '份额', dataIndex: 'shares', key: 'shares', align: 'right' as const, render: (v: number) => v.toFixed(4) },
    { title: '净值', dataIndex: 'nav', key: 'nav', align: 'right' as const, render: (v: number) => v.toFixed(4) },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string) => v || '—' },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_: unknown, record: Transaction) => (
        <Space>
          <Button type="link" size="small" onClick={() => handleEdit(record)}>编辑</Button>
          <Popconfirm title="确定删除？" onConfirm={() => { removeTransaction(record.id); message.success('已删除'); }}>
            <Button type="link" danger size="small">删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="交易记录"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingId(null); form.resetFields(); setPreview({ shares: null, nav: null, navDate: null }); setModalOpen(true); }}>
          添加交易
        </Button>
      }
    >
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          placeholder="筛选基金"
          style={{ width: 160 }}
          value={filterFund || undefined}
          onChange={(v) => setFilterFund(v ?? '')}
        >
          {funds.map((f) => (
            <Select.Option key={f.id} value={f.id}>{f.name}</Select.Option>
          ))}
        </Select>
        <Select
          allowClear
          placeholder="筛选类型"
          style={{ width: 120 }}
          value={filterType || undefined}
          onChange={(v) => setFilterType(v ?? '')}
        >
          {Object.entries(TRANSACTION_TYPE_LABELS).map(([key, label]) => (
            <Select.Option key={key} value={key}>{label}</Select.Option>
          ))}
        </Select>
      </Space>

      <Table dataSource={filteredTxs} columns={columns} rowKey="id" pagination={{ pageSize: 20 }} />

      <Modal
        title={editingId ? '编辑交易' : '添加交易'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => { setModalOpen(false); setEditingId(null); form.resetFields(); setPreview({ shares: null, nav: null, navDate: null }); }}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" initialValues={{ date: dayjs(), type: 'buy', fee: 0 }} onValuesChange={handleFormChange}>
          <Form.Item label="基金" name="fundId" rules={[{ required: true, message: '请选择基金' }]}>
            <Select placeholder="选择基金">
              {funds.map((f) => (
                <Select.Option key={f.id} value={f.id}>{f.name} ({f.id})</Select.Option>
              ))}
            </Select>
          </Form.Item>
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
            <InputNumber style={{ width: '100%' }} min={0} precision={2} />
          </Form.Item>
          <Form.Item label="手续费（元）" name="fee">
            <InputNumber style={{ width: '100%' }} min={0} precision={2} />
          </Form.Item>
          {/* NAV is hidden - auto-filled from history, shown in preview below */}
          {preview.nav !== null && (
            <Alert
              type="success"
              showIcon
              message={`成交净值：${preview.nav.toFixed(4)}（${preview.navDate}${preview.navDate !== (form.getFieldValue('date') as dayjs.Dayjs | null)?.format('YYYY-MM-DD') ? '，最近交易日' : ''}）`}
              description={
                preview.shares !== null ? (
                  <>预计份额：<strong>{preview.shares.toFixed(4)}</strong> 份<br />（{form.getFieldValue('amount') ?? 0} - {form.getFieldValue('fee') ?? 0}）÷ {preview.nav.toFixed(4)}</>
                ) : '请输入金额后查看预计份额'
              }
              action={<Button size="small" onClick={handleRefreshNav}>刷新净值</Button>}
              style={{ marginBottom: 16 }}
            />
          )}
          {preview.nav === null && (form.getFieldValue('fundId') && form.getFieldValue('date')) && (
            <Alert
              type="warning"
              showIcon
              message="未找到该日期的净值"
              description="该日期之前无历史净值数据，请检查该基金是否已加载历史，或换个日期"
              style={{ marginBottom: 16 }}
            />
          )}
          <Form.Item label="备注" name="note">
            <Input placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}