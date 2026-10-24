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

void init().then(async () => {
  startRenderPipeline();
  void startThumbnails();
  await importFromLocationHash();
  watchShareLinks();
  watchLaunchFiles();
});
