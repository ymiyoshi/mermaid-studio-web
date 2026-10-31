// core の公開窓口。UI や入出力はここから読み込む（core の中のモジュールはここを読み込まない）。
//
//   state.ts       ストア（useSession）と型
//   editorBus.ts   エディタへの通知、IME 変換中の変更の確定
//   editing.ts     変更の適用（applyChanges）、undo / redo、履歴の操作
//   persistence.ts 遅延保存（flush）
//   documents.ts   図の管理、複数タブの書き込み権、起動
//   notify.ts      トースト、保存領域の表示

export { useSession, type CurrentDoc, type StorageInfo } from './state';
export { editorBus, registerEditorFlush, type EditorEvent } from './editorBus';
export {
  applyChanges,
  applyDiagramChange,
  jumpTo,
  nameCheckpoint,
  normalize,
  pruneBranches,
  redo,
  renameCurrent,
  revealRange,
  setSelection,
  setTags,
  travel,
  travelTime,
  undo,
  type ApplyMeta,
} from './editing';
export { flush } from './persistence';
export {
  createDoc,
  createFromTemplate,
  duplicateDoc,
  duplicateFromHistory,
  init,
  openDoc,
  openInitialDoc,
  purgeDoc,
  reloadDocList,
  restoreDoc,
  setFileBinding,
  setTheme,
  trashDoc,
} from './documents';
export { showToast } from './notify';
