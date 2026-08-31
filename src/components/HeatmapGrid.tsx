import { Tooltip } from 'antd';

export interface HeatmapCell {
  /** 唯一标识：日='YYYY-MM-DD'、月='YYYY-MM'、年='YYYY' */
  key: string;
  /** 单元格主数字（收益金额，元） */
  value: number;
  /** 副文本（可选，例如 '8/27' 显示在格子上方） */
  label?: string;
  /** 透明度 0~1，可选，省略则按 |value|/maxAbsValue 自动计算 */
  intensity?: number;
}

export interface HeatmapGridProps {
  cells: HeatmapCell[];
  maxAbsValue: number;
  /** 周几表头（如 ['日','一',...,'六']）；非日历布局可省略 */
  weekdayLabels?: string[];
  /** 网格列数；日=7、月=12、年=N；默认 7 */
  columns?: number;
  /** 当前选中格子的 key */
  selectedKey?: string | null;
  /** 点击单元格回调 */
  onCellClick?: (key: string) => void;
  /** Tooltip 文本生成器；省略则默认 `${key}: ${value.toFixed(0)}` */
  formatTooltip?: (cell: HeatmapCell) => string;
}

const DEFAULT_COLUMNS = 7;

/**
 * 通用红绿热力格（日 / 月 / 年 三类粒度共用）
 * - value > 0 红（rgba(255,77,79,*)）、value < 0 绿（rgba(82,196,26,*)）、无数据灰
 * - 透明度 = 0.12 + intensity * 0.55，intensity 由 |value|/maxAbsValue 算得（0~1）
 * - 选中态边框：2px solid #1677ff
 * - 今日边框：1.5px solid #1677ff（由调用方通过 label 或 formatTooltip 区分；本组件不感知）
 */
export default function HeatmapGrid({
  cells,
  maxAbsValue,
  weekdayLabels,
  columns = DEFAULT_COLUMNS,
  selectedKey,
  onCellClick,
  formatTooltip,
}: HeatmapGridProps) {
  return (
    <>
      {weekdayLabels && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, 1fr)`,
            gap: 6,
            marginBottom: 6,
          }}
        >
          {weekdayLabels.map((d, i) => (
            <div
              key={i}
              style={{
                textAlign: 'center',
                fontSize: 13,
                color: '#999',
                padding: 6,
                fontWeight: 500,
              }}
            >
              {d}
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: 6,
        }}
      >
        {cells.map((cell) => {
          let bg = '#fafafa';
          if (cell.value !== 0 || cell.intensity !== undefined) {
            const intensity =
              cell.intensity ??
              (maxAbsValue > 0 ? Math.min(Math.abs(cell.value) / maxAbsValue, 1) : 0);
            const opacity = 0.12 + intensity * 0.55;
            // 中国惯例：红涨绿跌
            if (cell.value > 0) bg = `rgba(255, 77, 79, ${opacity})`;
            else if (cell.value < 0) bg = `rgba(82, 196, 26, ${opacity})`;
            else bg = '#f0f0f0';
          }
          const isSelected = selectedKey === cell.key;
          const tooltipText = formatTooltip
            ? formatTooltip(cell)
            : `${cell.key}: ${cell.value.toFixed(0)}`;
          return (
            <Tooltip key={cell.key} title={tooltipText}>
              <div
                onClick={() => onCellClick?.(cell.key)}
                style={{
                  minHeight: 84,
                  padding: 8,
                  background: bg,
                  border: isSelected ? '2px solid #1677ff' : '1px solid #e8e8e8',
                  borderRadius: 6,
                  cursor: onCellClick ? 'pointer' : 'default',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'transform 0.1s',
                }}
                onMouseEnter={(e) => {
                  if (onCellClick) e.currentTarget.style.transform = 'scale(1.03)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'scale(1)';
                }}
              >
                {cell.label !== undefined && (
                  <div style={{ fontSize: 13, color: '#666', alignSelf: 'flex-start' }}>
                    {cell.label}
                  </div>
                )}
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    color:
                      cell.value > 0
                        ? '#a8071a'
                        : cell.value < 0
                        ? '#237804'
                        : '#666',
                    lineHeight: 1.2,
                    marginTop: 4,
                  }}
                >
                  {cell.value > 0 ? '+' : ''}
                  {cell.value.toFixed(0)}
                </div>
              </div>
            </Tooltip>
          );
        })}
      </div>
    </>
  );
}