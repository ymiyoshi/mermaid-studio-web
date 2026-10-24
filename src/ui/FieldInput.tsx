import { useEffect, useRef, useState } from 'react';
import type { ChangeSpec } from '@codemirror/state';
import { applyDiagramChange, useSession } from '../core/session';
import { t } from '../i18n';

// プロパティパネルと表の入力欄。
// 文字の入力は 1 打鍵ごとにテキストへ反映し、入力欄にフォーカスしている間の変更は履歴上 1 ステップにまとめる。
// 構文が壊れる値は反映を保留し、入力欄を赤くする（§6.2）。

export interface FieldSpec {
  type: 'text' | 'number' | 'select';
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
  const latest = useRef(field.value);
  const busy = useRef(false);
  const buildRef = useRef(build);
  buildRef.current = build;

  // フォーカスしていないときは、ソースの値に合わせる
  useEffect(() => {
    if (!focused.current) {
      setLocal(field.value);
      latest.current = field.value;
      setInvalid(false);
    }
  }, [field.value]);

  const sync = async () => {
    if (busy.current || composing.current) return;
    busy.current = true;
    try {
      let applied: string | null = null;
      while (latest.current !== applied) {
        const next: string = latest.current;
        applied = next;
        // 直前の反映で文書が変わっているので、毎回いまのソースから変更を作り直す
        const source = useSession.getState().current?.text.toString() ?? '';
        const spec = buildRef.current(source, next);
        if (!spec) {
          setInvalid(true);
          break;
        }
        const r = await applyDiagramChange(spec, { label: historyLabel, groupKey: `field:${session.current}` });
        setInvalid(r === 'invalid');
        if (r !== 'ok') break;
      }
    } finally {
      busy.current = false;
    }
  };

  const change = (v: string) => {
    setLocal(v);
    latest.current = v;
    if (!field.commitOnBlur || field.type === 'select') void sync();
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
      if (field.commitOnBlur && latest.current !== field.value) {
        void sync();
        return;
      }
      if (latest.current !== field.value && !invalid) return;
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
  return (
    <input
      {...common}
      type={field.type === 'number' ? 'number' : 'text'}
      value={local}
      placeholder={field.placeholder}
      readOnly={field.readonly}
      onChange={(e) => {
        if (composing.current) {
          setLocal(e.target.value);
          latest.current = e.target.value;
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
}
