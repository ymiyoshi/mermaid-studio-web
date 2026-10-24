import { useEffect, useMemo, useState } from 'react';
import { applyDiagramChange, showToast, useSession } from '../core/session';
import { validate, type ParseError } from '../render/mermaid';
import { applySpec } from '../plugins/source';
import { explainError, type ErrorFix } from '../render/errorHelp';
import { t } from '../i18n';

// 構文エラーの帯。日本語の説明と、押すと直る案を出す。原文は折りたたんで残す。

export function ErrorBanner({ error, hasSvg }: { error: ParseError; hasSvg: boolean }) {
  const text = useSession((s) => s.current?.text);
  const readOnly = useSession((s) => s.current?.readOnly ?? true);
  const source = useMemo(() => text?.toString() ?? '', [text]);
  const help = useMemo(() => explainError(source, error), [source, error]);
  // 直した結果が mermaid.parse を通る案だけを出す
  const [fixes, setFixes] = useState<ErrorFix[]>([]);
  useEffect(() => {
    let alive = true;
    setFixes([]);
    void Promise.all(help.fixes.map(async (f) => ((await validate(applySpec(source, f.spec))).ok ? f : null))).then((r) => {
      if (alive) setFixes(r.filter((f): f is ErrorFix => f !== null));
    });
    return () => {
      alive = false;
    };
  }, [help, source]);

  const apply = async (f: ErrorFix) => {
    const r = await applyDiagramChange(f.spec, { label: t('err.applied', { label: f.label }) });
    if (r === 'invalid') showToast(t('action.invalid'));
  };

  return (
    <div className="error-banner" role="alert">
      <strong>{hasSvg ? t('error.banner') : t('error.bannerNoSvg')}</strong>
      <p className="error-summary">{help.summary}</p>
      {fixes.length > 0 && !readOnly && (
        <div className="error-fixes">
          {fixes.map((f) => (
            <button key={f.label} className="btn primary" onClick={() => void apply(f)}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      <details>
        <summary>
          {t('error.original')}
          {error.line && <span>（{t('error.line', { line: String(error.line) })}）</span>}
        </summary>
        <pre>{error.message.split('\n').slice(0, 4).join('\n')}</pre>
      </details>
    </div>
  );
}
