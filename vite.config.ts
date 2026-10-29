/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// 本番ビルドだけ CSP を埋め込む（開発サーバーは HMR のインラインスクリプトを使うため）。
// connect-src 'self' で図の内容が外部に送られないことを保証する（設計書 §11）。
// フォームの送信は通信ではなく画面の移動なので connect-src では止まらない。form-action 'none' で止める。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    cspPlugin(),
    // 設計書 §11: 一度開けばオフラインでも起動・編集できるように、図種ごとの遅延読み込みのチャンクも含めてすべてプリキャッシュする
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2,ttf}'],
        // elk（レイアウトエンジン）のチャンクが 1.5MB ほどあるので、上限を上げる
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'Mermaid Studio',
        short_name: 'Mermaid Studio',
        description: 'ブラウザだけで動く Mermaid エディタ',
        lang: 'ja',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#f6f7f9',
        theme_color: '#e0366b',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        // .mmd / .mermaid をこのアプリで開けるようにする（インストールした Chromium 系のみ。受け取りは io/files.ts の watchLaunchFiles）
        // ファイルを開くたびに新しいウィンドウが開く（launch_handler は既定のまま。focus-existing にすると、アイコンから
        // 2 つ目のウィンドウを開けなくなる）。同じ図を開いているウィンドウがあれば、新しいほうは読み取り専用になる（§8.5）
        file_handlers: [{ action: '.', accept: { 'text/vnd.mermaid': ['.mmd', '.mermaid'] } }],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/main.tsx'],
      reporter: ['text-summary', 'text'],
    },
  },
});
