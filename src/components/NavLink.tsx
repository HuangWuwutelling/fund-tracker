import type { ReactNode, MouseEvent, KeyboardEvent } from 'react';

/**
 * 模拟锚点链接：点击 + 键盘 Enter/Space 都能触发。
 * 用 <a> 渲染（保留 cursor:pointer + 蓝色下划线外观），但不带 href——
 * 因为没有真实 URL，避免右键"在新标签页打开"出空白页。
 * tabIndex=0 让 Tab 键能聚焦；Enter/Space 触发 onClick 满足键盘可达性。
 */
interface Props {
  onClick: () => void;
  children: ReactNode;
  style?: React.CSSProperties;
}

export default function NavLink({ onClick, children, style }: Props) {
  const handleKey = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    onClick();
  };
  return (
    <a
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKey}
      style={{ cursor: 'pointer', ...style }}
    >
      {children}
    </a>
  );
}