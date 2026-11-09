import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { init } from './core/session';
import { startRenderPipeline } from './render/pipeline';
import { importFromLocationHash, watchShareLinks } from './io/shareActions';
import { startThumbnails } from './render/thumbs';
import { watchLaunchFiles } from './io/files';
import { loadFolders } from './io/folders';
import { preloadMermaid } from './render/mermaid';
import { getLang } from './i18n';
import { RecoveryBoundary, showRecovery } from './ui/RecoveryBoundary';
import { installGlobalErrorHandlers, startWithNewDoc, takeSafeStart } from './io/recovery';
import './styles.css';

document.documentElement.lang = getLang();

// 描画の外（イベント処理・Promise）で起きた例外はトーストで知らせる。描画中の例外は RecoveryBoundary が受ける
installGlobalErrorHandlers();

// 文書の読み込みと並行して mermaid を読み込む
preloadMermaid();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RecoveryBoundary>
      <App />
    </RecoveryBoundary>
  </StrictMode>,
);

// 復旧画面の「開いていた図を開かずに起動」から読み込み直したときは、最後の図の代わりに新しい図を開く
const safeStart = takeSafeStart();

// OS から渡されたファイル（PWA のファイルの関連付け）は、起動処理より前に受け取りを始める。
// 起動時にファイルを渡されたら、起動処理は最初の図を開かない
let markReady!: () => void;
const ready = new Promise<void>((r) => (markReady = r));
const launched = watchLaunchFiles(ready);

void init({ skipInitialDoc: launched.then((l) => l || safeStart) }).then(
  async () => {
    if (safeStart && !(await launched)) await startWithNewDoc();
    startRenderPipeline();
    void startThumbnails();
    // 前に開いたフォルダを一覧に出す（§17.9）。失敗しても起動は止めない
    void loadFolders().catch(() => {});
    // 共有リンクの読み込みが失敗しても、渡されたファイルは開く
    markReady();
    await importFromLocationHash();
    watchShareLinks();
  },
  // 起動処理が失敗すると「読み込み中」のまま進まない（壊れた図を開こうとしたときなど）。復旧画面に切り替える
  (e: unknown) => showRecovery(e),
);
