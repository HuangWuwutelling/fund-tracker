import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/fund-tracker/',
  test: {
    // 纯函数单测，不碰 DOM / localStorage —— 用 node 环境，省掉 jsdom 依赖
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
