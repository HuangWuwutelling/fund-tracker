import { useRef, useEffect, useMemo } from 'react';
import { Modal, Form, DatePicker, InputNumber, Alert, message, Descriptions, Tag, Space } from 'antd';
import { WarningTwoTone, CheckCircleTwoTone } from '@ant-design/icons';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { formatMoney, formatPercent } from '../utils/formatter';
import { calcSharesFromAmount } from '../utils/calculator';
import type { Transaction } from '../types';

interface Props {
  fundId: string | null;
  open: boolean;
  onClose: () => void;
}

/** 字段是否填了合法正数 */
const isFilled = (v: unknown): v is number => typeof v === 'number' && v > 0;

/**
 * 初始持仓 Modal：把"已有持仓的开始状态"作为一笔 buy 交易写入历史。
 * 任意填入 份额/单价/本金 三项中的两项，第三项自动算出。
 * 用于 FundDetail、Transactions、FundList 三处入口。
 */
export default function InitialPositionModal({ fundId, open, onClose }: Props) {
  const { addTransaction, getFundById } = useStore();
  const [form] = Form.useForm();
  const prevFilledCount = useRef(0);
  const fund = fundId ? getFundById(fundId) : null;

  // 实时跟踪三个字段，自动算第三项 + 预览市值/收益率
  const sharesWatch = Form.useWatch('shares', form);
  const priceWatch = Form.useWatch('price', form);
  const costWatch = Form.useWatch('cost', form);

  // 关闭后清掉表单状态
  useEffect(() => {
    if (!open) {
      form.resetFields();
      prevFilledCount.current = 0;
    }
  }, [open, form]);

  // 计算"已知两个，第三个会自动算出"的值
  const computed = useMemo(() => {
    const filled: number = [isFilled(sharesWatch), isFilled(priceWatch), isFilled(costWatch)].filter(Boolean).length;
    if (filled === 2) {
      if (!isFilled(sharesWatch) && isFilled(priceWatch) && isFilled(costWatch)) {
        return { field: 'shares' as const, value: +(costWatch! / priceWatch!).toFixed(4) };
      }
      if (!isFilled(priceWatch) && isFilled(sharesWatch) && isFilled(costWatch)) {
        return { field: 'price' as const, value: +(costWatch! / sharesWatch!).toFixed(4) };
      }
      if (!isFilled(costWatch) && isFilled(sharesWatch) && isFilled(priceWatch)) {
        return { field: 'cost' as const, value: +(sharesWatch! * priceWatch!).toFixed(2) };
      }
    }
    return null;
  }, [sharesWatch, priceWatch, costWatch]);

  // 全部填齐后才显示市值 / 收益率预览
  const preview = useMemo(() => {
    if (!isFilled(sharesWatch) || !isFilled(priceWatch) || !isFilled(costWatch)) return null;
    const marketValue = sharesWatch! * (fund?.currentNav ?? priceWatch!);
    const pnl = marketValue - costWatch!;
    const returnRate = costWatch! > 0 ? (pnl / costWatch!) * 100 : 0;
    return { marketValue, pnl, returnRate };
  }, [sharesWatch, priceWatch, costWatch, fund]);

  // 数量级校验：份额 < 0.1 且 净值 > 1，提示"是否少输了几位"
  const magnitudeWarning = useMemo(() => {
    if (!isFilled(sharesWatch) || !isFilled(priceWatch) || !isFilled(costWatch)) return null;
    const expectedShares = costWatch! / priceWatch!;
    // 期望份额与用户输入差距超过 10 倍，且期望份额 > 1
    if (expectedShares > 1 && sharesWatch! * 10 < expectedShares) {
      const ratio = expectedShares / sharesWatch!;
      return {
        expected: expectedShares,
        ratio: Math.round(ratio),
        message: `份额似乎过小：按 ${formatMoney(costWatch!)} ÷ ${priceWatch!.toFixed(4)} 应为 ${expectedShares.toFixed(4)} 份（约是当前输入的 ${ratio} 倍）。请检查是否漏输了数字。`,
      };
    }
    return null;
  }, [sharesWatch, priceWatch, costWatch]);

  // 标签标记：哪个字段是自动算的
  const fieldLabel = (name: 'shares' | 'price' | 'cost', base: string) => {
    const isAuto = computed?.field === name;
    return (
      <Space>
        <span>{base}</span>
        {isAuto && <Tag color="blue">自动算出</Tag>}
      </Space>
    );
  };

  const handleOk = async () => {
    if (!fundId) return;
    try {
      const values = await form.validateFields();
      // 用计算后的最新值（即使有"自动算出"字段被用户清空过）
      const shares = (values.shares as number) ?? computed?.value ?? 0;
      const totalCost = (values.cost as number) ?? (shares * (values.price as number));
      const startDate = (values.startDate as dayjs.Dayjs).format('YYYY-MM-DD');
      const nav = (values.price as number) ?? ((totalCost / shares) || 0);

      const tx: Transaction = {
        id: uuid(),
        fundId,
        type: 'buy',
        date: startDate,
        amount: totalCost,
        fee: 0,
        shares,
        nav,
        note: '初始持仓',
      };

      addTransaction(tx);
      message.success(`已设置初始持仓：${shares.toFixed(4)} 份，累计成本 ${formatMoney(totalCost)}`);
      onClose();
    } catch {
      // validation failed
    }
  };

  return (
    <Modal
      title={`设置初始持仓${fund ? ` — ${fund.name}` : ''}`}
      open={open}
      onOk={handleOk}
      onCancel={onClose}
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
        form={form}
        layout="vertical"
        initialValues={{ startDate: dayjs().subtract(2, 'month') }}
        onValuesChange={(changed, all) => {
          const changedField = Object.keys(changed)[0] as string | undefined;
          if (!changedField || !['shares', 'price', 'cost'].includes(changedField)) return;
          const filled = [isFilled(all.shares), isFilled(all.price), isFilled(all.cost)].filter(Boolean).length;
          if (filled === 2 && prevFilledCount.current === 1) {
            if (!isFilled(all.shares) && isFilled(all.price) && isFilled(all.cost)) {
              form.setFieldValue('shares', +(all.cost! / all.price!).toFixed(4));
            } else if (!isFilled(all.price) && isFilled(all.shares) && isFilled(all.cost)) {
              form.setFieldValue('price', +(all.cost! / all.shares!).toFixed(4));
            } else if (!isFilled(all.cost) && isFilled(all.shares) && isFilled(all.price)) {
              form.setFieldValue('cost', +(all.shares! * all.price!).toFixed(2));
            }
          }
          prevFilledCount.current = filled;
        }}
      >
        <Form.Item label="持仓开始日期" name="startDate" rules={[{ required: true, message: '请选择开始日期' }]}>
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          label={fieldLabel('shares', '当前持有份额')}
          name="shares"
          rules={[{ required: true, message: '请输入持有份额' }]}
        >
          <InputNumber style={{ width: '100%' }} min={0} precision={4} placeholder="例如：1500.50" />
        </Form.Item>
        <Form.Item
          label={fieldLabel('price', '平均成本单价（元/份）')}
          name="price"
          rules={[{ required: true, message: '请输入平均成本单价' }]}
          extra="这里填你的持仓成本单价（平均买入价），不是最新净值"
        >
          <InputNumber style={{ width: '100%' }} min={0} step={0.0001} precision={4} placeholder="例如：1.0928" />
        </Form.Item>
        <Form.Item
          label={fieldLabel('cost', '累计投入本金（元）')}
          name="cost"
          rules={[{ required: true, message: '请输入累计投入' }]}
        >
          <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="例如：5000" />
        </Form.Item>
      </Form>

      {preview && (
        <Descriptions
          size="small"
          column={2}
          bordered
          style={{ marginTop: 8 }}
          title="预览（按当前净值）"
        >
          <Descriptions.Item label="当前净值">{fund ? fund.currentNav.toFixed(4) : '—'}</Descriptions.Item>
          <Descriptions.Item label="平均成本价">
            {priceWatch!.toFixed(4)}
          </Descriptions.Item>
          <Descriptions.Item label="当前市值">
            {formatMoney(preview.marketValue)}
          </Descriptions.Item>
          <Descriptions.Item label="持仓收益">
            <span style={{ color: preview.pnl > 0 ? '#cf1322' : preview.pnl < 0 ? '#389e0d' : undefined }}>
              {formatMoney(preview.pnl)}（{formatPercent(preview.returnRate)}）
            </span>
          </Descriptions.Item>
        </Descriptions>
      )}

      {magnitudeWarning && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningTwoTone twoToneColor="#faad14" />}
          message="数量级异常"
          description={magnitudeWarning.message}
          style={{ marginTop: 12 }}
        />
      )}

      {!magnitudeWarning && preview && (
        <div style={{ marginTop: 8, color: '#52c41a', fontSize: 12 }}>
          <CheckCircleTwoTone twoToneColor="#52c41a" /> 数据看起来正常
        </div>
      )}
    </Modal>
  );
}

// 抑制未使用警告（保留供将来使用）
void calcSharesFromAmount;
