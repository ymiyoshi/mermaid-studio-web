import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

// 応答時間の計測（npm run perf）。E2E と同じ本番ビルドとサーバーを使い、1 本ずつ順に測る。
// サーバーのコマンドは設定ファイルの場所で動くので、リポジトリの直下で動かす
const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  ...base,
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  webServer: { ...(base.webServer as object), cwd: root } as typeof base.webServer,
});
