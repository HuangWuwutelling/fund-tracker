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
  /** 强调样式；'today' → 1.5px solid #1677ff 边框（与选中态区分） */
  accent?: 'today';
  /** 暗淡样式：单元格 opacity 0.3 + 副文本用浅色（用于月历里的"非本月"格子） */
  dim?: boolean;
  /**
   * 待更新样式：用于"今日 NAV 未完整发布"的格子——灰底 + 主数字显示为 "—"
   * 优先级高于 accent/dim（但低于 selected 边框）
   */
  pending?: boolean;
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
 * - 选中态边框：2px solid #1677ff（最高优先级）
 * - 今日边框（cell.accent === 'today'）：1.5px solid #1677ff
 * - 暗淡态（cell.dim === true）：opacity 0.3 + 副文本用 #bbb（用于月历非本月格子）
 * - 待更新态（cell.pending === true）：淡灰底 + 主数字显示 "—"（用于今日 NAV 未发布）
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
          if (cell.pending) {
            // 净值未发布：淡灰底，跳过红绿热力配色
            bg = '#f0f0f0';
          } else if (cell.value !== 0 || cell.intensity !== undefined) {
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
          // 边框优先级 selected > today > default
          const border = isSelected
            ? '2px solid #1677ff'
            : cell.accent === 'today'
            ? '1.5px solid #1677ff'
            : '1px solid #e8e8e8';
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
                  border,
                  borderRadius: 6,
                  cursor: onCellClick ? 'pointer' : 'default',
                  opacity: cell.dim ? 0.3 : 1,
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
                  <div
                    style={{
                      fontSize: 13,
                      color: cell.dim || cell.pending ? '#bbb' : '#666',
                      alignSelf: 'flex-start',
                    }}
                  >
                    {cell.label}
                  </div>
                )}
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    color: cell.pending
                      ? '#bbb'
                      : cell.value > 0
                      ? '#a8071a'
                      : cell.value < 0
                      ? '#237804'
                      : '#666',
                    lineHeight: 1.2,
                    marginTop: 4,
                  }}
                >
                  {cell.pending ? '—' : `${cell.value > 0 ? '+' : ''}${cell.value.toFixed(0)}`}
                </div>
              </div>
            </Tooltip>
          );
        })}
      </div>
    </>
  );
}