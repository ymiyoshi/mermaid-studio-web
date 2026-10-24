import { defineConfig } from '@playwright/test';

// 設計書 §13: E2E テスト。本番ビルド（CSP・PWA 込み）を vite preview で配信し、インストール済みの Chrome で動かす。
// 各テストは新しいブラウザコンテキスト（空の IndexedDB）で始まる。

const PORT = 4173;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'chrome',
    locale: 'ja-JP',
    viewport: { width: 1440, height: 900 },
  },
  // 動画の書き出し（e2e/video.spec.ts）は、ほかが終わってから単独で走らせる
  projects: [
    { name: 'main', testIgnore: /video\.spec\.ts/ },
    { name: 'video', testMatch: /video\.spec\.ts/, dependencies: ['main'] },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
