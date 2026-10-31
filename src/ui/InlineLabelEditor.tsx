import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { applyDiagramChange } from '../core/session';
import type { SourceRange } from '../plugins/types';
import { LatestValueApplier } from './latestApplier';
import { t } from '../i18n';

// 設計書 §6.1: ラベルのインライン編集。
// 1 打鍵ごとにテキストへ反映し、編集セッション全体は履歴上 1 ステップにまとめる。
// IME の変換中は反映せず、変換確定の Enter では編集を終了しない。

export interface LabelSession {
  key: string;
  targetKey: string;
  range: SourceRange;
  original: string;
  /**
   * ラベルが無い要素では、最初の反映で prefix + 値 + suffix を range.from に差し込む（A → A[値] など）。
   * それ以降は括弧の内側だけを書き換える
   */
  insert?: { prefix: string; suffix: string };
  /** 始めたときのカーソルの位置（vi の i は先頭、a は末尾）。clear は空にして始める（vi の cc / S）。省略時は全体を選ぶ */
  caret?: 'start' | 'end' | 'clear';
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
  const [value, setValue] = useState(session.caret === 'clear' ? '' : session.original);
  const [invalid, setInvalid] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const composing = useRef(false);
  // 反映済みのラベルの範囲。値を反映するたびに、新しい値の長さに合わせて伸び縮みする
  const committedRange = useRef(session.range);
  // ラベルを差し込む要素で、括弧ごと差し込み済みか
  const inserted = useRef(!session.insert);
  const onRangeChangeRef = useRef(onRangeChange);
  onRangeChangeRef.current = onRangeChange;
  const applier = useRef<LatestValueApplier | null>(null);
  applier.current ??= new LatestValueApplier(
    async (next) => {
      const range = committedRange.current;
      const wrap = session.insert;
      // 差し込む前は括弧ごと、差し込んだ後に空にしたら括弧ごと消す
      let spec = { from: range.from, to: range.to, insert: next };
      let inner = range.from;
      if (wrap && !inserted.current) {
        if (next === '') return true;
        spec = { from: range.from, to: range.from, insert: wrap.prefix + next + wrap.suffix };
        inner = range.from + wrap.prefix.length;
      } else if (wrap && next === '') {
        spec = { from: range.from - wrap.prefix.length, to: range.to + wrap.suffix.length, insert: '' };
        inner = spec.from;
      }
      const r = await applyDiagramChange(spec, {
        label: t('history.label', { text: next.length > 20 ? next.slice(0, 20) + '…' : next }),
        groupKey: `label:${session.key}`,
        selAfter: { anchor: inner, head: inner + next.length },
      });
      if (r === 'ok') {
        if (wrap) inserted.current = next !== '';
        committedRange.current = { from: inner, to: inner + next.length };
        onRangeChangeRef.current(committedRange.current);
        setInvalid(false);
        return true;
      }
      // 構文が壊れる値は反映を保留し、次の打鍵で再試行する
      setInvalid(r === 'invalid');
      return false;
    },
    session.original,
    () => composing.current,
  );

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // 空にして始めるときは、空のラベルを反映しておく（構文が壊れる空のラベルは、打ち始めるまで保留になる）
    if (session.caret === 'clear') void applier.current!.push('');
    if (session.caret === 'start') el.setSelectionRange(0, 0);
    else if (session.caret === 'end') el.setSelectionRange(el.value.length, el.value.length);
    else el.select();
  }, []);

  useLayoutEffect(() => {
    if (!anchor || !container) return;
    const a = anchor.getBoundingClientRect();
    const c = container.getBoundingClientRect();
    setRect({ left: a.left - c.left, top: a.top - c.top, width: a.width, height: a.height });
  }, [anchor, container, renderTick, viewTick]);

  const onChange = (v: string) => {
    setValue(v);
    void applier.current!.push(v);
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
