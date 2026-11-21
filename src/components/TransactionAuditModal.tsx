import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Table, Tag, Button, Space, Alert, message } from 'antd';
import { useStore } from '../stores';
import { auditTransactions, type TxAuditIssue } from '../utils/txAudit';
import type { NavRecord } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 交易自检弹窗：逐笔核对买卖记录的净值与本地净值历史里**同一日期**的净值。
 *
 * 背景（2026-11-20）：净值历史曾经陈旧时，app 会用"最近交易日"的旧净值推算份额，
 * 份额就此算错且无感知（实测南方标普红利低波 08-26 的买入多算 13.6 份）。
 * 录入侧已修（只有当日净值才推算份额），但**存量记录**还在 → 这里提供一次性核对
 * 与一键修正。
 *
 * 排除项（与 utils/txAudit.ts 一致）：pending、初始持仓（nav 是成本单价）。
 */
export default function TransactionAuditModal({ open, onClose }: Props) {
  const { transactions, funds, getNavHistory, updateTransaction, regenerateTodaySnapshot } = useStore();
  const [issues, setIssues] = useState<TxAuditIssue[] | null>(null);

  const histories = useMemo(() => {
    const map: Record<string, NavRecord[]> = {};
    for (const f of funds) map[f.id] = getNavHistory(f.id);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funds, open]);

  const runAudit = useCallback(() => {
    const found = auditTransactions(transactions, histories);
    setIssues(found);
    return found;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, histories]);

  useEffect(() => {
    if (open) runAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runAudit]);

  const fundName = (id: string) => funds.find((f) => f.id === id)?.name ?? id;

  const handleFix = (issue: TxAuditIssue) => {
    updateTransaction(issue.txId, {
      nav: issue.correctNav,
      shares: Math.round(issue.correctShares * 10000) / 10000,
      amount: issue.correctAmount,
    });
    // 交易变了 → 今日快照要跟上，否则组合趋势与账本不一致
    regenerateTodaySnapshot();
    message.success(
      `已修正 ${issue.date} ${issue.type === 'buy' ? '买入' : '卖出'}：` +
      `净值 ${issue.recordedNav.toFixed(4)} → ${issue.correctNav.toFixed(4)}`,
    );
    runAudit();
  };

  const handleFixAll = () => {
    if (!issues || issues.length === 0) return;
    Modal.confirm({
      title: `修正全部 ${issues.length} 笔？`,
      content:
        '将按净值历史里该日期的真实净值重算每笔的份额（买入）与成交额（卖出）。' +
        '此操作不可撤销，建议先导出备份。',
      okText: '全部修正',
      cancelText: '取消',
      onOk: () => {
        for (const issue of issues) {
          updateTransaction(issue.txId, {
            nav: issue.correctNav,
            shares: Math.round(issue.correctShares * 10000) / 10000,
            amount: issue.correctAmount,
          });
        }
        regenerateTodaySnapshot();
        message.success(`已修正 ${issues.length} 笔`);
        runAudit();
      },
    });
  };

  const columns = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 100 },
    {
      title: '基金',
      dataIndex: 'fundId',
      key: 'fund',
      width: 180,
      ellipsis: true,
      render: (id: string) => fundName(id),
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 70,
      render: (v: string) => <Tag color={v === 'buy' ? 'red' : 'green'}>{v === 'buy' ? '买入' : '卖出'}</Tag>,
    },
    {
      title: '记录净值',
      dataIndex: 'recordedNav',
      key: 'recordedNav',
      width: 90,
      align: 'right' as const,
      render: (v: number) => v.toFixed(4),
    },
    {
      title: '正确净值',
      dataIndex: 'correctNav',
      key: 'correctNav',
      width: 90,
      align: 'right' as const,
      render: (v: number) => <b style={{ color: '#cf1322' }}>{v.toFixed(4)}</b>,
    },
    {
      title: '份额',
      key: 'shares',
      width: 170,
      align: 'right' as const,
      render: (_: unknown, r: TxAuditIssue) => (
        <span>
          {r.recordedShares.toFixed(4)}
          {Math.abs(r.correctShares - r.recordedShares) > 0.0001 && (
            <b style={{ color: '#cf1322' }}> → {r.correctShares.toFixed(4)}</b>
          )}
        </span>
      ),
    },
    {
      title: '成交额',
      key: 'amount',
      width: 170,
      align: 'right' as const,
      render: (_: unknown, r: TxAuditIssue) => (
        <span>
          {r.recordedAmount.toFixed(2)}
          {Math.abs(r.correctAmount - r.recordedAmount) > 0.005 && (
            <b style={{ color: '#cf1322' }}> → {r.correctAmount.toFixed(2)}</b>
          )}
        </span>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_: unknown, r: TxAuditIssue) => (
        <Button size="small" type="link" onClick={() => handleFix(r)}>
          修正
        </Button>
      ),
    },
  ];

  return (
    <Modal
      title="交易自检"
      open={open}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button onClick={runAudit}>重新检查</Button>
          <Button type="primary" disabled={!issues || issues.length === 0} onClick={handleFixAll}>
            修正全部{issues && issues.length > 0 ? `（${issues.length}）` : ''}
          </Button>
        </Space>
      }
      width={1000}
    >
      {issues === null ? (
        <div>检查中…</div>
      ) : issues.length === 0 ? (
        <Alert
          type="success"
          showIcon
          message="没有发现净值不一致的记录"
          description="已核对全部买入/卖出记录的净值与本地净值历史（待确认交易与初始持仓不参与核对）。"
        />
      ) : (
        <>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`发现 ${issues.length} 笔记录的净值与净值历史不一致`}
            description="这些记录的份额是按旧净值推算出来的，可能有偏差。点「修正」按该日期的真实净值重算（买入改份额、卖出改成交额，卖出份额不动）。修正前建议先导出备份。"
          />
          <Table
            size="small"
            rowKey="txId"
            columns={columns}
            dataSource={issues}
            pagination={false}
            scroll={{ y: 380 }}
          />
        </>
      )}
    </Modal>
  );
}
