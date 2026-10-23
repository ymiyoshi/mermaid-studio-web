# Mermaid Studio Web

ブラウザだけで動く Mermaid エディタ。設計は [docs/design.md](docs/design.md) を参照。

## 使い方

```sh
npm install      # .npmrc で legacy-peer-deps を有効にしている（npm 10 の依存解決の不具合回避）
npm run dev      # 開発サーバー
npm test         # 単体テスト（Vitest）
npm run build    # 型チェック + 本番ビルド（dist/、CSP 付き）
npm run preview  # 本番ビルドの確認
```

## 構成

| パス | 内容 |
|---|---|
| `src/core/history.ts` | ツリー型の履歴（ChangeSet の forward/inverse、スナップショット、ジャンプ） |
| `src/core/coalesce.ts` | 入力を履歴 1 ステップにまとめる規則 |
| `src/core/session.ts` | 文書の状態。すべての変更が通る `applyChanges()`、保存、複数タブ制御 |
| `src/storage/` | IndexedDB（文書・履歴・設定）、Web Locks / BroadcastChannel |
| `src/render/` | mermaid による検証と描画、エディタ用ハイライト |
| `src/plugins/` | 図種プラグイン（flowchart・sequence）と、汎用フォールバック（ラベル編集） |
| `src/ui/` | 画面（一覧・エディタ・図・履歴） |

## 進捗

- [x] Phase 0: 基盤（全図種の表示、テキスト⇔図のラベル編集、ツリー型の永続 undo、図の管理）
- [ ] Phase 1: flowchart プラグイン、SVG/PNG 出力
  - [x] 図から要素を追加: flowchart（ノード追加・次のノード・接続）、sequence（参加者・メッセージ）
  - [ ] 削除・形の変更・プロパティパネル、SVG/PNG 出力
- [ ] Phase 2〜4: 設計書 §12 を参照

### Phase 0 の既知の制限・設計との差分

- 履歴のスナップショットは未圧縮で保存している（設計では fflate で圧縮）
- 履歴ビューのホバープレビュー、名前付きチェックポイントは未実装
- 図の一覧にサムネイル・タグは未実装
- `zenuml` は mermaid 本体に含まれない外部図種のため対象外
- IME（日本語入力）の扱いは実装済みだが、実機での確認はまだ
