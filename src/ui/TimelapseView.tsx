import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryTree } from '../core/history';
import { renderSvg } from '../render/mermaid';
import { recordGif, recordTimelapse, videoSupported } from '../io/timelapseVideo';
import { download, safeFileName } from '../io/download';
import { showToast, useSession } from '../core/session';
import { useLayout } from './layoutStore';
import { pathToHead, sampleFrames } from './timelapse';
import { t } from '../i18n';

// タイムラプス: 最初の版から今の版までを順に描いて、図ができていく様子を再生する。WebM の動画と GIF にも書き出せる。

/** 再生する版の上限（長い履歴は間引く） */
const MAX_FRAMES = 150;
const SPEEDS = [
  { ms: 1000, label: '0.5x' },
  { ms: 500, label: '1x' },
  { ms: 250, label: '2x' },
  { ms: 120, label: '4x' },
];

export function TimelapseView({ tree, title, onClose }: { tree: HistoryTree; title: string; onClose(): void }) {
  const frames = useMemo(() => sampleFrames(pathToHead(tree), MAX_FRAMES), [tree]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(frames.length > 1);
  const [speed, setSpeed] = useState(500);
  const [svg, setSvg] = useState<string | null>(null);
  const [recording, setRecording] = useState<{ done: number; abort: AbortController; format: 'webm' | 'gif' } | null>(null);
  const node = tree.nodes.get(frames[index])!;
  const text = useMemo(() => tree.textAt(frames[index]), [tree, frames, index]);

  // 描けない版（構文エラーの途中）は、直前の図を残す
  useEffect(() => {
    let alive = true;
    if (text.trim() === '') setSvg(null);
    else
      void renderSvg(text).then((r) => {
        if (alive && r.ok) setSvg(r.svg);
      });
    return () => {
      alive = false;
    };
  }, [text]);

  // 再生: 描き終わるのを待たずに一定の間隔で進める（mermaid の描画は直列なので追い越さない）
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setIndex((i) => {
        if (i >= frames.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, speed);
    return () => clearInterval(id);
  }, [playing, speed, frames.length]);

  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  // 閉じる以外の理由（図の切り替えなど）で画面が消えても、書き出しを止める（止めないと、あとでダウンロードが始まる）
  useEffect(() => () => recordingRef.current?.abort.abort(), []);
  const close = () => {
    recordingRef.current?.abort.abort();
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const exportVideo = async (format: 'webm' | 'gif') => {
    const abort = new AbortController();
    setPlaying(false);
    setRecording({ done: 0, abort, format });
    const blob = await (format === 'gif' ? recordGif : recordTimelapse)(
      frames.map((id) => {
        const n = tree.nodes.get(id)!;
        return { text: tree.textAt(id), caption: n.name ? `🔖 ${n.name}` : n.label };
      }),
      { frameMs: speed, signal: abort.signal, onProgress: (done) => setRecording((r) => (r ? { ...r, done } : r)) },
    ).catch((e: unknown) => {
      showToast(t('file.error', { message: String((e as Error)?.message ?? e) }));
      return null;
    });
    setRecording(null);
    if (blob) download(blob, `${safeFileName(title)}-${t('timelapse.fileSuffix')}.${format}`);
  };

  return (
    <div className="modal-backdrop compare-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal compare-view timelapse-view" role="dialog" aria-modal="true" aria-label={t('timelapse.title')}>
        <div className="compare-head">
          <h2>{t('timelapse.title')}</h2>
          <button className="btn" onClick={() => (index >= frames.length - 1 && setIndex(0), setPlaying((p) => !p))} disabled={!!recording || frames.length < 2}>
            {playing ? t('timelapse.pause') : t('timelapse.play')}
          </button>
          <label className="compare-pick">
            <span>{t('timelapse.speed')}</span>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={!!recording}>
              {SPEEDS.map((s) => (
                <option key={s.ms} value={s.ms}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          {videoSupported() && (!recording || recording.format === 'webm') && (
            <button className="btn" onClick={() => (recording ? recording.abort.abort() : void exportVideo('webm'))}>
              {recording ? t('timelapse.cancelVideo', { done: String(recording.done), total: String(frames.length) }) : t('timelapse.video')}
            </button>
          )}
          {(!recording || recording.format === 'gif') && (
            <button className="btn" onClick={() => (recording ? recording.abort.abort() : void exportVideo('gif'))}>
              {recording ? t('timelapse.cancelVideo', { done: String(recording.done), total: String(frames.length) }) : t('timelapse.gif')}
            </button>
          )}
          <button className="btn" onClick={close}>
            {t('compare.close')}
          </button>
        </div>
        <div className="timelapse-bar">
          <input
            type="range"
            min={0}
            max={frames.length - 1}
            value={index}
            aria-label={t('timelapse.position')}
            onChange={(e) => (setPlaying(false), setIndex(Number(e.target.value)))}
            disabled={!!recording}
          />
          <span className="small timelapse-step" role="status">
            {index + 1} / {frames.length} ・ {node.name ? `🔖 ${node.name}` : node.label}
          </span>
        </div>
        <div className="compare-side timelapse-stage">
          {/* mermaid が strict で描いた SVG。差し込むのは図ビューと同じ扱い */}
          <div className="compare-canvas" dangerouslySetInnerHTML={{ __html: svg ?? '' }} />
        </div>
        {frames.length < pathToHead(tree).length && (
          <p className="muted small">{t('timelapse.sampled', { n: String(frames.length), total: String(pathToHead(tree).length) })}</p>
        )}
      </div>
    </div>
  );
}

/** App が出すタイムラプス。開いている図の履歴を使い、図を切り替えたら閉じる */
export function TimelapseHost() {
  const current = useSession((s) => s.current);
  const docId = current?.id;
  const opened = useRef(docId);
  const close = () => useLayout.setState({ timelapseOpen: false });
  useEffect(() => {
    if (docId !== opened.current) close();
  }, [docId]);
  if (!current || docId !== opened.current) return null;
  return <TimelapseView tree={current.tree} title={current.title} onClose={close} />;
}