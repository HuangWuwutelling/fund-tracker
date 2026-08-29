import { useRef, useEffect, useMemo, useState } from 'react';
import { Modal, Form, DatePicker, InputNumber, Alert, message, Descriptions, Tag, Space } from 'antd';
import { WarningTwoTone, CheckCircleTwoTone } from '@ant-design/icons';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { formatMoney, formatPercent, pnlColor } from '../utils/formatter';
import type { Transaction } from '../types';

interface Props {
  fundId: string | null;
  open: boolean;
  onClose: () => void;
}

/** 字段是否填了合法正数 */
const isFilled = (v: unknown): v is number => typeof v === 'number' && v > 0;

type FieldName = 'shares' | 'price' | 'cost';

/**
 * 初始持仓 Modal：把"已有持仓的开始状态"作为一笔 buy 交易写入历史。
 * 任意填入 份额/单价/本金 三项中的两项，第三项自动算出。
 * 用于 FundDetail、Transactions、FundList 三处入口。
 */
export default function InitialPositionModal({ fundId, open, onClose }: Props) {
  const { addTransaction, getFundById } = useStore();
  const [form] = Form.useForm();
  const prevFilledCount = useRef(0);
  // 区分"用户手动改"vs"setFieldValue 触发的二次回调"：
  // 调用 form.setFieldValue 之前先把目标字段记到这里，onValuesChange 中比对后跳过
  const aboutToAutoFillRef = useRef<FieldName | null>(null);
  // 当前哪个字段是"自动算出来的"——驱动蓝色"自动算出"标签
  const [autoFilledField, setAutoFilledField] = useState<FieldName | null>(null);
  const fund = fundId ? getFundById(fundId) : null;

  const sharesWatch = Form.useWatch('shares', form);
  const priceWatch = Form.useWatch('price', form);
  const costWatch = Form.useWatch('cost', form);

  // 关闭后清掉表单状态
  useEffect(() => {
    if (!open) {
      form.resetFields();
      prevFilledCount.current = 0;
      aboutToAutoFillRef.current = null;
      setAutoFilledField(null);
    }
  }, [open, form]);

  // 当前"自动算出"的字段及其值
  const computed = useMemo(() => {
    if (!autoFilledField) return null;
    const value = form.getFieldValue(autoFilledField) as number;
    if (!isFilled(value)) return null;
    return { field: autoFilledField, value };
  }, [autoFilledField, sharesWatch, priceWatch, costWatch]);

  // 全部填齐后才显示市值 / 收益率预览
  const preview = useMemo(() => {
    if (!isFilled(sharesWatch) || !isFilled(priceWatch) || !isFilled(costWatch)) return null;
    const marketValue = sharesWatch! * (fund?.currentNav ?? priceWatch!);
    const pnl = marketValue - costWatch!;
    const returnRate = costWatch! > 0 ? (pnl / costWatch!) * 100 : 0;
    return { marketValue, pnl, returnRate };
  }, [sharesWatch, priceWatch, costWatch, fund]);

  // 数量级校验：份额与 cost/price 推算的预期份额相差超过 10 倍，提示"是否漏输了数字"
  const magnitudeWarning = useMemo(() => {
    if (!isFilled(sharesWatch) || !isFilled(priceWatch) || !isFilled(costWatch)) return null;
    const expectedShares = costWatch! / priceWatch!;
    if (expectedShares > 1 && sharesWatch! * 10 < expectedShares) {
      const ratio = Math.round(expectedShares / sharesWatch!);
      return {
        message: `份额似乎过小：按 ${formatMoney(costWatch!)} ÷ ${priceWatch!.toFixed(4)} 应为 ${expectedShares.toFixed(4)} 份（约是当前输入的 ${ratio} 倍）。请检查是否漏输了数字。`,
      };
    }
    return null;
  }, [sharesWatch, priceWatch, costWatch]);

  const fieldLabel = (name: FieldName, base: string) => (
    <Space>
      <span>{base}</span>
      {computed?.field === name && <Tag color="blue">自动算出</Tag>}
    </Space>
  );

  const handleOk = async () => {
    if (!fundId) return;
    try {
      const values = await form.validateFields();
      const shares = values.shares as number;
      const totalCost = values.cost as number;
      const startDate = (values.startDate as dayjs.Dayjs).format('YYYY-MM-DD');
      const nav = values.price as number;

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

          // setFieldValue 自动触发的二次回调：清掉 ref 后跳过，不破坏 prev 状态机
          if (changedField === aboutToAutoFillRef.current) {
            aboutToAutoFillRef.current = null;
            return;
          }

          // 用户主动改：清掉"自动算出"标记
          setAutoFilledField(null);

          const filled = [isFilled(all.shares), isFilled(all.price), isFilled(all.cost)].filter(Boolean).length;
          // filled 下降（用户清空字段）：重置 prev，避免后续 1→2 转换被旧的 3→2 阻塞
          if (filled < prevFilledCount.current) {
            prevFilledCount.current = filled;
            return;
          }
          if (filled === 2 && prevFilledCount.current === 1) {
            if (!isFilled(all.shares) && isFilled(all.price) && isFilled(all.cost)) {
              aboutToAutoFillRef.current = 'shares';
              setAutoFilledField('shares');
              form.setFieldValue('shares', +(all.cost! / all.price!).toFixed(4));
            } else if (!isFilled(all.price) && isFilled(all.shares) && isFilled(all.cost)) {
              aboutToAutoFillRef.current = 'price';
              setAutoFilledField('price');
              form.setFieldValue('price', +(all.cost! / all.shares!).toFixed(4));
            } else if (!isFilled(all.cost) && isFilled(all.shares) && isFilled(all.price)) {
              aboutToAutoFillRef.current = 'cost';
              setAutoFilledField('cost');
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
            <span style={{ color: preview.pnl !== 0 ? pnlColor(preview.pnl) : undefined }}>
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
