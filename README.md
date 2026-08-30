# 基金投资记录

一个个人向的基金投资跟踪 Web 应用，把分散在多个直销平台（南方基金、摩根、广发基金等）的持仓聚合到一处，做收益分析和定投管理。

## 关于

最初是为了解决"持仓分散在好几个 App 里、每天切来切去看净值"的痛点而写的。每个平台都只展示自己那部分的收益，想看跨平台的整体表现（按日、按周、按月、当日盈亏、年化 XIRR）就只能手动汇总。

特性：

- **聚合持仓**：跨平台、跨基金类型（指数 / 债券 / QDII / 混合）
- **真实净值**：自动从东方财富拉历史净值，T+1 自动确认份额
- **收益分析**：总收益、当日盈亏、年化（XIRR）、累计分红、各基金表现排名
- **定投管理**：周 / 双周 / 月 / 日多种频率的执行追踪
- **周报月报**：自动生成，附各平台、类型的收益贡献和最佳 / 最差基金
- **数据自主**：纯前端，数据存在本地 localStorage，支持导出 / 导入备份

## 技术栈

- **React 18 + TypeScript 5.6 + Vite 6** —— SPA 基础
- **Ant Design 5**（中文本地化）—— UI 组件
- **ECharts**（echarts-for-react）—— 饼图、折线图
- **Zustand 5** —— 单 store 全局状态管理
- **React Router 6** —— 路由（GitHub Pages 下用 `BrowserRouter + basename="/fund-tracker"`）
- **dayjs** —— 日期处理
- **uuid** —— 交易 / 定投计划 ID

纯前端无后端。东方财富 `pingzhongdata` 接口不支持 CORS，所以用 `<script>` 注入（JSONP 风格）拉数据。净值历史以 `fund-tracker:nav:{基金代码}` 为键存在 localStorage。

## 本地运行

```bash
npm install
npm run dev        # Vite dev server，HMR
npm run build      # Type-check + 生产构建，输出到 dist/
npm run preview    # 预览构建产物
```

## 部署

push 到 `main` 分支触发 `.github/workflows/deploy.yml`：先 build，再把 `dist/` 部署到 GitHub Pages。Vite 已配置 `base: '/fund-tracker/'`，与仓库名一致。

数据完全在浏览器本地，不上传到任何服务器。备份靠手动导出 JSON。

## 设计文档

完整规格说明、数据模型、计算公式：[`docs/superpowers/specs/2026-08-27-fund-tracker-design.md`](./docs/superpowers/specs/2026-08-27-fund-tracker-design.md)