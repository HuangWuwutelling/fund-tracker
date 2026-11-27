import { useState, useMemo } from 'react';
import { Card, Table, Button, Select, Tag, Space, message, Popconfirm, Statistic, Row, Col, Alert } from 'antd';
import { PlusOutlined, ImportOutlined } from '@ant-design/icons';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useStore } from '../stores';
import { STORAGE_WRITE_FAILED_MSG } from '../utils/storage';
import { formatMoney, formatDate, pnlColor, today, moneyStatFormatter } from '../utils/formatter';
import { confirmPendingTx } from '../utils/autoConfirm';
import { calcTodayInvested, dividendValue } from '../utils/calculator';
import TransactionFormModal from '../components/TransactionFormModal';
import InitialPositionModal from '../components/InitialPositionModal';
import NavLink from '../components/NavLink';
import { TRANSACTION_TYPE_LABELS, TX_TYPE_COLORS } from '../types';
import {
  parseTxFilters,
  filterTransactions,
  txFilterParams,
  type TxFilters,
  type TxStatusFilter,
} from '../utils/txFilter';
import type { Transaction } from '../types';

export default function Transactions() {
  const { funds, transactions, dcaPlans, getNavHistory, updateTransaction, removeTransaction } = useStore();
  const navigate = useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  /** 正在编辑的交易（null = 新增）。弹窗本体在 components/TransactionFormModal.tsx */
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [initModalOpen, setInitModalOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // 筛选的唯一真源是 URL（utils/txFilter.ts 是唯一实现）——本地 state 不再持有
  // 筛选。此前 fund/type 走本地 state、status 走 URL，是"同一个概念两处各写一遍"。
  //
  // fundIds / filters 都必须 memo：filters 若是每次渲染的新对象 → filteredTxs
  // 换引用 → summary 重算 → AntD Table 拿新 dataSource 全量重渲染（本项目有
  // 4 秒实测卡顿史）。searchParams 本身稳定（react-router 内部 useMemo 依赖
  // [location.search]），所以这两层 memo 成立。
  const fundIds = useMemo(() => funds.map((f) => f.id), [funds]);
  const filters = useMemo(() => parseTxFilters(searchParams, fundIds), [searchParams, fundIds]);

  /** 改筛选 = 改 URL。重建式写入：不认识的参数（如 ?foo=1）会被丢弃。 */
  const updateFilters = (patch: Partial<TxFilters>) => {
    setSearchParams(txFilterParams({ ...filters, ...patch }), { replace: true });
  };

  const filteredTxs = useMemo(() => {
    // filterTransactions 返回新数组，排序在上面做 —— 不动 store 里的 transactions
    return filterTransactions(transactions, filters).sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, filters]);

  /**
   * 组件级的「今天」。**不能**在下面的 memo 内部调 `today()`：标签页跨零点
   * 开着时，memo 里的 `today()` 是陈旧的（memo 不重算），`filters.date`
   * （昨天）仍等于那个陈旧值 → 提示会对着昨天说"今日另有 ¥X 定投计划待执行"。
   * 提到组件级 + 进 deps：跨零点后值变了 → memo 重算 → 提示正确地消失。
   * （与 `Dashboard.tsx` 的 `todayStr` 同一手法。）
   */
  const todayStr = today();

  /**
   * 「待执行定投」提示。首页「今日投入」卡片的合计含「今日应执行但尚未产生交易」的
   * 定投计划 —— 落地页只有真实交易，若当天只有定投没有手动买入，这里会显示
   * 「买入 0 笔 / ¥0.00」，用户会以为定投没跑。数据复用 calcTodayInvested 的
   * planAmount（与卡片同一份计算，不另写一遍）。
   */
  const pendingDcaHint = useMemo(() => {
    if (!filters.date || filters.date !== todayStr) return null;
    const { planAmount } = calcTodayInvested(transactions, dcaPlans);
    return planAmount > 0 ? planAmount : null;
  }, [filters.date, todayStr, transactions, dcaPlans]);

  // 汇总：用于表头上方的"本页统计"条（不区分 confirmed/pending，与过滤后列表口径一致）
  const summary = useMemo(() => {
    let buyCount = 0, sellCount = 0, dividendCount = 0;
    let buyAmount = 0, sellAmount = 0, dividendAmount = 0;
    for (const tx of filteredTxs) {
      if (tx.type === 'buy') { buyCount++; buyAmount += tx.amount; }
      else if (tx.type === 'sell') { sellCount++; sellAmount += tx.amount - tx.fee; }
      // 分红金额走 `dividendValue` —— 与首页卡片（calcDividendTotal）、年化 XIRR
      // （calcXIRR）同一个实现（utils/calculator.ts）。三处各写一遍就等着分叉。
      else { dividendCount++; dividendAmount += dividendValue(tx); }
    }
    return { buyCount, sellCount, dividendCount, buyAmount, sellAmount, dividendAmount, net: buyAmount - sellAmount };
  }, [filteredTxs]);

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
          <Button type="link" size="small" onClick={() => { setEditingTx(record); setModalOpen(true); }}>编辑</Button>
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
          {filters.fundId && (
            <Button icon={<ImportOutlined />} onClick={() => setInitModalOpen(true)}>
              补登初始持仓
            </Button>
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingTx(null); setModalOpen(true); }}>
            添加交易
          </Button>
        </Space>
      }
    >
      {pendingDcaHint !== null && (
        <Alert
          type="info"
          showIcon
          message={`今日另有 ¥${formatMoney(pendingDcaHint)} 定投计划待执行，尚未产生交易记录`}
          style={{ marginBottom: 16 }}
        />
      )}

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
              formatter={moneyStatFormatter}
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
          value={filters.fundId || undefined}
          onChange={(v: string | undefined) => updateFilters({ fundId: v ?? '' })}
        >
          {funds.map((f) => (
            <Select.Option key={f.id} value={f.id}>{f.name}</Select.Option>
          ))}
        </Select>
        <Select
          allowClear
          placeholder="筛选类型"
          style={{ width: 120 }}
          value={filters.type || undefined}
          onChange={(v: string | undefined) => updateFilters({ type: (v ?? '') as TxFilters['type'] })}
        >
          {Object.entries(TRANSACTION_TYPE_LABELS).map(([key, label]) => (
            <Select.Option key={key} value={key}>{label}</Select.Option>
          ))}
        </Select>
        {/* status 是三态（全部 / 已确认 / 未确认）——二值 Checkbox 表达不了
            「只看已确认」。?status=pending 是既有契约（首页「去确认」按钮在用）。 */}
        <Select
          allowClear
          placeholder="确认状态"
          style={{ width: 120 }}
          value={filters.status || undefined}
          onChange={(v: string | undefined) => updateFilters({ status: (v ?? '') as TxStatusFilter })}
        >
          <Select.Option value="confirmed">已确认</Select.Option>
          <Select.Option value="pending">未确认</Select.Option>
        </Select>
        {filters.date && (
          <Tag
            closable
            onClose={() => updateFilters({ date: '' })}
            style={{ marginInlineEnd: 0 }}
          >
            日期 {filters.date}
          </Tag>
        )}
      </Space>

      <Table dataSource={filteredTxs} columns={columns} rowKey="id" pagination={{ pageSize: 20 }} />

      <TransactionFormModal
        open={modalOpen}
        tx={editingTx}
        onClose={() => { setModalOpen(false); setEditingTx(null); }}
      />

      <InitialPositionModal
        fundId={filters.fundId || null}
        open={initModalOpen}
        onClose={() => setInitModalOpen(false)}
      />
    </Card>
  );
}