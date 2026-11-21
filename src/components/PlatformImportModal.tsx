import { useCallback, useMemo, useState } from 'react';
import { Modal, Table, Tag, Button, Space, Alert, Input, Select, Typography, message } from 'antd';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { parsePlatformRows, diffPlatformRows, type PlatformRow } from '../utils/platformImport';
import { PLATFORM_IMPORT_NOTE } from '../utils/txNormalize';
import type { Transaction } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
}

const { TextArea } = Input;

/** 平台流水与账本对不上的行 */
interface Mismatch {
  row: PlatformRow;
  txId: string;
  txShares: number;
  txAmount: number;
}

/**
 * 平台流水对账 / 补录弹窗。
 *
 * 用途：把基金平台的交易流水粘进来，与应用账本比对，找出**漏记的买入/卖出**
 * 并一键补录（金额/份额/净值都是平台给的真值，原样保存、不做反算）。
 *
 * 为什么需要：漏记的买入应用自己发现不了——账本只是"少了一笔"，
 * 表现是持仓残值对不上（2026-11 审计南方标普红利低波就少记 138.77 份）。
 *
 * 支持的行格式（逗号/制表符/分号/空格分隔均可）：
 *   `日期, 类型, 金额, 份额, 净值`
 */
export default function PlatformImportModal({ open, onClose }: Props) {
  const { funds, transactions, addTransaction, regenerateTodaySnapshot } = useStore();
  const [fundId, setFundId] = useState<string>('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<{
    rows: PlatformRow[];
    errors: { line: string; reason: string }[];
    matched: PlatformRow[];
    missing: PlatformRow[];
    mismatched: { row: PlatformRow; txId: string; txShares: number; txAmount: number }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const fundTxs = useMemo(
    () => transactions.filter((t) => t.fundId === fundId),
    [transactions, fundId],
  );

  const handleCompare = useCallback(() => {
    if (!fundId) {
      message.warning('请先选择基金');
      return;
    }
    const parsed = parsePlatformRows(text);
    const diff = diffPlatformRows(parsed.rows, transactions, fundId);
    setResult({ rows: parsed.rows, errors: parsed.errors, ...diff });
    if (parsed.errors.length > 0) {
      message.warning(`${parsed.errors.length} 行无法解析，请检查格式`);
    }
  }, [fundId, text, transactions]);

  const handleImportMissing = () => {
    if (!result || result.missing.length === 0) return;
    Modal.confirm({
      title: `补录 ${result.missing.length} 笔交易？`,
      content:
        '金额、份额、净值按平台流水原样保存（平台是权威，不做反算）。' +
        '补录前建议先导出备份。',
      okText: '补录',
      cancelText: '取消',
      onOk: () => {
        setBusy(true);
        for (const row of result.missing) {
          const tx: Transaction = {
            id: uuid(),
            fundId,
            type: row.type,
            date: row.date,
            amount: row.amount,
            fee: 0,
            shares: row.shares,
            nav: row.nav,
            note: PLATFORM_IMPORT_NOTE,
            status: 'confirmed',
          };
          addTransaction(tx);
        }
        regenerateTodaySnapshot();
        setBusy(false);
        message.success(`已补录 ${result.missing.length} 笔`);
        handleCompare();
      },
    });
  };

  const rowColumns = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 100 },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 70,
      render: (v: string) => <Tag color={v === 'buy' ? 'red' : 'green'}>{v === 'buy' ? '买入' : '卖出'}</Tag>,
    },
    { title: '金额', dataIndex: 'amount', key: 'amount', width: 110, align: 'right' as const, render: (v: number) => v.toFixed(2) },
    { title: '份额', dataIndex: 'shares', key: 'shares', width: 120, align: 'right' as const, render: (v: number) => v.toFixed(4) },
    { title: '净值', dataIndex: 'nav', key: 'nav', width: 90, align: 'right' as const, render: (v: number) => v.toFixed(4) },
  ];

  // 不一致的行数据结构是 { row, txId, ... }，列要从 r.row 里取
  const mismatchColumns = [
    {
      title: '日期',
      key: 'date',
      width: 100,
      render: (_: unknown, r: Mismatch) => r.row.date,
    },
    {
      title: '类型',
      key: 'type',
      width: 70,
      render: (_: unknown, r: Mismatch) => (
        <Tag color={r.row.type === 'buy' ? 'red' : 'green'}>{r.row.type === 'buy' ? '买入' : '卖出'}</Tag>
      ),
    },
    {
      title: '金额',
      key: 'amount',
      width: 110,
      align: 'right' as const,
      render: (_: unknown, r: Mismatch) => r.row.amount.toFixed(2),
    },
    {
      title: '份额',
      key: 'shares',
      width: 120,
      align: 'right' as const,
      render: (_: unknown, r: Mismatch) => r.row.shares.toFixed(4),
    },
    {
      title: '净值',
      key: 'nav',
      width: 90,
      align: 'right' as const,
      render: (_: unknown, r: Mismatch) => r.row.nav.toFixed(4),
    },
    {
      title: '账本里的份额',
      key: 'ledger',
      width: 120,
      align: 'right' as const,
      render: (_: unknown, r: Mismatch) => r.txShares.toFixed(4),
    },
  ];

  return (
    <Modal
      title="平台流水对账 / 补录"
      open={open}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button onClick={handleCompare}>比对</Button>
          <Button
            type="primary"
            disabled={!result || result.missing.length === 0}
            loading={busy}
            onClick={handleImportMissing}
          >
            补录缺失{result && result.missing.length > 0 ? `（${result.missing.length}）` : ''}
          </Button>
        </Space>
      }
      width={860}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <div style={{ marginBottom: 4 }}>
            <Typography.Text strong>1. 选择基金</Typography.Text>
          </div>
          <Select
            style={{ width: '100%' }}
            placeholder="选择要核对的基金"
            value={fundId || undefined}
            onChange={(v: string) => { setFundId(v); setResult(null); }}
            showSearch
            optionFilterProp="label"
            options={funds.map((f) => ({ value: f.id, label: `${f.name} (${f.id})` }))}
          />
        </div>

        <div>
          <div style={{ marginBottom: 4 }}>
            <Typography.Text strong>2. 粘贴该基金的平台流水</Typography.Text>
          </div>
          <TextArea
            rows={6}
            value={text}
            onChange={(e) => { setText(e.target.value); setResult(null); }}
            placeholder={'每行一笔，格式：日期, 类型, 金额, 份额, 净值\n2026-08-26, 买入, 1575.00, 1516.4645, 1.0386\n2026-11-19, 卖出, 14104.83, 12488.7817, 1.1294'}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            类型认：买入 / 申购 / 卖出 / 赎回 / buy / sell。金额里的千分位逗号（1,575.00）也会被自动还原。
          </Typography.Text>
        </div>

        {result && (
          <>
            <Alert
              type={result.missing.length > 0 ? 'warning' : result.errors.length > 0 ? 'warning' : 'success'}
              showIcon
              message={
                `解析 ${result.rows.length} 行：账本已有 ${result.matched.length} 笔，` +
                `缺失 ${result.missing.length} 笔，份额对不上 ${result.mismatched.length} 笔` +
                (result.errors.length > 0 ? `，无法解析 ${result.errors.length} 行` : '')
              }
              description={
                result.missing.length > 0
                  ? '缺失的记录可以一键补录（金额/份额/净值按平台原样保存）。'
                  : result.mismatched.length > 0
                    ? '同日期同类型但份额对不上，多半是当初录错了——请到「交易自检」核对，或手动编辑该笔。'
                    : '账本与平台流水一致。'
              }
            />

            {result.missing.length > 0 && (
              <div>
                <Typography.Text strong>账本缺失（可补录）</Typography.Text>
                <Table
                  size="small"
                  rowKey={(_r, i) => String(i)}
                  columns={rowColumns}
                  dataSource={result.missing}
                  pagination={false}
                  style={{ marginTop: 8 }}
                />
              </div>
            )}

            {result.mismatched.length > 0 && (
              <div>
                <Typography.Text strong>份额对不上（需人工确认）</Typography.Text>
                <Table
                  size="small"
                  rowKey={(_r, i) => String(i)}
                  columns={mismatchColumns}
                  dataSource={result.mismatched}
                  pagination={false}
                  style={{ marginTop: 8 }}
                />
              </div>
            )}

            {result.errors.length > 0 && (
              <div>
                <Typography.Text strong>无法解析的行</Typography.Text>
                <div style={{ marginTop: 8, maxHeight: 160, overflow: 'auto' }}>
                  {result.errors.map((e, i) => (
                    <div key={i} style={{ fontSize: 12, marginBottom: 4 }}>
                      <code>{e.line}</code>
                      <span style={{ color: '#cf1322', marginLeft: 8 }}>{e.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {fundId && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            该基金当前账本有 {fundTxs.length} 笔交易。
          </Typography.Text>
        )}
      </Space>
    </Modal>
  );
}
