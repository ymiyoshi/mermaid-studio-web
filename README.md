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
| `src/core/history.ts` | ツリー型の履歴（ChangeSet の forward/inverse、スナップショット、ジャンプ、チェックポイント、分岐の整理） |
| `src/core/coalesce.ts` | 入力を履歴 1 ステップにまとめる規則 |
| `src/core/session.ts` | 文書の状態。すべての変更が通る `applyChanges()`、保存、複数タブ制御 |
| `src/storage/` | IndexedDB（文書・履歴・ファイルの結び付き・サムネイル・設定）、Web Locks / BroadcastChannel |
| `src/io/` | ファイルの読み書き（.mmd / .md）、画像の書き出し（SVG / PNG）、バックアップ（JSON）、URL 共有 |
| `src/render/` | mermaid による検証と描画、エディタ用ハイライト、サムネイル |
| `src/plugins/` | 図種プラグイン（下の表）と、汎用フォールバック（ラベル編集） |
| `src/ui/` | 画面（一覧・エディタ・図・プロパティパネル・履歴） |

## 図種ごとの編集

| 図種 | 図からの編集 |
|---|---|
| flowchart | ノードの追加・次のノード（Tab）・接続・削除（Delete）、ラベル・形・ID の変更、エッジの線の種類・ラベル、向き |
| sequence | 参加者・メッセージの追加・削除、参加者の並べ替え・種類・表示名、メッセージの矢印・本文 |
| class | クラス・メンバー・関係の追加・削除、関係の種類・多重度・ラベル、クラス名・表示名・注釈 |
| state | 状態・次の状態・遷移の追加・削除、表示名・名前、遷移のラベル |
| ER | エンティティ・属性・リレーションの追加・削除、多重度・線・ラベル、エンティティ名 |
| mindmap / kanban | 子・兄弟（列・カード）の追加、部分木ごとの削除・並べ替え、テキスト・形 |
| pie / gantt / timeline / journey / gitGraph / quadrant / xychart / sankey / packet / radar / treemap / C4 / requirement / architecture / usecase | 表で行の追加・削除・並べ替え・値の変更、図全体の設定（タイトルなど） |
| block など上記以外 | ラベルの直接編集のみ（汎用フォールバック） |

すべての操作は、`mermaid.parse` で検証してから反映し、変更する行以外（コメント・空行・インデント）には触れない。

## 進捗

- [x] Phase 0: 基盤（全図種の表示、テキスト⇔図のラベル編集、ツリー型の永続 undo、図の管理）
- [x] Phase 1: flowchart（追加・削除・形・矢印・プロパティパネル）、SVG / PNG 出力
- [x] Phase 2: sequence / class / state / ER
- [x] Phase 3: gantt / pie / mindmap / gitGraph / journey / timeline（表で編集）
- [x] Phase 4: 残りの図種、ローカルファイル、URL 共有、PWA（オフライン）
- [x] 履歴: 名前付きチェックポイント、ホバーでの版のプレビューと差分、古い分岐の整理、スナップショットの圧縮
- [x] 図の一覧: サムネイル、タグ、並べ替え。ペインの折りたたみ、狭い画面のタブ表示

### 既知の制限・未実装

- `block` 図は、ラベルの直接編集のみ（追加・削除などは未対応）
- `zenuml` は mermaid 本体に含まれない外部図種のため対象外
- UI は日本語のみ（設計どおり英語は後で追加する）
- 設計書 §13 の Playwright による E2E テストは未整備（単体テストは Vitest）
- 設計書 §11 の応答時間の目標は未計測
- タッチ操作でのピンチによる拡大縮小は未対応（ボタンとホイールで拡大縮小）
- state 図の遷移は、SVG に端点の情報が無いため、描画の順番だけで対応付けている
- IME（日本語入力）の扱いは実装済みだが、実機での確認はまだ
- ファイルの上書き保存は Chromium 系のみ。Firefox / Safari では保存がダウンロードになる
- PNG 出力では、foreignObject を使う図種（journey など）のラベルを単純な SVG テキストに置き換える
- バックアップにはファイルとの結び付き（ハンドル）は含まれない
