import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { DiagramAction } from '../plugins/types';
import { shapeIcon } from './shapeIcons';
import { t } from '../i18n';

// 形を選んで追加できる操作（ツールバーのノードの追加、図の上の「次のノード」など）。
// ボタンを押すと既定の形で追加し、横の ▾ で形の一覧を開いて、選んだ形で追加する。
// 一覧の見た目はプロパティパネルの形の欄（FieldInput）とそろえる。
// 図の上では表示の外が切れるので、一覧は切れない向き（下か上）に出し、入らない分はスクロールにする

interface Props {
  action: DiagramAction & { shapes: { value: string; label: string }[] };
  disabled: boolean;
  run(shape?: string): void;
  /** ボタンの class（危険な操作の印など）と、説明（キーの割り当てなど） */
  className?: string;
  title?: string;
}

/** 一覧が切れる外枠（図の表示）。無ければ画面 */
const CLIP = '.diagram-viewport, .diagram-pane';
const MARGIN = 8;

export function ShapeActionButton({ action, disabled, run, className, title }: Props) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const paletteRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  /** 一覧を閉じたら、ここへフォーカスを戻す（押したボタンが消えて、フォーカスが迷子にならないように） */
  const toggleRef = useRef<HTMLButtonElement>(null);

  // 一覧の外を押したら閉じる
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // 図の上のツールバーは pointerdown を止めるので、捕捉の段階で受ける（隣の ▾ を押したときにも閉じるように）
    addEventListener('pointerdown', close, true);
    return () => removeEventListener('pointerdown', close, true);
  }, [open]);

  // 開いたら、外枠の中に入る向きと高さ・横のずれを決める（一覧の中身は変わらないので、開いたときだけ測る）
  useLayoutEffect(() => {
    const box = boxRef.current;
    const palette = paletteRef.current;
    if (!open || !box || !palette) return;
    const clip = box.closest(CLIP)?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
    const b = box.getBoundingClientRect();
    const below = clip.bottom - b.bottom - MARGIN;
    const above = b.top - clip.top - MARGIN;
    const up = palette.scrollHeight > below && above > below;
    const shift = Math.min(0, clip.right - MARGIN - (b.left + palette.offsetWidth));
    setPlace({
      ...(up ? { top: 'auto', bottom: 'calc(100% + 4px)' } : {}),
      maxHeight: Math.max(80, up ? above : below),
      left: Math.max(shift, clip.left + MARGIN - b.left),
    });
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
      <button className={`btn${className ? ` ${className}` : ''}`} disabled={disabled} title={title} onClick={() => run()}>
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
        onClick={() => {
          setPlace({});
          setOpen((v) => !v);
        }}
      >
        ▾
      </button>
      {open && !disabled && (
        <span ref={paletteRef} className="shape-palette shape-action-palette" style={place} role="group" aria-label={t('shape.palette')}>
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
