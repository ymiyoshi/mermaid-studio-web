# AGENTS.md

このリポジトリで作業する AI エージェント向けの約束ごと。何を作っているかは `README.md`、なぜそう作ったかは `docs/design.md` を読むこと。ここには、コードを読むだけでは分からない決まりだけを書く。

## コマンド

```sh
npm install        # .npmrc の legacy-peer-deps=true が必要（npm 10 の依存解決が落ちるため。消さない）
npm run typecheck  # tsc（tests/ と e2e/ も対象）
npm test           # Vitest（300 件前後。数秒で終わる）
npm run test:e2e   # Playwright。本番ビルドを作って vite preview（4173 番）で配信し、インストール済みの Chrome で動かす
npm run build      # 型チェック + 本番ビルド
```

変更を終えたと言う前に、`npm run typecheck`・`npm test`・`npm run build` を通す。UI や保存に触れたら `npm run test:e2e` も通す。

## 守ること（設計の前提）

- **テキストが唯一の正。** 図のモデルを別に持たない。図からの操作は必ず `ChangeSpec` を作り、`applyDiagramChange()`（`src/core/editing.ts`）を通す。ここで `mermaid.parse` による検証をしてから適用するので、構文を壊す変更は履歴に残らない。
- **書き換えるのは対象の範囲だけ。** 図からの操作で、対象の行以外（コメント・空行・インデント）を変えてはいけない。行を組み立て直すのは、範囲で置き換えられないときだけ。
- **undo は自前の履歴ツリーだけ。** CodeMirror の `history()` 拡張を入れない（入れると undo が 2 系統になる）。
- **外部に通信しない。** CDN や外部 API を使わない（本番ビルドの CSP は `connect-src 'self'`）。図の内容をサーバーに送らない。
- **mermaid は常に `securityLevel: 'strict'`。** 共有リンクの内容は信頼できない入力として扱う。
- **IME を壊さない。** 変換中（`composing`）は反映しない、変換確定の Enter（`isComposing`）で閉じない、という処理は、入力欄に触れるときも残す。

## コードの置き場所と依存の向き

- `src/core/session.ts` は公開窓口（再エクスポートだけ）。UI や `src/io/` はここから読み込む。**`src/core/` の中のモジュールは `session.ts` を読み込まない**（循環を作らないため）。
- モジュールが持つ可変の状態（タイマー・ロックなど）は、持ち主のモジュールを 1 つに決める（`persistence.ts` の保存タイマー、`documents.ts` の書き込み権など）。
- 図種ごとの編集は `src/plugins/<図種>.ts` に `DiagramPlugin` として書き、`registry.ts` に登録する。行単位の共通処理は `lineOps.ts`・`source.ts`、表で編集する図種は `table.ts` と `dataPlugins.ts`。
- SVG の要素とソースは、**端点などの意味のある値で**対応付ける（`svg.ts` の `matchInOrder`）。描画の順番だけに頼るのは、他に手がかりが無いとき（state 図の遷移）に限る。

## mermaid の版

- `package.json` で版を固定している（`~` や `^` を付けない）。上げるときは:
  1. 開発サーバーで `tests/fixtures/capture.js` を実行し、`tests/fixtures/rendered-svg.json` を作り直す
  2. `npm test`（特に `svgMapping.test.ts`）と `npm run test:e2e` が通ることを確かめる
- `mermaid.parse` は DOM（DOMPurify）を使う。mermaid を呼ぶテストは先頭に `// @vitest-environment jsdom` を書く。

## テストの書き方

- 図からの操作を足したら、`mermaid.parse` を通ることと、変えていない行が残ることをテストする（`tests/graphPlugins.test.ts` などに倣う）。性質ベースのテストは `tests/property.test.ts`。
- IndexedDB を使うテストは `import 'fake-indexeddb/auto'` と、`beforeAll` での `db.resetDbConnection()` ＋ データベースの削除で始める。
- テスト用の File System Access API は `tests/helpers/fakeFs.ts`。偽のハンドルは IndexedDB に保存するとメソッドを失う点に注意（`tests/filesReopen.test.ts` の対処を参照）。
- E2E の `test.fail(...)` は既知の不具合。直したら `test.fail` を `test` に戻す（そのままだと Playwright が「通ってしまった」として失敗にする）。テストを通すために、テストを消したり弱めたりしない。
- 既知の不具合（`e2e/app.spec.ts` の末尾）: 編集のたびの描き直しの間、図ビューが「編集できない」扱いになる（入力欄のフォーカスが外れる・直後の Tab / Delete が効かない）。履歴のプレビューを出したまま図を切り替えると画面が消える。

## 文章と言語

- UI の文言は日本語。新しい文言は `src/i18n.ts` に足して `t()` で使う（ただしプラグインの中の文言は、まだ直書きのものがある）。
- コメント・テストの名前・コミットメッセージも日本語。設計書の節（`§8.3` など）を参照すると、理由をたどれる。
- 保存形式（IndexedDB）を変えるときは、`src/storage/db.ts` の版を上げて `upgrade` に移行を足す。古いデータを読めなくしない。
