import { useState } from 'react';
import { Card, Row, Col, Tooltip } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined, LineChartOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useStore } from '../stores';
import { INDEX_LIST } from '../api/indexApi';
import { pnlColor } from '../utils/formatter';
import { etToBeijing } from '../utils/indexQuote';
import type { Market } from '../types';
import IndexHistoryModal from './IndexHistoryModal';

/** US 指数的日期前缀，明示"这是美东时区"——避免用户混淆美东 10-04 与北京 10-04 */
function tzLabel(market: Market): string {
  return market === 'US' ? '美东 ' : '';
}

/**
 * US 指数的日期行："美东 MM-DD HH:mm (北京 MM-DD HH:mm)"
 * 转换走 etToBeijing()，DST 期间 +12h，标准时期间 +13h。
 */
function usDateLine(date: string, time: string): string {
  if (!date) return '';
  const etLine = `${date.slice(5)}${time ? ` ${time}` : ''}`;
  if (!time) return `美东 ${etLine}`;
  const bj = etToBeijing(date, time);
  const bjLine = `${bj.date.slice(5)} ${bj.time}`;
  return `美东 ${etLine}（北京 ${bjLine}）`;
}

/**
 * Dashboard 上的 6 张市场指数卡片。版式（v2）：
 *   ┌────────────────────────┐
 *   │ 📊 沪深300    📈       │
 *   │                        │
 *   │  4357.62    ↑+12.41    │
 *   │             +0.29%     │
 *   │                        │
 *   │  09-30 16:14           │
 *   └────────────────────────┘
 *
 * 大字是指数点位（不是 ETF NAV），旁边的箭头 + 涨跌额 + 涨跌幅是右栏；
 * 下方一行是数据日期 + 时间（带市场 TZ 前缀）。
 *
 * 数据流：完全被动 —— 读 `useStore().indices[spec.code]`，由 App.refreshAll 在后台更新。
 * 组件本身不发请求、不持有副作用。
 *
 * 交互：整张卡片 clickable，hover 右上角显示 📈 提示，点击打开 IndexHistoryModal
 * 查看历史走势。点击行为与"无 quote 数据"互不干扰——没数据时点击只会打开空 modal。
 *
 * 空态：cache 没有数据 / value=0 → 显示 "—"，直到下一次 refreshAll 跑完。
 * **不**在此处触发请求，避免每次 mount 都重发——App.refreshAll 是唯一刷新入口。
 */
export default function MarketIndices() {
  const indices = useStore((s) => s.indices);
  const [openCode, setOpenCode] = useState<string | null>(null);

  return (
    <>
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {INDEX_LIST.map((spec) => {
          const quote = indices[spec.code];
          // value === 0 也算"没拉到"
          const showQuote = quote && quote.value !== 0;

          return (
            <Col xs={24} sm={12} md={8} key={spec.code}>
              <Card
                size="small"
                hoverable
                onClick={() => setOpenCode(spec.code)}
                style={{ cursor: 'pointer' }}
                title={
                  <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>📊 {spec.name}</span>
                    <Tooltip title="点击查看历史走势">
                      <LineChartOutlined style={{ fontSize: 14, color: '#999' }} />
                    </Tooltip>
                  </span>
                }
              >
                {showQuote ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                      <div
                        style={{
                          fontSize: 28,
                          fontWeight: 700,
                          lineHeight: 1.2,
                          fontFamily: 'DIN, "Helvetica Neue", Arial, sans-serif',
                          color: pnlColor(quote.change),
                        }}
                      >
                        {quote.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          color: pnlColor(quote.change),
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-end',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>
                          {quote.change > 0 && (
                            <ArrowUpOutlined style={{ fontSize: 12, marginRight: 2 }} />
                          )}
                          {quote.change < 0 && (
                            <ArrowDownOutlined style={{ fontSize: 12, marginRight: 2 }} />
                          )}
                          {quote.change >= 0 ? '+' : ''}
                          {quote.change.toFixed(2)}
                        </span>
                        <span style={{ fontSize: 11 }}>
                          ({quote.changePercent >= 0 ? '+' : ''}
                          {quote.changePercent.toFixed(2)}%)
                        </span>
                      </div>
                    </div>
                    <Tooltip
                      title={`本地拉取于 ${dayjs(quote.fetchedAt).format('YYYY-MM-DD HH:mm:ss')}`}
                    >
                      <div style={{ fontSize: 11, color: '#999', marginTop: 8 }}>
                        {quote.market === 'US'
                          ? usDateLine(quote.date, quote.time)
                          : `${tzLabel(quote.market)}${quote.date.slice(5)}${quote.time ? ` ${quote.time}` : ''}`}
                      </div>
                    </Tooltip>
                  </>
                ) : (
                  <div style={{ color: '#999', fontSize: 13, padding: '12px 0' }}>
                    —
                  </div>
                )}
              </Card>
            </Col>
          );
        })}
      </Row>
      <IndexHistoryModal code={openCode} onClose={() => setOpenCode(null)} />
    </>
  );
}
