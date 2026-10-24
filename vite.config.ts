/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// 本番ビルドだけ CSP を埋め込む（開発サーバーは HMR のインラインスクリプトを使うため）。
// connect-src 'self' で図の内容が外部に送られないことを保証する（設計書 §11）。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
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
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
