import { useEffect, useRef, useState } from 'react';
import type { DiagramAction } from '../plugins/types';
import { shapeIcon } from './shapeIcons';
import { t } from '../i18n';

// 形を選んで追加できるツールバーの操作（ノードの追加など）。
// ボタンを押すと既定の形で追加し、横の ▾ で形の一覧を開いて、選んだ形で追加する。
// 一覧の見た目はプロパティパネルの形の欄（FieldInput）とそろえる

interface Props {
  action: DiagramAction & { shapes: { value: string; label: string }[] };
  disabled: boolean;
  run(shape?: string): void;
}

export function ShapeActionButton({ action, disabled, run }: Props) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  /** 一覧を閉じたら、ここへフォーカスを戻す（押したボタンが消えて、フォーカスが迷子にならないように） */
  const toggleRef = useRef<HTMLButtonElement>(null);

  // 一覧の外を押したら閉じる
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener('pointerdown', close);
    return () => removeEventListener('pointerdown', close);
  }, [open]);

  // 編集できなくなったら閉じる（開いたままにすると、編集できるようになったときに勝手に開く）
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  /** 形を選んだら閉じて追加する。フォーカスは追加したノードのラベル編集へ移るので、ボタンには戻さない */
  const pick = (shape: string) => {
    setOpen(false);
    run(shape);
  };

  return (
    <span
      className="shape-action"
      ref={boxRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          toggleRef.current?.focus();
        }
      }}
    >
      <button className="btn" disabled={disabled} onClick={() => run()}>
        {action.title}
      </button>
      <button
        ref={toggleRef}
        type="button"
        className="btn shape-action-toggle"
        aria-label={t('shape.addWith', { title: action.title })}
        title={t('shape.addWith', { title: action.title })}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        ▾
      </button>
      {open && !disabled && (
        <span className="shape-palette shape-action-palette" role="group" aria-label={t('shape.palette')}>
          {action.shapes.map((o) => (
            <button key={o.value} type="button" className="shape-chip" title={o.label} aria-label={o.label} onClick={() => pick(o.value)}>
              {shapeIcon(o.value) ?? <span className="shape-chip-text">{o.label}</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
