import { useEffect, useRef, useState } from 'react';
import { refKey, sameRef, type DiagramPlugin, type DiagramTarget, type ElementRef } from '../plugins/types';
import { t } from '../i18n';
import { kindLabel } from './kindLabels';

// 図の要素の一覧（設計書 §17.4）。図の上の要素を、構造（親子）の木として並べ、絞り込んで選べるようにする。
// 大きな図で目当ての要素を探す・キーボードとスクリーンリーダーで図を扱うための入口。

export interface OutlineRow {
  key: string;
  target: DiagramTarget;
  depth: number;
  /** 表示する名前（線は「元 → 先」） */
  text: string;
  /** 絞り込みに合ったか（合った行の親は、合っていなくても出す） */
  hit: boolean;
}

const norm = (x: string) => x.normalize('NFKC').toLowerCase();

/**
 * 一覧の行を作る。親子は plugin.structure から、並びはソースの順（範囲の無い要素は図の順で後ろ）。
 * 線は、両端の名前で「元 → 先」と書く
 */
export function outlineRows(
  targets: DiagramTarget[],
  plugin: DiagramPlugin,
  source: string,
  keyOf: (x: DiagramTarget) => string,
  query: string,
): OutlineRow[] {
  const items = targets
    .map((x, i) => ({ x, at: x.range?.from ?? x.insertAt?.at ?? Number.MAX_SAFE_INTEGER - targets.length + i }))
    .filter(({ x }) => x.ref !== undefined || x.range !== null)
    .sort((a, b) => a.at - b.at)
    .map(({ x }) => x);
  const st = plugin.structure;
  const byRef = new Map(items.flatMap((x) => (x.ref ? [[refKey(x.ref), x] as const] : [])));
  const nameOf = (ref: ElementRef) => {
    const x = byRef.get(refKey(ref));
    return x?.label.trim() || ref.id;
  };
  const links = st?.links?.(source) ?? [];
  const textOf = (x: DiagramTarget) => {
    const link = x.ref && links.find((l) => l.edge && sameRef(l.edge, x.ref));
    const label = x.label.trim();
    if (link) return `${nameOf(link.from)} → ${nameOf(link.to)}${label ? ` : ${label}` : ''}`;
    return label || x.ref?.id || '';
  };
  const parentOf = new Map<DiagramTarget, DiagramTarget | null>();
  for (const x of items) {
    const p = x.ref && st ? st.parent(source, x.ref) : null;
    parentOf.set(x, (p && byRef.get(refKey(p))) || null);
  }
  const children = new Map<DiagramTarget | null, DiagramTarget[]>();
  for (const x of items) {
    let p = parentOf.get(x) ?? null;
    // 循環していたら一番外に置く
    for (let q = p, n = 0; q; q = parentOf.get(q) ?? null, n++) {
      if (q === x || n > 100) {
        p = null;
        break;
      }
    }
    const list = children.get(p) ?? [];
    list.push(x);
    children.set(p, list);
  }
  const q = norm(query.trim());
  const rows: OutlineRow[] = [];
  const walk = (parent: DiagramTarget | null, depth: number): boolean => {
    let any = false;
    for (const x of children.get(parent) ?? []) {
      const text = textOf(x);
      const hit = q === '' || norm(text).includes(q);
      const at = rows.length;
      rows.push({ key: keyOf(x), target: x, depth, text, hit });
      const inner = walk(x, depth + 1);
      // 自分も子孫も合わなければ出さない
      if (!hit && !inner) rows.length = at;
      else any = true;
    }
    return any;
  };
  walk(null, 0);
  return rows;
}

export function OutlinePanel({
  rows,
  selectedKeys,
  query,
  onQuery,
  onSelect,
}: {
  rows: OutlineRow[];
  selectedKeys: string[];
  query: string;
  onQuery(q: string): void;
  /** additive: Shift / Ctrl を押しながら（まとめて選ぶ） */
  onSelect(row: OutlineRow, additive: boolean): void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // 絞り込みは、IME の変換中は反映せず、確定してから反映する（AGENTS.md: IME を壊さない）
  const [draft, setDraft] = useState(query);
  const composing = useRef(false);
  useEffect(() => {
    if (!composing.current) setDraft(query);
  }, [query]);
  const shown = rows;
  const current = focusKey ?? selectedKeys[0] ?? null;

  // 選んだ要素の行を見えるところへ
  useEffect(() => {
    const k = selectedKeys[0];
    if (!k) return;
    list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedKeys]);

  const focusRow = (key: string) => {
    setFocusKey(key);
    list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, row: OutlineRow) => {
    const i = shown.indexOf(row);
    const go = (j: number) => {
      const r = shown[Math.max(0, Math.min(shown.length - 1, j))];
      if (r) {
        e.preventDefault();
        focusRow(r.key);
      }
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(shown.length - 1);
    else if (e.key === 'ArrowLeft') {
      // 親の行へ
      for (let j = i - 1; j >= 0; j--) if (shown[j].depth < row.depth) return go(j);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(row, e.shiftKey || e.ctrlKey || e.metaKey);
    }
  };

  return (
    <aside className="outline-panel" aria-label={t('outline.title')}>
      <input
        className="outline-search"
        type="search"
        value={draft}
        placeholder={t('outline.search')}
        aria-label={t('outline.search')}
        onChange={(e) => {
          setDraft(e.target.value);
          if (!composing.current && !(e.nativeEvent as InputEvent).isComposing) onQuery(e.target.value);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          onQuery(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          // 変換確定の Enter・↓ では動かない
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if ((e.key === 'ArrowDown' || e.key === 'Enter') && shown[0]) {
            e.preventDefault();
            if (e.key === 'Enter') onSelect(shown.find((r) => r.hit) ?? shown[0], false);
            else focusRow(shown[0].key);
          }
        }}
      />
      {shown.length === 0 ? (
        <p className="outline-empty">{query.trim() ? t('outline.noMatch') : t('outline.empty')}</p>
      ) : (
        <ul className="outline-list" role="tree" ref={list} aria-label={t('outline.title')} aria-multiselectable>
          {shown.map((r) => (
            <li
              key={r.key}
              data-key={r.key}
              role="treeitem"
              aria-level={r.depth + 1}
              aria-selected={selectedKeys.includes(r.key)}
              tabIndex={r.key === current || (current === null && r === shown[0]) ? 0 : -1}
              className={`outline-row${selectedKeys.includes(r.key) ? ' selected' : ''}${r.hit ? '' : ' context'}`}
              style={{ paddingLeft: 8 + r.depth * 14 }}
              title={r.text}
              onClick={(e) => {
                setFocusKey(r.key);
                onSelect(r, e.shiftKey || e.ctrlKey || e.metaKey);
              }}
              onKeyDown={(e) => onKeyDown(e, r)}
            >
              <span className="outline-kind">{r.target.ref ? kindLabel(r.target.ref.kind) : ''}</span>
              <span className="outline-text">{r.text || '—'}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
