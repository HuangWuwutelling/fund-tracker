import { Card, Row, Col, Tooltip } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useStore } from '../stores';
import { INDEX_LIST } from '../api/indexApi';
import { pnlColor } from '../utils/formatter';
import type { Market } from '../types';

/** US 指数的日期前缀，明示"这是美东时区"——避免用户混淆美东 10-04 与北京 10-04 */
function tzLabel(market: Market): string {
  return market === 'US' ? '美东 ' : '';
}

/**
 * Dashboard 上的 3 张市场指数卡片。每张显示：名称 + 点位（涨跌色）+ 涨跌额/涨跌幅 +
 * 数据日期（带市场 TZ 前缀）。红涨绿跌（pnlColor）。
 *
 * 数据流：完全被动 —— 读 `useStore().indices[spec.code]`，由 App.refreshAll 在后台更新。
 * 组件本身不发请求、不持有副作用。
 *
 * 空态：cache 没有数据 / value=0 → 显示 "—"，直到下一次 refreshAll 跑完。
 * **不**在此处触发请求，避免每次 mount 都重发——App.refreshAll 是唯一刷新入口。
 */
export default function MarketIndices() {
  const indices = useStore((s) => s.indices);

  return (
    <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
      {INDEX_LIST.map((spec) => {
        const quote = indices[spec.code];
        // value === 0 也算"没拉到"：push2 在 f43=0 时通常是 "data: null" 的退化形态
        const showQuote = quote && quote.value !== 0;

        return (
          <Col xs={24} sm={8} key={spec.code}>
            <Card size="small" hoverable>
              <div style={{ color: '#666', fontSize: 13, marginBottom: 6 }}>
                📊 {spec.name}
              </div>
              {showQuote ? (
                <>
                  <div
                    style={{
                      fontSize: 26,
                      fontWeight: 700,
                      lineHeight: 1.2,
                      fontFamily: 'DIN, "Helvetica Neue", Arial, sans-serif',
                      color: pnlColor(quote.change),
                    }}
                  >
                    {quote.change > 0 && (
                      <ArrowUpOutlined style={{ fontSize: 14, marginRight: 4 }} />
                    )}
                    {quote.change < 0 && (
                      <ArrowDownOutlined style={{ fontSize: 14, marginRight: 4 }} />
                    )}
                    {quote.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: pnlColor(quote.change),
                      marginTop: 6,
                    }}
                  >
                    {quote.change >= 0 ? '+' : ''}
                    {quote.change.toFixed(2)}{' '}
                    ({quote.changePercent >= 0 ? '+' : ''}
                    {quote.changePercent.toFixed(2)}%)
                  </div>
                  <Tooltip
                    title={`本地拉取于 ${dayjs(quote.fetchedAt).format('YYYY-MM-DD HH:mm:ss')}`}
                  >
                    <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
                      {tzLabel(quote.market)}
                      {quote.date.slice(5)}
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
  );
}
