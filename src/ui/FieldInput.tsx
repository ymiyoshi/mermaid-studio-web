import { useEffect, useRef, useState } from 'react';
import type { ChangeSpec } from '@codemirror/state';
import { applyDiagramChange, useSession } from '../core/session';
import { LatestValueApplier } from './latestApplier';
import { PALETTE, isCssColor, toHex } from './colors';
import { t } from '../i18n';

// プロパティパネルと表の入力欄。
// 文字の入力は 1 打鍵ごとにテキストへ反映し、入力欄にフォーカスしている間の変更は履歴上 1 ステップにまとめる。
// 構文が壊れる値は反映を保留し、入力欄を赤くする（§6.2）。
// 色の欄は、文字で打てる入力欄に、パレット（よく使う色・その他の色）を開くボタンを添える。

export interface FieldSpec {
  type: 'text' | 'number' | 'select' | 'color';
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
  const colorRef = useRef<HTMLSpanElement>(null);
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
      if (!colorRef.current?.contains(e.target as Node)) setPaletteOpen(false);
    };
    addEventListener('pointerdown', close);
    return () => removeEventListener('pointerdown', close);
  }, [paletteOpen]);

  const change = (v: string) => {
    setLocal(v);
    if (!field.commitOnBlur || field.type === 'select') void applier.current!.push(v);
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

  /** パレットで選んだ色。1 回選ぶごとに履歴 1 ステップにする */
  const pick = (v: string) => {
    session.current = crypto.randomUUID();
    change(v);
  };
  const off = disabled || field.readonly;
  return (
    <span
      className="color-input"
      ref={colorRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && paletteOpen) {
          e.stopPropagation();
          setPaletteOpen(false);
        }
      }}
    >
      {input}
      <button
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
              onClick={() => {
                pick(c);
                setPaletteOpen(false);
              }}
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
