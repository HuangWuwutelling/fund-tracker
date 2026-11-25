import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Radio, Select, message } from 'antd';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { calcAmountFromShares, calcShares, calcSharesBeforeTx, onlyConfirmed } from '../utils/calculator';
import { buildTxDraft, inferDividendType } from '../utils/txFormModel';
import { decideNavEntry } from '../utils/navEntry';
import { lookupNavOnOrBefore } from '../utils/navLookup';
import { initialPositionDate } from '../utils/txNormalize';
import { STORAGE_WRITE_FAILED_MSG } from '../utils/storage';
import { TRANSACTION_TYPE_LABELS } from '../types';
import type { Transaction } from '../types';

/**
 * 交易录入表单（基金详情页与交易记录页共用）。
 *
 * 这两个页面过去各有一份近乎逐行相同的弹窗（约 90 行 JSX + 60 行保存流程），
 * 于是同一条业务规则在两处各写一遍——本项目所有真实事故都是这个形状。
 * 规则本身在 `utils/txFormModel.ts`（唯一真源），这里只负责**呈现**。
 *
 * 两页的唯一差别是基金能不能选：
 * - 省略 `fundId` → 弹窗自带基金下拉（交易记录页）
 * - 传 `fundId`   → 锁定该基金，不显示下拉（基金详情页）
 */
export interface TransactionFormModalProps {
  open: boolean;
  /** 省略 = 用户可选基金（交易记录页）；指定 = 锁定该基金（基金详情页） */
  fundId?: string;
  /** 编辑既有交易；null / undefined = 新增 */
  tx?: Transaction | null;
  onClose: () => void;
}

export default function TransactionFormModal({ open, fundId, tx, onClose }: TransactionFormModalProps) {
  const { funds, transactions, addTransaction, updateTransaction } = useStore();
  const [form] = Form.useForm();
  const [navPreview, setNavPreview] = useState<{ nav: number; navDate: string } | null>(null);

  const editing = !!tx;
  const txTypeWatch = Form.useWatch('type', form);
  const pendingWatch = Form.useWatch('pending', form);
  const sharesWatch = Form.useWatch('shares', form) as number | undefined;
  const amountWatch = Form.useWatch('amount', form) as number | undefined;
  const feeWatch = Form.useWatch('fee', form) as number | undefined;
  const dateWatch = Form.useWatch('date', form) as dayjs.Dayjs | undefined;
  const manualNavWatch = Form.useWatch('nav', form) as number | undefined;
  const fundIdWatch = Form.useWatch('fundId', form) as string | undefined;
  /** 锁定基金时用 prop，可选基金时用表单里的选择 */
  const targetFundId = fundId ?? fundIdWatch;

  // 打开时：清掉上次的残留；编辑态则回填记录（含净值与分红方式）
  // 依赖用 tx?.id 而不是 tx 本身——store 更新会让 tx 的**引用**变掉（内容一样），
  // 若按对象依赖，用户填了一半的表单会被无声重置掉。
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (tx) {
      form.setFieldsValue({
        ...tx,
        date: dayjs(tx.date),
        // 分红方式只能按 shares 判——判据与理由见 utils/txFormModel.ts
        dividendType: tx.type === 'dividend' ? inferDividendType(tx) : undefined,
        pending: tx.status === 'pending',
      });
      // 预览：显示这笔记录原本记的净值。**不参与保存决策**——编辑期的净值
      // 以表单里的「成交净值」输入框为准（buildTxDraft 按 editing 分流）。
      setNavPreview({ nav: tx.nav, navDate: tx.date });
    } else {
      // 日期取「打开弹窗的当天」——initialValues 里的 dayjs() 是挂载时求值的
      form.setFieldsValue({ date: dayjs(), type: 'buy', fee: 0, dividendType: 'cash' });
      setNavPreview(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tx?.id, form]);

  // 净值是否可用来推算份额：只有**交易当日**的净值才行，"最近交易日"兜底会算错
  const navDecision = useMemo(
    () =>
      decideNavEntry({
        txDate: dateWatch ? dateWatch.format('YYYY-MM-DD') : '',
        lookedUp: navPreview ? { nav: navPreview.nav, navDate: navPreview.navDate } : null,
        manualNav: 0,
      }),
    [dateWatch, navPreview],
  );

  // 重复计算预警：买入日期早于该基金的初始持仓日期（初始持仓已包含更早的持仓）
  const doubleCountRisk = useMemo(() => {
    if (txTypeWatch !== 'buy' || !dateWatch || !targetFundId) return null;
    const initDate = initialPositionDate(transactions, targetFundId);
    if (!initDate) return null;
    const txDate = dateWatch.format('YYYY-MM-DD');
    if (txDate >= initDate) return null;
    return `该基金在 ${initDate} 有一条「初始持仓」记录（已包含该日之前的全部持仓）。` +
      `再记 ${txDate} 的买入会与它重复计算——请把初始持仓的份额调减，或把买入日期设在 ${initDate} 之后。`;
  }, [txTypeWatch, dateWatch, targetFundId, transactions]);

  /** 表单值变化时：自动从历史净值查找成交净值（仅新增时） */
  const handleFormChange = (changedValues: Record<string, unknown>) => {
    // 编辑时不覆盖用户已填的净值——编辑期的净值由输入框决定
    if (editing) return;
    if (!('fundId' in changedValues) && !('date' in changedValues)) return;
    const fid = fundId ?? (form.getFieldValue('fundId') as string);
    const date = form.getFieldValue('date') as dayjs.Dayjs | null;
    if (!fid || !date) {
      setNavPreview(null);
      return;
    }
    const result = lookupNavOnOrBefore(fid, date.format('YYYY-MM-DD'));
    setNavPreview(result ?? null);
  };

  /** 手动刷新净值（用户想要取最近交易日的净值时） */
  const handleRefreshNav = () => {
    const fid = fundId ?? (form.getFieldValue('fundId') as string);
    const date = form.getFieldValue('date') as dayjs.Dayjs | null;
    if (!fid || !date) {
      message.warning('请先选择基金和日期');
      return;
    }
    const result = lookupNavOnOrBefore(fid, date.format('YYYY-MM-DD'));
    if (result) {
      setNavPreview(result);
      message.success(`使用 ${result.navDate} 的净值 ${result.nav.toFixed(4)}`);
    } else {
      message.warning('未找到该日期之前的净值');
    }
  };

  /**
   * 「全部卖出」：填入可卖出的全部份额。
   * - 新建 → 当前持仓
   * - 编辑某笔卖出 → **该笔交易之前**的持仓（当前持仓已经是卖出后的余额，
   *   直接用会把「卖光」算成「卖剩下的」）
   */
  const handleFillAllShares = () => {
    const fid = fundId ?? (form.getFieldValue('fundId') as string);
    if (!fid) {
      message.warning('请先选择基金');
      return;
    }
    const fundTxs = transactions.filter((t) => t.fundId === fid);
    const shares = tx ? calcSharesBeforeTx(fundTxs, tx) : calcShares(onlyConfirmed(fundTxs));
    form.setFieldsValue({ shares: Math.round(shares * 10000) / 10000 });
    message.success(`已填入 ${shares.toFixed(4)} 份`);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const txType = values.type as Transaction['type'];
      const pendingFlag = (values.pending as boolean) ?? false;
      const txDate = (values.date as dayjs.Dayjs).format('YYYY-MM-DD');
      const fid = fundId ?? (values.fundId as string);

      // 卖出超额校验需要「该笔交易之前」的持仓份额（编辑时排除自身，避免重复计算）
      const priorShares =
        txType === 'sell'
          ? calcSharesBeforeTx(
              transactions.filter((t) => t.fundId === fid),
              { id: tx?.id ?? '', date: txDate },
            )
          : 0;

      // 录入决策只有一份实现（utils/txFormModel.ts）：净值可用性、公式方向、
      // 扣费口径、卖出超额校验都在那里。
      const draft = buildTxDraft({
        type: txType,
        dividendType: (values.dividendType as 'cash' | 'reinvest') ?? 'cash',
        amount: (values.amount as number) ?? 0,
        fee: (values.fee as number) ?? 0,
        shares: (values.shares as number) ?? 0,
        // 净值取表单字段：编辑期是用户填的值（可修正错净值），新增期是手动补录的当日净值
        manualNav: (values.nav as number) ?? 0,
        lookedUp: navPreview ? { nav: navPreview.nav, navDate: navPreview.navDate } : null,
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
        id: tx?.id ?? uuid(),
        fundId: fid,
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
      if (editing) {
        if (!updateTransaction(tx!.id, txData)) {
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
          draft.status === 'pending'
            ? '已记录为待确认交易（净值发布后自动补齐份额）'
            : '交易记录已添加',
        );
      }

      onClose();
    } catch {
      // validation failed
    }
  };

  // 卖出预览（份额为准）：成交额 = 份额 × 净值；到手 = 成交额 − 手续费
  const sellSharesVal = sharesWatch ?? 0;
  const sellFeeVal = feeWatch ?? 0;
  // 预览用的净值：手动录入的成交净值优先；否则**只认交易当日的净值**——
  // "最近交易日"兜底值算出来的成交额是假的（提示里正说着"直接用它推算份额会算错"，
  // 紧接着下一框又拿它算一遍成交额，自相矛盾）
  const sellNavVal =
    manualNavWatch && manualNavWatch > 0
      ? manualNavWatch
      : navDecision.isExact
        ? navPreview?.nav ?? 0
        : 0;
  const sellAmountVal = calcAmountFromShares(sellSharesVal, sellNavVal);

  return (
    <Modal
      title={editing ? '编辑交易' : '添加交易'}
      open={open}
      onOk={handleSave}
      onCancel={onClose}
      okText="保存"
      cancelText="取消"
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ date: dayjs(), type: 'buy', fee: 0, dividendType: 'cash' }}
        onValuesChange={handleFormChange}
      >
        {/* 锁定基金时不显示下拉（基金详情页） */}
        {!fundId && (
          <Form.Item label="基金" name="fundId" rules={[{ required: true, message: '请选择基金' }]}>
            <Select placeholder="选择基金">
              {funds.map((f) => (
                <Select.Option key={f.id} value={f.id}>
                  {f.name} ({f.id})
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        )}
        <Form.Item label="交易类型" name="type" rules={[{ required: true }]}>
          <Select>
            {Object.entries(TRANSACTION_TYPE_LABELS).map(([key, label]) => (
              <Select.Option key={key} value={key}>
                {label}
              </Select.Option>
            ))}
          </Select>
        </Form.Item>
        <Form.Item label="交易日期" name="date" rules={[{ required: true }]}>
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        {txTypeWatch !== 'sell' && txTypeWatch !== 'dividend' && (
          <>
            <Form.Item label="金额（元）" name="amount" rules={[{ required: true, message: '请输入金额' }]}>
              <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="交易金额" />
            </Form.Item>
            <Form.Item label="手续费（元）" name="fee">
              <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="0" />
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
                  {editing ? '按该笔交易前持仓填入' : '全部卖出'}
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

        {/* 新增交易：自动从历史查净值，展示预览 */}
        {!pendingWatch && !editing && navPreview && navDecision.isExact && (
          <Alert
            type="success"
            showIcon
            message={`成交净值：${navPreview.nav.toFixed(4)}（${navPreview.navDate}）`}
            description={(() => {
              if (txTypeWatch === 'sell') return '卖出以份额为准，成交金额与实际到手见下方';
              if (txTypeWatch === 'dividend') return '请按分红方式填写金额或份额';
              const amt = amountWatch ?? 0;
              const fe = feeWatch ?? 0;
              // 手动录入的成交净值优先（用户从平台抄来的当日净值才是权威）
              const eff = manualNavWatch && manualNavWatch > 0 ? manualNavWatch : navPreview.nav;
              const s = amt ? (amt - fe) / eff : null;
              return s !== null ? (
                <>
                  预计份额：<strong>{s.toFixed(4)}</strong> 份
                  <br />（{amt} - {fe}）÷ {eff.toFixed(4)}
                </>
              ) : (
                '请输入金额后查看预计份额'
              );
            })()}
            action={<Button size="small" onClick={handleRefreshNav}>刷新净值</Button>}
            style={{ marginBottom: 16 }}
          />
        )}
        {/* 净值不是交易当日的 → 警告（用它推算份额会算错），并允许手填当日净值 */}
        {!pendingWatch && !editing && navPreview && !navDecision.isExact && (
          <Alert
            type="warning"
            showIcon
            message={`该日期的净值尚未收录（本地最近 ${navPreview.navDate}）`}
            description={navDecision.warning}
            action={<Button size="small" onClick={handleRefreshNav}>刷新净值</Button>}
            style={{ marginBottom: 16 }}
          />
        )}
        {/* 本地完全没有这条基金的净值记录 */}
        {!pendingWatch && !editing && !navPreview && dateWatch && targetFundId && (
          <Alert
            type="warning"
            showIcon
            message="未找到该日期的净值"
            description="该日期之前无历史净值数据，请切换为待确认，或先刷新净值"
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
        {!pendingWatch && !editing && (!navPreview || !navDecision.isExact) && dateWatch && targetFundId && (
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
        {/* 编辑交易：保留手动输入净值（默认回填原值） */}
        {!pendingWatch && editing && (
          <Form.Item label="成交净值" name="nav" rules={[{ required: true, message: '请输入成交净值' }]}>
            <InputNumber style={{ width: '100%' }} min={0} step={0.0001} precision={4} />
          </Form.Item>
        )}
        <Form.Item label="备注" name="note">
          <Input placeholder="可选" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
