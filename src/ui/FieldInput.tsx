import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ChangeSpec } from '@codemirror/state';
import { applyDiagramChange, useSession } from '../core/session';
import { LatestValueApplier } from './latestApplier';
import { PALETTE, isCssColor, toHex } from './colors';
import { shapeIcon } from './shapeIcons';
import { t } from '../i18n';

// プロパティパネルと表の入力欄。
// 文字の入力は 1 打鍵ごとにテキストへ反映し、入力欄にフォーカスしている間の変更は履歴上 1 ステップにまとめる。
// 構文が壊れる値は反映を保留し、入力欄を赤くする（§6.2）。
// 色の欄は、文字で打てる入力欄に、パレット（よく使う色・その他の色）を開くボタンを添える。
// 形の欄は、今の形を図形で示すボタンと、選択肢の図形を並べた一覧にする（選択欄では図形を出せないため）。

export interface FieldSpec {
  type: 'text' | 'number' | 'select' | 'color' | 'shape';
  value: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  readonly?: boolean;
  commitOnBlur?: boolean;
  label: string;
}

interface Props {
  field: FieldSpec;
  disabled: boolean;
  /** 現在のソースに対する、新しい値への変更。作れなければ null */
  build(source: string, value: string): ChangeSpec | null;
  /** 履歴に出す説明 */
  historyLabel: string;
  className?: string;
}

export function FieldInput({ field, disabled, build, historyLabel, className }: Props) {
  const [local, setLocal] = useState(field.value);
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  const composing = useRef(false);
  const session = useRef('');
  const buildRef = useRef(build);
  buildRef.current = build;
  const labelRef = useRef(historyLabel);
  labelRef.current = historyLabel;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const popupRef = useRef<HTMLSpanElement>(null);
  /** パレットを開くボタン。パレットを閉じたら、ここへフォーカスを戻す（選んだ・閉じたボタンが消えて、フォーカスが迷子にならないように） */
  const toggleRef = useRef<HTMLButtonElement>(null);
  const nameId = useId();
  const applier = useRef<LatestValueApplier | null>(null);
  applier.current ??= new LatestValueApplier(
    async (next) => {
      // 直前の反映で文書が変わっているので、毎回いまのソースから変更を作り直す
      const source = useSession.getState().current?.text.toString() ?? '';
      const spec = buildRef.current(source, next);
      if (!spec) {
        setInvalid(true);
        return false;
      }
      const r = await applyDiagramChange(spec, { label: labelRef.current, groupKey: `field:${session.current}` });
      setInvalid(r === 'invalid');
      return r === 'ok';
    },
    field.value,
    () => composing.current,
  );

  // フォーカスしていないときは、ソースの値に合わせる
  useEffect(() => {
    if (!focused.current) {
      setLocal(field.value);
      applier.current!.reset(field.value);
      setInvalid(false);
    }
  }, [field.value]);

  // パレットの外を押したら閉じる
  useEffect(() => {
    if (!paletteOpen) return;
    const close = (e: PointerEvent) => {
      if (!popupRef.current?.contains(e.target as Node)) setPaletteOpen(false);
    };
    addEventListener('pointerdown', close);
    return () => removeEventListener('pointerdown', close);
  }, [paletteOpen]);

  // 形の一覧は長いので、開いたらパネルの見える所まで送る。
  // パネルより長いときは、今の形のボタンが上端より上に隠れない所で止める（scrollIntoView の nearest は下端に合わせることがある）
  useEffect(() => {
    if (!paletteOpen || field.type !== 'shape' || !popupRef.current) return;
    const el = popupRef.current;
    let box = el.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (!box) return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop += r.top - b.top;
    else if (r.bottom > b.bottom) box.scrollTop += Math.min(r.bottom - b.bottom, r.top - b.top);
  }, [paletteOpen, field.type]);

  const off = disabled || field.readonly;
  // 編集できなくなったら閉じる（開いたままにすると、編集できるようになったときに勝手に開く）
  useEffect(() => {
    if (off) setPaletteOpen(false);
  }, [off]);

  const change = (v: string) => {
    setLocal(v);
    if (!field.commitOnBlur || field.type === 'select' || field.type === 'shape') void applier.current!.push(v);
  };

  const common = {
    'aria-label': field.label,
    disabled: disabled || field.readonly,
    className: `${className ?? ''}${invalid ? ' invalid' : ''}`,
    title: invalid ? t('label.invalid') : undefined,
    onFocus: () => {
      focused.current = true;
      session.current = crypto.randomUUID();
    },
    onBlur: () => {
      focused.current = false;
      if (field.commitOnBlur && local !== field.value) {
        void applier.current!.push(local);
        return;
      }
      if (local !== field.value && !invalid) return;
      setLocal(field.value);
      setInvalid(false);
    },
  };

  const closePalette = () => {
    setPaletteOpen(false);
    toggleRef.current?.focus();
  };
  /** パレットや形の一覧で選んだ値。1 回選ぶごとに履歴 1 ステップにして、パレットを閉じる */
  const pick = (v: string) => {
    closePalette();
    if (v === field.value) {
      // ソースの値に戻すだけ。反映できなかった値を選んだ後でも、表示と赤い印を元に戻す
      // （反映を待つ値と同じなので、push しても何も起きない）
      setLocal(v);
      applier.current!.reset(v);
      setInvalid(false);
      return;
    }
    session.current = crypto.randomUUID();
    change(v);
  };
  const closeOnEscape = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && paletteOpen) {
      e.stopPropagation();
      closePalette();
    }
  };

  if (field.type === 'shape') {
    const current = field.options?.find((o) => o.value === local);
    return (
      <span className={`shape-input ${className ?? ''}`} ref={popupRef} onKeyDown={closeOnEscape}>
        <button
          ref={toggleRef}
          type="button"
          className={`shape-current${invalid ? ' invalid' : ''}`}
          aria-label={field.label}
          // 名前は欄の名前（形）だけなので、今の形は説明として読み上げる
          aria-describedby={nameId}
          title={invalid ? t('label.invalid') : current?.label}
          aria-expanded={paletteOpen}
          disabled={off}
          onClick={() => setPaletteOpen((v) => !v)}
        >
          {current && shapeIcon(current.value)}
          <span className="shape-name" id={nameId}>
            {current?.label ?? field.placeholder ?? local}
          </span>
        </button>
        {paletteOpen && !off && (
          <span className="shape-palette" role="group" aria-label={t('shape.palette')}>
            {field.options?.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`shape-chip${o.value === local ? ' current' : ''}`}
                title={o.label}
                aria-label={o.label}
                aria-pressed={o.value === local}
                onClick={() => pick(o.value)}
              >
                {shapeIcon(o.value) ?? <span className="shape-chip-text">{o.label}</span>}
              </button>
            ))}
          </span>
        )}
      </span>
    );
  }
  if (field.type === 'select') {
    return (
      <select {...common} value={local} onChange={(e) => change(e.target.value)}>
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  const input = (
    <input
      {...common}
      type={field.type === 'number' ? 'number' : 'text'}
      value={local}
      placeholder={field.placeholder}
      readOnly={field.readonly}
      onChange={(e) => {
        if (composing.current) {
          // 変換中は値を覚えておくだけ（反映は確定してから）
          setLocal(e.target.value);
          return;
        }
        change(e.target.value);
      }}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={(e) => {
        composing.current = false;
        change((e.target as HTMLInputElement).value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur();
        e.stopPropagation();
      }}
    />
  );
  if (field.type !== 'color') return input;

  return (
    <span className="color-input" ref={popupRef} onKeyDown={closeOnEscape}>
      {input}
      <button
        ref={toggleRef}
        type="button"
        className={`color-swatch${isCssColor(local) ? '' : ' empty'}`}
        style={isCssColor(local) ? { background: local.trim() } : undefined}
        aria-label={t('color.palette')}
        title={t('color.palette')}
        aria-expanded={paletteOpen}
        disabled={off}
        onClick={() => setPaletteOpen((v) => !v)}
      />
      {paletteOpen && !off && (
        <span className="color-palette" role="group" aria-label={t('color.palette')}>
          {PALETTE.flat().map((c) => (
            <button
              key={c}
              type="button"
              className={`color-chip${toHex(local) === c ? ' current' : ''}`}
              style={{ background: c }}
              title={c}
              aria-label={c}
              aria-pressed={toHex(local) === c}
              onClick={() => pick(c)}
            />
          ))}
          {/* 外側の行が label なので、ここは label にしない（label の入れ子は不正） */}
          <span className="color-custom">
            <input
              type="color"
              aria-label={t('color.custom')}
              value={toHex(local) ?? '#000000'}
              // 色を選ぶ画面を開いている間（つまみを動かしている間）の変更は、履歴 1 ステップにまとめる
              onFocus={() => (session.current = crypto.randomUUID())}
              onChange={(e) => change(e.target.value)}
            />
            <span aria-hidden="true">{t('color.custom')}</span>
          </span>
        </span>
      )}
    </span>
  );
}
