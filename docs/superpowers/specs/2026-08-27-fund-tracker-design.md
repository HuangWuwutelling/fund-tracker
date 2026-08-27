# 基金投资记录 — 设计文档

## 概述

一个纯前端的基金投资管理 Web 应用，用于汇总跨直销平台（南方基金、摩根资产管理、广发基金）的基金投资数据。支持自动拉取净值、手动记录交易、定投计划管理、周报/月报生成。数据存储在浏览器 localStorage，部署在 GitHub Pages。

## 技术栈

| 技术 | 用途 |
|------|------|
| React 18 + TypeScript | 应用框架 |
| Vite | 构建工具 |
| Ant Design 5 | UI 组件库 |
| ECharts | 图表（饼图、折线图） |
| Zustand | 轻量状态管理 |
| React Router 6 | 页面路由 |
| localStorage | 数据持久化 |
| 天天基金 JSONP API | 基金净值数据 |
| GitHub Pages | 静态部署 |

## 页面路由

```
/                 → Dashboard 资产总览
/funds            → 基金管理（增删改）
/funds/:id        → 基金详情（净值走势 + 交易记录）
/transactions     → 全局交易记录
/dca              → 定投计划管理
/reports          → 周报/月报
```

## 数据模型

### Fund（基金）

```typescript
interface Fund {
  id: string;              // 基金代码，如 "160140"
  name: string;            // 基金名称
  platform: string;        // 来源平台：南方基金 / 摩根资管 / 广发基金
  type: 'index' | 'bond' | 'qdii' | 'mixed';
  currentNav: number;      // 最新单位净值
  navDate: string;         // 净值日期（YYYY-MM-DD）
  navHistory: NavRecord[]; // 净值历史
}
```

### NavRecord（净值记录）

```typescript
interface NavRecord {
  date: string;            // YYYY-MM-DD
  nav: number;             // 单位净值
  accNav: number;          // 累计净值
}
```

### Transaction（交易记录）

```typescript
interface Transaction {
  id: string;              // UUID
  fundId: string;          // 关联基金代码
  type: 'buy' | 'sell' | 'dividend';
  date: string;            // 交易日期 YYYY-MM-DD
  amount: number;          // 金额（元）
  shares: number;          // 份额
  nav: number;             // 成交净值
  note?: string;           // 备注
}
```

### DcaPlan（定投计划）

```typescript
interface DcaPlan {
  id: string;              // UUID
  fundId: string;          // 关联基金代码
  amount: number;          // 每期定投金额（元）
  frequency: 'weekly' | 'biweekly' | 'monthly';
  dayOfWeek?: number;      // 0-6，周几（周/双周定投时使用）
  dayOfMonth?: number;     // 1-28，每月几号（月定投时使用）
  active: boolean;         // 是否启用
  startDate: string;       // 开始日期
}
```

### Settings（用户设置）

```typescript
interface Settings {
  theme: 'light' | 'dark';
  navAutoRefresh: boolean;
  reportFrequency: 'weekly' | 'monthly' | 'both';
}
```

### localStorage 键设计

```
fund-tracker:funds        → Fund[]
fund-tracker:transactions → Transaction[]
fund-tracker:dca-plans    → DcaPlan[]
fund-tracker:settings     → Settings
```

## 页面设计

### Dashboard（资产总览）

**顶部统计卡片行（4 个 Ant Design Statistic 卡片）：**
- 总资产（当前市值总和）
- 总收益（当前市值 - 持仓成本）
- 总收益率（百分比，绿涨红跌）
- 当日盈亏（今日市值变化）

**中部图表区（Ant Design Tabs 切换）：**
- Tab 1 — 资产分布饼图：按平台分 / 按基金类型分（ECharts 饼图）
- Tab 2 — 收益走势折线图：近 30 天 / 近 1 年 / 全部（ECharts 折线图）

**底部持仓列表（Ant Design Table）：**
- 列：基金名称、平台、持仓成本、当前市值、收益率、当日盈亏
- 收益率/盈亏列：正值红色、负值绿色
- 点击行跳转基金详情页

### 基金管理页

**添加基金表单（Ant Design Modal）：**
- 输入基金代码 → 调用天天基金 API 自动填充名称和类型
- 选择平台（下拉：南方基金 / 摩根资管 / 广发基金）
- 确认后保存到 localStorage

**基金列表（Ant Design Table）：**
- 列：基金代码、名称、平台、类型、最新净值、净值日期
- 操作：编辑、删除
- 空状态引导用户添加第一只基金

### 基金详情页

**顶部信息卡片：**
- 基金代码、名称、平台、类型
- 最新净值 + 净值日期
- 持仓成本、当前市值、收益率、当日盈亏

**净值走势图（ECharts 折线图）：**
- 时间范围切换：近 1 月 / 近 3 月 / 近 6 月 / 近 1 年 / 全部

**交易记录表格（Ant Design Table）：**
- 该基金的所有交易记录
- 快速添加交易按钮

### 交易记录页

**筛选栏：**
- 基金选择（下拉）
- 交易类型（买入 / 卖出 / 分红）
- 日期范围选择器

**交易列表（Ant Design Table，按日期倒序）：**
- 列：日期、基金名称、类型、金额、份额、净值、备注
- 操作：编辑、删除

**添加交易表单（Ant Design Modal）：**
- 选择基金 → 类型 → 日期 → 金额（自动根据净值算份额，或手动输入净值反算）
- 备注（可选）

### 定投计划页

**计划列表（Ant Design Card 或 Table）：**
- 每个计划显示：基金名称、每期金额、频率、下次定投日期、状态（启用/停用）
- 操作：编辑、启停、删除

**定投统计：**
- 累计投入金额
- 当前市值
- 定投收益率

**创建/编辑定投表单（Ant Design Modal）：**
- 选择基金 → 每期金额 → 频率（周/双周/月）→ 具体日期 → 开始日期

### 周报/月报页

**报告选择：**
- Tab 切换：周报 / 月报
- 日期选择器选择具体哪一周/哪一月

**周报内容：**
- 本周操作汇总：买入 N 笔 / 卖出 N 笔 / 分红 N 笔
- 本周总收益金额和收益率
- 各基金本周表现排名（最佳/最差）
- 定投执行情况：本期应投 N 笔，已记录 M 笔

**月报内容：**
- 本月总资产变化曲线（ECharts 折线图）
- 本月收益率
- 各平台收益贡献（堆叠柱状图）
- 各基金类型收益贡献
- 本月最佳/最差基金

## 计算逻辑

### 持仓计算

```
持有份额 = Σ(买入份额) - Σ(卖出份额) + Σ(分红再投份额)
持仓成本 = Σ(买入金额) - Σ(卖出回款金额)
当前市值 = 持有份额 × 最新净值
总收益   = 当前市值 - 持仓成本
收益率   = (总收益 / 持仓成本) × 100%
当日盈亏 = 持有份额 × (今日净值 - 昨日净值)
```

### 买入份额计算

```
份额 = 金额 / 净值
```

用户录入交易时：输入金额 → 自动用当天净值算份额；或输入净值 → 反算份额。

### 周报/月报计算

```
周收益 = 周末市值 - 周初市值 + 本周卖出回款 - 本周买入金额
周收益率 = 周收益 / 周初市值 × 100%
```

月报同理，以月为单位。

## API 集成

### 天天基金接口

**基金基本信息 + 实时估值（JSONP）：**
```
https://fundgz.1234567.com.cn/js/{fundCode}.js
```
返回 JSONP 回调，包含基金名称、当前估值净值、估值涨跌幅、估值时间。

**历史净值（JSONP）：**
```
https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code={fundCode}&page=1&sdate={startDate}&edate={endDate}&per=40
```
返回 HTML 表格，需解析提取日期、单位净值、累计净值。

### API 封装策略

- `src/api/fundApi.ts` — 封装所有天天基金接口调用
- JSONP 方式调用，创建 `<script>` 标签注入页面
- 错误处理：网络失败时显示提示，不阻塞页面
- 限流：批量拉取时每次请求间隔 500ms，避免被限流
- 缓存：当日已拉取的净值存入 localStorage，当天不重复请求

### QDII 基金特殊处理

- QDII 基金净值更新延迟 T+1 或 T+2
- 页面显示"净值日期"字段，用户可直观判断数据时效
- 如最新净值日期距今超过 2 天，显示黄色提示

## 数据导入/导出

**导出：**
- 将所有 localStorage 数据序列化为 JSON
- 使用 `URL.createObjectURL` + `<a>` 标签触发下载
- 文件名：`fund-tracker-backup-{date}.json`

**导入：**
- `<input type="file">` 选择 JSON 文件
- 读取、校验数据结构
- 确认后覆盖 localStorage（先确认对话框）

## 项目结构

```
src/
├── api/
│   └── fundApi.ts           # 天天基金 API 封装
├── components/
│   ├── StatCard.tsx          # 统计卡片组件
│   ├── FundTable.tsx         # 基金/持仓表格
│   ├── TransactionForm.tsx   # 交易录入表单
│   └── ChartWrapper.tsx      # ECharts 封装
├── hooks/
│   ├── useFunds.ts           # 基金数据 hook
│   ├── useTransactions.ts    # 交易记录 hook
│   ├── useDcaPlans.ts        # 定投计划 hook
│   └── useNavRefresh.ts      # 净值刷新 hook
├── pages/
│   ├── Dashboard.tsx         # 资产总览
│   ├── FundList.tsx          # 基金管理
│   ├── FundDetail.tsx        # 基金详情
│   ├── Transactions.tsx      # 交易记录
│   ├── DcaPlans.tsx          # 定投计划
│   └── Reports.tsx           # 周报/月报
├── stores/
│   └── index.ts              # Zustand store 定义
├── types/
│   └── index.ts              # TypeScript 类型定义
├── utils/
│   ├── calculator.ts         # 收益/份额计算
│   ├── formatter.ts          # 金额/日期/百分比格式化
│   └── reportGenerator.ts   # 周报/月报数据生成
├── App.tsx
├── main.tsx
└── index.css
```

## 部署

### GitHub Pages 部署

1. 仓库设为 Private
2. Vite 配置 `base` 为仓库名：`/fund-tracker/`
3. 使用 GitHub Actions 自动构建部署：

```yaml
# .github/workflows/deploy.yml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run build
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
```

## 开发命令

```bash
npm create vite@latest fund-tracker -- --template react-ts
cd fund-tracker
npm install antd echarts zustand react-router-dom
npm run dev          # 本地开发
npm run build        # 生产构建
npm run preview      # 预览生产构建
```

## 安全与隐私

- 所有投资数据仅存储在浏览器 localStorage，不上传任何服务器
- GitHub 仓库仅包含代码，不含个人数据
- 无用户认证系统（个人工具，无需登录）
- 建议定期使用导出功能备份数据

## 后续扩展（不在本期范围）

- 浏览器扩展版本（类似养基宝 Chrome 插件）
- OCR 识图录入持仓
- PWA 支持（离线可用、添加到主屏幕）
- 多设备数据同步（需后端）
