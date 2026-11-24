import { useState, useMemo, useEffect } from 'react';
import { Card, Table, Button, Modal, Form, Input, Select, DatePicker, InputNumber, Tag, Space, message, Popconfirm, Alert, Checkbox, Radio, Statistic, Row, Col } from 'antd';
import { PlusOutlined, ImportOutlined } from '@ant-design/icons';
import { useSearchParams, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { calcAmountFromShares, calcSharesFromAmount, calcSharesBeforeTx, calcShares, onlyConfirmed } from '../utils/calculator';
import { buildTxDraft, inferDividendType } from '../utils/txFormModel';
import { STORAGE_WRITE_FAILED_MSG } from '../utils/storage';
import { decideNavEntry } from '../utils/navEntry';
import { initialPositionDate } from '../utils/txNormalize';
import { formatMoney, formatDate, pnlColor } from '../utils/formatter';
import { lookupNavOnOrBefore } from '../utils/navLookup';
import { confirmPendingTx } from '../utils/autoConfirm';
import InitialPositionModal from '../components/InitialPositionModal';
import NavLink from '../components/NavLink';
import { TRANSACTION_TYPE_LABELS, TX_TYPE_COLORS } from '../types';
import type { Transaction } from '../types';

export default function Transactions() {
  const { funds, transactions, getNavHistory, addTransaction, updateTransaction, removeTransaction } = useStore();
  const navigate = useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const txTypeWatch = Form.useWatch('type', form);
  const pendingWatch = Form.useWatch('pending', form);
  // 卖出预览用：份额为准反算成交额（买入仍是金额为准）
  const sharesWatch = Form.useWatch('shares', form) as number | undefined;
  const feeWatch = Form.useWatch('fee', form) as number | undefined;
  const dateWatch = Form.useWatch('date', form) as dayjs.Dayjs | undefined;
  const manualNavWatch = Form.useWatch('nav', form) as number | undefined;
  const [filterFund, setFilterFund] = useState<string>('');
  const [filterType, setFilterType] = useState<string>('');
  const [searchParams, setSearchParams] = useSearchParams();
  const pendingOnly = searchParams.get('status') === 'pending';
  const setPendingOnly = (v: boolean) => {
    if (v) setSearchParams({ status: 'pending' });
    else setSearchParams({});
  };
  const [preview, setPreview] = useState<{ shares: number | null; nav: number | null; navDate: string | null }>({
    shares: null,
    nav: null,
    navDate: null,
  });
  const [initModalOpen, setInitModalOpen] = useState(false);

  // 净值是否可用来推算份额：只有**交易当日**的净值才行，"最近交易日"兜底会算错
  const navDecision = useMemo(
    () =>
      decideNavEntry({
        txDate: dateWatch ? dateWatch.format('YYYY-MM-DD') : '',
        lookedUp: preview.nav !== null ? { nav: preview.nav, navDate: preview.navDate ?? '' } : null,
        manualNav: 0,
      }),
    [dateWatch, preview.nav, preview.navDate],
  );

  // 重复计算预警：买入日期早于该基金的初始持仓日期（初始持仓已包含更早的持仓）
  const selectedFundId = form.getFieldValue('fundId') as string;
  const doubleCountRisk = useMemo(() => {
    if (txTypeWatch !== 'buy' || !dateWatch || !selectedFundId) return null;
    const initDate = initialPositionDate(transactions, selectedFundId);
    if (!initDate) return null;
    const txDate = dateWatch.format('YYYY-MM-DD');
    if (txDate >= initDate) return null;
    return `该基金在 ${initDate} 有一条「初始持仓」记录（已包含该日之前的全部持仓）。` +
      `再记 ${txDate} 的买入会与它重复计算——请把初始持仓的份额调减，或把买入日期设在 ${initDate} 之后。`;
  }, [txTypeWatch, dateWatch, selectedFundId, transactions]);

  const filteredTxs = useMemo(() => {
    let list = [...transactions];
    if (filterFund) list = list.filter((t) => t.fundId === filterFund);
    if (filterType) list = list.filter((t) => t.type === filterType);
    if (pendingOnly) list = list.filter((t) => t.status === 'pending');
    return list.sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, filterFund, filterType, pendingOnly]);

  // 汇总：用于表头上方的"本页统计"条（不区分 confirmed/pending，与过滤后列表口径一致）
  const summary = useMemo(() => {
    let buyCount = 0, sellCount = 0, dividendCount = 0;
    let buyAmount = 0, sellAmount = 0, dividendAmount = 0;
    for (const tx of filteredTxs) {
      if (tx.type === 'buy') { buyCount++; buyAmount += tx.amount; }
      else if (tx.type === 'sell') { sellCount++; sellAmount += tx.amount - tx.fee; }
      else { dividendCount++; dividendAmount += tx.amount > 0 ? tx.amount : tx.shares * tx.nav; }
    }
    return { buyCount, sellCount, dividendCount, buyAmount, sellAmount, dividendAmount, net: buyAmount - sellAmount };
  }, [filteredTxs]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const txType = values.type as Transaction['type'];
      const fee = (values.fee as number) ?? 0;
      const pendingFlag = (values.pending as boolean) ?? false;
      const txDate = (values.date as dayjs.Dayjs).format('YYYY-MM-DD');
      const fundIdVal = values.fundId as string;
      const editing = !!editingId;

      // 卖出超额校验需要「该笔交易之前」的持仓份额（编辑时排除自身，避免重复计算）
      const priorShares =
        txType === 'sell'
          ? calcSharesBeforeTx(
              transactions.filter((t) => t.fundId === fundIdVal),
              { id: editingId ?? '', date: txDate },
            )
          : 0;

      // 录入决策只有一份实现（utils/txFormModel.ts）：净值可用性、公式方向、
      // 扣费口径、卖出超额校验都在那里——本页与基金详情页不再各写一遍。
      const draft = buildTxDraft({
        type: txType,
        dividendType: (values.dividendType as 'cash' | 'reinvest') ?? 'cash',
        amount: (values.amount as number) ?? 0,
        fee,
        shares: (values.shares as number) ?? 0,
        // 净值取表单字段：编辑期是用户填的值（可修正错净值），新增期是手动补录的当日净值
        manualNav: (values.nav as number) ?? 0,
        lookedUp: preview.nav !== null ? { nav: preview.nav, navDate: preview.navDate ?? '' } : null,
        txDate,
        pendingFlag,
        editing,
        priorShares,
      });

      if (draft.blocking) {
        message.error(draft.blocking);
        return;
      }
      if (draft.warning) {
        message.warning(draft.warning, 8);
      }

      const txData: Transaction = {
        id: editingId ?? uuid(),
        fundId: fundIdVal,
        type: txType,
        date: txDate,
        amount: draft.amount,
        fee: draft.fee,
        shares: draft.shares,
        nav: draft.nav,
        note: values.note as string | undefined,
        status: draft.status,
      };

      // 写盘失败 → 内存状态没变 → 保留弹窗与用户已填的内容
      if (editingId) {
        if (!updateTransaction(editingId, txData)) {
          message.error(STORAGE_WRITE_FAILED_MSG, 8);
          return;
        }
        message.success('已更新');
      } else {
        if (!addTransaction(txData)) {
          message.error(STORAGE_WRITE_FAILED_MSG, 8);
          return;
        }
        message.success(
          draft.status === 'pending' ? '已按待确认记录（净值发布后自动补齐份额）' : '已添加',
        );
      }

      setModalOpen(false);
      setEditingId(null);
      form.resetFields();
      setPreview({ shares: null, nav: null, navDate: null });
    } catch {
      // validation failed
    }
  };

  const handleConfirm = async (tx: Transaction) => {
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

  // 卖出预览（份额为准）：成交额 = 份额 × 净值；到手 = 成交额 − 手续费
  const sellSharesVal = sharesWatch ?? 0;
  const sellFeeVal = feeWatch ?? 0;
  // 预览用的净值：手动录入的成交净值优先（用户从平台抄来的当日净值才是权威）；
  // 否则**只认交易当日的净值**——"最近交易日"兜底值算出来的成交额是假的
  //（提示里正说着"直接用它推算份额会算错"，紧接着下一框又拿它算一遍成交额）
  const sellNavVal =
    manualNavWatch && manualNavWatch > 0
      ? manualNavWatch
      : navDecision.isExact
        ? preview.nav ?? 0
        : 0;
  const sellAmountVal = calcAmountFromShares(sellSharesVal, sellNavVal);

  /**
   * 「全部卖出」：填入可卖出的全部份额。
   * - 新建 → 当前持仓
   * - 编辑某笔卖出 → **该笔交易之前**的持仓（当前持仓已经是卖出后的余额，
   *   直接用会把「卖光」算成「卖剩下的」）
   */
  const handleFillAllShares = () => {
    const fundId = form.getFieldValue('fundId') as string;
    if (!fundId) {
      message.warning('请先选择基金');
      return;
    }
    const fundTxs = transactions.filter((t) => t.fundId === fundId);
    const editing = editingId ? fundTxs.find((t) => t.id === editingId) : undefined;
    const shares = editing
      ? calcSharesBeforeTx(fundTxs, editing)
      : calcShares(onlyConfirmed(fundTxs));
    form.setFieldsValue({ shares: Math.round(shares * 10000) / 10000 });
    message.success(`已填入 ${shares.toFixed(4)} 份`);
  };

  const handleEdit = (tx: Transaction) => {
    setEditingId(tx.id);
    // 分红方式只能按 shares 判——判据与理由见 utils/txFormModel.ts 的 inferDividendType
    const dividendType: 'cash' | 'reinvest' | undefined =
      tx.type === 'dividend' ? inferDividendType(tx) : undefined;
    // 同步 pending 表单字段，否则编辑 pending 交易时 checkbox 默认未勾选，
    // 会触发 nav 缺失校验导致无法保存（T+1 净值未发布的 pending 交易 nav=0）
    form.setFieldsValue({
      ...tx,
      date: dayjs(tx.date),
      dividendType,
      pending: tx.status === 'pending',
    });
    // 预览用：显示这笔记录原本记的净值与份额。**不参与保存决策**——
    // 编辑期的净值以表单里的「成交净值」输入框为准（buildTxDraft 按 editing 分流）。
    setPreview({ shares: tx.shares, nav: tx.nav, navDate: tx.date });
    setModalOpen(true);
  };

  // Recompute preview whenever relevant fields change
  const handleFormChange = (changedValues: Record<string, unknown>) => {
    // 编辑时不覆盖用户已填的净值——编辑期的净值由表单输入框决定，
    // 预览只用于展示记录原本的值（与基金详情页同一口径）。
    if (editingId) return;
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
        const result = lookupNavOnOrBefore(fundId, date.format('YYYY-MM-DD'));
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

    // Compute shares preview（手动录入的成交净值优先）
    const manualNav = (form.getFieldValue('nav') as number) ?? 0;
    const effNav = manualNav > 0 ? manualNav : nav;
    let shares: number | null = null;
    if (txType !== 'dividend' && effNav && amount) {
      shares = calcSharesFromAmount(amount, fee, effNav);
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
    const result = lookupNavOnOrBefore(fundId, date.format('YYYY-MM-DD'));
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
    { title: '日期', dataIndex: 'date', key: 'date', width: 110, fixed: 'left' as const, render: (v: string) => formatDate(v) },
    {
      title: '基金',
      dataIndex: 'fundId',
      key: 'fund',
      width: 200,
      fixed: 'left' as const,
      render: (id: string) => {
        const name = funds.find((f) => f.id === id)?.name ?? id;
        return <NavLink onClick={() => navigate(`/funds/${id}`)}>{name}</NavLink>;
      },
    },
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
    { title: '金额', dataIndex: 'amount', key: 'amount', width: 120, align: 'right' as const, render: (v: number) => formatMoney(v) },
    { title: '手续费', dataIndex: 'fee', key: 'fee', width: 90, align: 'right' as const, render: (v: number) => formatMoney(v) },
    { title: '份额', dataIndex: 'shares', key: 'shares', width: 110, align: 'right' as const, render: (v: number) => v.toFixed(4) },
    { title: '净值', dataIndex: 'nav', key: 'nav', width: 100, align: 'right' as const, render: (v: number) => (v > 0 ? v.toFixed(4) : '—') },
    {
      title: '备注',
      dataIndex: 'note',
      key: 'note',
      render: (v: string, r: Transaction) => (
        <Space size={4}>
          {r.planId && <Tag color="blue">定投</Tag>}
          <span>{v || '—'}</span>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 180,
      fixed: 'right' as const,
      render: (_: unknown, record: Transaction) => (
        <Space>
          {record.status === 'pending' && (
            <Button type="link" size="small" onClick={() => handleConfirm(record)}>确认</Button>
          )}
          <Button type="link" size="small" onClick={() => handleEdit(record)}>编辑</Button>
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
    <Card
      title="交易记录"
      extra={
        <Space>
          {filterFund && (
            <Button icon={<ImportOutlined />} onClick={() => setInitModalOpen(true)}>
              补登初始持仓
            </Button>
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingId(null); form.resetFields(); setPreview({ shares: null, nav: null, navDate: null }); setModalOpen(true); }}>
            添加交易
          </Button>
        </Space>
      }
    >
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6} md={5}>
          <Card size="small">
            <Statistic
              title="买入笔数 / 金额"
              value={summary.buyCount}
              suffix={`笔 / ¥${formatMoney(summary.buyAmount)}`}
              valueStyle={{ fontSize: 16, color: '#cf1322' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6} md={5}>
          <Card size="small">
            <Statistic
              title="卖出笔数 / 净额"
              value={summary.sellCount}
              suffix={`笔 / ¥${formatMoney(summary.sellAmount)}`}
              valueStyle={{ fontSize: 16, color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6} md={5}>
          <Card size="small">
            <Statistic
              title="分红笔数 / 累计"
              value={summary.dividendCount}
              suffix={`笔 / ¥${formatMoney(summary.dividendAmount)}`}
              valueStyle={{ fontSize: 16, color: '#d48806' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6} md={4}>
          <Card size="small">
            <Statistic
              title="净投入（买 - 卖）"
              value={summary.net}
              prefix="¥"
              precision={2}
              valueStyle={{ fontSize: 16, color: pnlColor(summary.net) === '#666' ? undefined : pnlColor(summary.net) }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={24} md={5}>
          <Card size="small">
            <Statistic
              title="筛选结果"
              value={filteredTxs.length}
              suffix="笔"
              valueStyle={{ fontSize: 16, color: '#1677ff' }}
            />
          </Card>
        </Col>
      </Row>

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
        <Checkbox checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)}>
          仅看未确认
        </Checkbox>
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
        <Form form={form} layout="vertical" initialValues={{ date: dayjs(), type: 'buy', fee: 0, dividendType: 'cash' }} onValuesChange={handleFormChange}>
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
          {txTypeWatch !== 'sell' && txTypeWatch !== 'dividend' && (
            <>
              <Form.Item label="金额（元）" name="amount" rules={[{ required: true, message: '请输入金额' }]}>
                <InputNumber style={{ width: '100%' }} min={0} precision={2} />
              </Form.Item>
              <Form.Item label="手续费（元）" name="fee">
                <InputNumber style={{ width: '100%' }} min={0} precision={2} />
              </Form.Item>
            </>
          )}
          {txTypeWatch === 'sell' && (
            <>
              <Form.Item
                label="卖出份额（份）"
                name="shares"
                rules={[{ required: true, message: '请输入卖出份额' }]}
                extra={
                  <Button size="small" type="link" onClick={handleFillAllShares} style={{ paddingLeft: 0 }}>
                    {editingId ? '按该笔交易前持仓填入' : '全部卖出'}
                  </Button>
                }
              >
                <InputNumber style={{ width: '100%' }} min={0} precision={4} placeholder="本次赎回的份额" />
              </Form.Item>
              <Form.Item label="手续费（元）" name="fee">
                <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="0（赎回费，从成交额中扣除）" />
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
                  const dt = form.getFieldValue('dividendType') ?? 'cash';
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
            <Checkbox>待确认（净值待发布：先记账不进入持仓）</Checkbox>
          </Form.Item>
          {/* NAV is hidden - auto-filled from history, shown in preview below */}
          {!pendingWatch && !editingId && preview.nav !== null && navDecision.isExact && (
            <Alert
              type="success"
              showIcon
              message={`成交净值：${preview.nav.toFixed(4)}（${preview.navDate}）`}
              description={
                txTypeWatch === 'sell' ? (
                  <>
                    成交金额：<strong>{sellAmountVal.toFixed(2)}</strong> 元
                    <br />实际到手：{(sellAmountVal - sellFeeVal).toFixed(2)} 元
                    <br />（{sellSharesVal} 份 × {sellNavVal} − 手续费 {sellFeeVal}）
                  </>
                ) : preview.shares !== null ? (
                  <>预计份额：<strong>{preview.shares.toFixed(4)}</strong> 份<br />（{form.getFieldValue('amount') ?? 0} - {form.getFieldValue('fee') ?? 0}）÷ {preview.nav.toFixed(4)}</>
                ) : '请输入金额后查看预计份额'
              }
              action={<Button size="small" onClick={handleRefreshNav}>刷新净值</Button>}
              style={{ marginBottom: 16 }}
            />
          )}
          {!pendingWatch && !editingId && preview.nav === null && (form.getFieldValue('fundId') && form.getFieldValue('date')) && (
            <Alert
              type="warning"
              showIcon
              message="未找到该日期的净值"
              description="该日期之前无历史净值数据，请检查该基金是否已加载历史，或换个日期"
              style={{ marginBottom: 16 }}
            />
          )}
          {/* 净值不是交易当日的 → 警告（用它推算份额会算错），并允许手填当日净值 */}
          {!pendingWatch && !editingId && preview.nav !== null && !navDecision.isExact && (
            <Alert
              type="warning"
              showIcon
              message={`该日期的净值尚未收录（本地最近 ${preview.navDate}）`}
              description={navDecision.warning}
              action={<Button size="small" onClick={handleRefreshNav}>刷新净值</Button>}
              style={{ marginBottom: 16 }}
            />
          )}
          {/* 重复计算预警：买入日期早于该基金的初始持仓日期 */}
          {doubleCountRisk && (
            <Alert
              type="warning"
              showIcon
              message="可能与初始持仓重复计算"
              description={doubleCountRisk}
              style={{ marginBottom: 16 }}
            />
          )}
          {/* 手动录入成交净值：自动净值不可信时，让用户填平台确认的当日净值 */}
          {!pendingWatch && !editingId && (preview.nav === null || !navDecision.isExact) && form.getFieldValue('fundId') && dateWatch && (
            <Form.Item
              label="成交净值（手动录入：平台确认的当日净值）"
              name="nav"
              extra="留空则按「待确认」记录，净值发布后自动补齐份额"
            >
              <InputNumber style={{ width: '100%' }} min={0} step={0.0001} precision={4} />
            </Form.Item>
          )}
          {/* 卖出预览：成交额 = 份额 × 净值；实际到手 = 成交额 − 手续费 */}
          {txTypeWatch === 'sell' && !pendingWatch && (
            <Alert
              type="info"
              showIcon
              message={`成交金额 ${sellAmountVal.toFixed(2)} 元　实际到手 ${(sellAmountVal - sellFeeVal).toFixed(2)} 元`}
              description={
                sellNavVal > 0
                  ? `${sellSharesVal} 份 × ${sellNavVal} − 手续费 ${sellFeeVal}（手续费从成交额中扣除，不减少卖出份额）`
                  : '尚未查到成交净值，成交金额待净值确定后计算'
              }
              style={{ marginBottom: 16 }}
            />
          )}
          {/* 编辑交易：保留手动输入净值（默认回填原值）——与基金详情页同一口径 */}
          {!pendingWatch && editingId && (
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
        fundId={filterFund || null}
        open={initModalOpen}
        onClose={() => setInitModalOpen(false)}
      />
    </Card>
  );
}