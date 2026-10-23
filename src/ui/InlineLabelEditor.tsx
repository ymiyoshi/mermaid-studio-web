import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { applyDiagramChange } from '../core/session';
import type { SourceRange } from '../plugins/types';
import { t } from '../i18n';

// 設計書 §6.1: ラベルのインライン編集。
// 1 打鍵ごとにテキストへ反映し、編集セッション全体は履歴上 1 ステップにまとめる。
// IME の変換中は反映せず、変換確定の Enter では編集を終了しない。

export interface LabelSession {
  key: string;
  targetKey: string;
  range: SourceRange;
  original: string;
}

interface Props {
  session: LabelSession;
  anchor: Element | null;
  container: HTMLElement | null;
  renderTick: number;
  viewTick: unknown;
  onRangeChange(range: SourceRange): void;
  onClose(): void;
}

export function InlineLabelEditor({ session, anchor, container, renderTick, viewTick, onRangeChange, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(session.original);
  const [invalid, setInvalid] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const composing = useRef(false);
  // 反映済みの値と範囲。非同期の検証が重なっても最新の値だけを順番に反映する
  const committed = useRef({ value: session.original, range: session.range });
  const busy = useRef(false);
  const latest = useRef(session.original);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useLayoutEffect(() => {
    if (!anchor || !container) return;
    const a = anchor.getBoundingClientRect();
    const c = container.getBoundingClientRect();
    setRect({ left: a.left - c.left, top: a.top - c.top, width: a.width, height: a.height });
  }, [anchor, container, renderTick, viewTick]);

  const sync = async () => {
    if (busy.current || composing.current) return;
    busy.current = true;
    try {
      while (latest.current !== committed.current.value) {
        const next = latest.current;
        const { range } = committed.current;
        const r = await applyDiagramChange(
          { from: range.from, to: range.to, insert: next },
          {
            label: t('history.label', { text: next.length > 20 ? next.slice(0, 20) + '…' : next }),
            groupKey: `label:${session.key}`,
            selAfter: { anchor: range.from, head: range.from + next.length },
          },
        );
        if (r === 'ok') {
          committed.current = { value: next, range: { from: range.from, to: range.from + next.length } };
          onRangeChange(committed.current.range);
          setInvalid(false);
        } else {
          // 構文が壊れる値は反映を保留し、次の打鍵で再試行する
          setInvalid(r === 'invalid');
          break;
        }
      }
    } finally {
      busy.current = false;
    }
  };

  const onChange = (v: string) => {
    setValue(v);
    latest.current = v;
    void sync();
  };

  const finish = () => {
    onClose();
  };

  const style = rect
    ? {
        left: rect.left - 4,
        top: rect.top + rect.height / 2 - 16,
        width: Math.max(rect.width + 24, 120),
      }
    : { left: 16, top: 16, width: 200 };

  return (
    <div className="inline-label-editor" style={style}>
      <input
        ref={input}
        value={value}
        className={invalid ? 'invalid' : ''}
        aria-label={t('history.label', { text: session.original })}
        onChange={(e) => onChange(e.target.value)}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={(e) => {
          composing.current = false;
          onChange((e.target as HTMLInputElement).value);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault();
            finish();
          }
          e.stopPropagation();
        }}
        onBlur={finish}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {invalid && <div className="inline-label-hint">{t('label.invalid')}</div>}
    </div>
  );
}
