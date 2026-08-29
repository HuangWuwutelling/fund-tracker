import { useRef, useEffect } from 'react';
import { Modal, Form, DatePicker, InputNumber, Alert, message } from 'antd';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import { useStore } from '../stores';
import { formatMoney } from '../utils/formatter';
import type { Transaction } from '../types';

interface Props {
  fundId: string | null;
  open: boolean;
  onClose: () => void;
}

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

  // 关闭后清掉表单状态
  useEffect(() => {
    if (!open) {
      form.resetFields();
      prevFilledCount.current = 0;
    }
  }, [open, form]);

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
      message.success(`已设置初始持仓：${shares.toFixed(2)} 份，累计成本 ${formatMoney(totalCost)}`);
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
          const isFilled = (v: unknown) => typeof v === 'number' && v > 0;
          const { shares, price, cost } = all;
          const filled = [isFilled(shares), isFilled(price), isFilled(cost)].filter(Boolean).length;
          if (filled === 2 && prevFilledCount.current === 1) {
            if (!isFilled(shares) && isFilled(price) && isFilled(cost)) {
              form.setFieldValue('shares', +(cost! / price!).toFixed(4));
            } else if (!isFilled(price) && isFilled(shares) && isFilled(cost)) {
              form.setFieldValue('price', +(cost! / shares!).toFixed(4));
            } else if (!isFilled(cost) && isFilled(shares) && isFilled(price)) {
              form.setFieldValue('cost', +(shares! * price).toFixed(2));
            }
          }
          prevFilledCount.current = filled;
        }}
      >
        <Form.Item label="持仓开始日期" name="startDate" rules={[{ required: true, message: '请选择开始日期' }]}>
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="当前持有份额" name="shares" rules={[{ required: true, message: '请输入持有份额' }]}>
          <InputNumber style={{ width: '100%' }} min={0} precision={4} placeholder="例如：1500.50" />
        </Form.Item>
        <Form.Item label="持仓单价（元）" name="price" rules={[{ required: true, message: '请输入持仓单价' }]}>
          <InputNumber style={{ width: '100%' }} min={0} step={0.0001} precision={4} placeholder="例如：1.0928" />
        </Form.Item>
        <Form.Item label="累计投入本金（元）" name="cost" rules={[{ required: true, message: '请输入累计投入' }]}>
          <InputNumber style={{ width: '100%' }} min={0} precision={2} placeholder="例如：5000" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
