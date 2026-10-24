import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { init } from './core/session';
import { startRenderPipeline } from './render/pipeline';
import { importFromLocationHash, watchShareLinks } from './io/shareActions';
import { startThumbnails } from './render/thumbs';
import { watchLaunchFiles } from './io/files';
import { preloadMermaid } from './render/mermaid';
import { getLang } from './i18n';
import './styles.css';

document.documentElement.lang = getLang();

// 文書の読み込みと並行して mermaid を読み込む
preloadMermaid();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// OS から渡されたファイル（PWA のファイルの関連付け）は、起動処理より前に受け取りを始める。
// 起動時にファイルを渡されたら、起動処理は最初の図を開かない
let markReady!: () => void;
const ready = new Promise<void>((r) => (markReady = r));
const launched = watchLaunchFiles(ready);

void init({ skipInitialDoc: launched }).then(async () => {
  startRenderPipeline();
  void startThumbnails();
  // 共有リンクの読み込みが失敗しても、渡されたファイルは開く
  markReady();
  await importFromLocationHash();
  watchShareLinks();
});
