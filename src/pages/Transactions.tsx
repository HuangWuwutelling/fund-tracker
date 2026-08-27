import { useState, useMemo } from 'react';
import { Card, Table, Button, Modal, Form, Input, Select, DatePicker, InputNumber, Tag, Space, message, Popconfirm } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { calcSharesFromAmount } from '../utils/calculator';
import { formatMoney, formatDate } from '../utils/formatter';
import { TRANSACTION_TYPE_LABELS } from '../types';
import type { Transaction } from '../types';

export default function Transactions() {
  const { funds, transactions, addTransaction, updateTransaction, removeTransaction } = useStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [filterFund, setFilterFund] = useState<string>('');
  const [filterType, setFilterType] = useState<string>('');

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
      const amount = values.amount as number;
      const fee = (values.fee as number) ?? 0;
      const nav = values.nav as number;
      const shares = txType === 'dividend'
        ? (values.shares as number) ?? 0
        : calcSharesFromAmount(amount, fee, nav);

      const txData: Transaction = {
        id: editingId ?? uuid(),
        fundId: values.fundId as string,
        type: txType,
        date: (values.date as dayjs.Dayjs).format('YYYY-MM-DD'),
        amount,
        fee,
        shares: Math.round(shares * 10000) / 10000,
        nav,
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
    setModalOpen(true);
  };

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
    { title: '金额', dataIndex: 'amount', key: 'amount', align: 'right' as const, render: (v: number) => `¥${formatMoney(v)}` },
    { title: '手续费', dataIndex: 'fee', key: 'fee', align: 'right' as const, render: (v: number) => `¥${formatMoney(v)}` },
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
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingId(null); form.resetFields(); setModalOpen(true); }}>
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
        onCancel={() => { setModalOpen(false); setEditingId(null); form.resetFields(); }}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" initialValues={{ date: dayjs(), type: 'buy', fee: 0 }}>
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
          <Form.Item label="成交净值" name="nav" rules={[{ required: true, message: '请输入净值' }]}>
            <InputNumber style={{ width: '100%' }} min={0} step={0.0001} precision={4} />
          </Form.Item>
          <Form.Item label="备注" name="note">
            <Input placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
