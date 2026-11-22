import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

/**
 * GitHub Pages 的 SPA 深链接兜底。
 *
 * 静态托管没有"所有路径都返回 index.html"的规则 → 直接访问 /fund-tracker/settings
 * 会拿到 404.html。public/404.html 把原路径暂存到 sessionStorage 并跳回应用根路径，
 * 这里在 React 启动**之前**把它写回地址栏，React Router 就能拿到正确的初始路由。
 *
 * 必须在 render 之前完成：Router 初始化时读的就是 window.location。
 */
(function restoreDeepLink() {
  try {
    const stored = sessionStorage.getItem('gh404-path');
    if (stored) {
      sessionStorage.removeItem('gh404-path');
      window.history.replaceState({}, '', stored);
    }
  } catch {
    /* 隐私模式下 sessionStorage 不可用 → 忽略，走默认根路径 */
  }
})();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
