import { memo, useMemo, useState, type ReactNode } from 'react';
import { applyDiagramChange, revealRange, showToast, useSession } from '../core/session';
import { isPositional, refKey, type DiagramPlugin, type ElementRef, type PropertyField } from '../plugins/types';
import { composeEach } from '../plugins/source';
import { DIAGRAM_THEMES, THEME_COLORS, getFrontmatterValue, setFrontmatterValue } from '../plugins/frontmatter';
import { withValue } from '../plugins/types';
import { addRow, deleteRow, moveRow, setCell, tableRows, type TableDef, type TableRow } from '../plugins/table';
import { FieldInput } from './FieldInput';
import { t } from '../i18n';

// 設計書 §6.1: 選択した要素の属性をフォームで編集するパネルと、行を表で編集するタブ。

interface Props {
  plugin: DiagramPlugin;
  selected: ElementRef | null;
  /** 図で選択中の要素がソースのどこにあるか（表の行を強調する） */
  selectedFrom: number | null;
  /** まとめて編集する要素（2 つ以上選んだとき。それ以外は空） */
  multi?: ElementRef[];
  editable: boolean;
}

const KIND_LABEL: Record<string, string> = {
  node: t('misc.kind.node'),
  edge: t('misc.kind.edge'),
  participant: t('misc.kind.participant'),
  message: t('misc.kind.message'),
  class: t('misc.kind.class'),
  relation: t('misc.kind.relation'),
  state: t('misc.kind.state'),
  transition: t('misc.kind.transition'),
  entity: t('misc.kind.entity'),
  relationship: t('misc.kind.relationship'),
  topic: t('misc.kind.topic'),
  column: t('misc.kind.column'),
  card: t('misc.kind.card'),
  item: t('misc.kind.item'),
  note: t('misc.kind.note'),
  block: t('misc.kind.block'),
  'block-item': t('misc.kind.blockItem'),
  section: t('misc.kind.section'),
  subgraph: t('misc.kind.subgraph'),
  service: t('misc.kind.service'),
  group: t('misc.kind.group'),
  junction: t('misc.kind.junction'),
};

// 図ビューはパンやドラッグのたびに描き直されるので、props が変わらないときは描き直さない
const NONE: ElementRef[] = [];

export const PropertyPanel = memo(function PropertyPanel({ plugin, selected, selectedFrom, multi = NONE, editable }: Props) {
  const text = useSession((s) => s.current?.text);
  const source = useMemo(() => text?.toString() ?? '', [text]);
  const tables = plugin.tables ?? [];
  // 表で編集する図種は、表のタブを最初に開く（補助の表しか無い図種はプロパティのタブを開く）
  // 表もプロパティも無い図種（汎用フォールバック）は、テーマのタブを開く
  const [tab, setTab] = useState<string>(() => tables.find((x) => !x.secondary)?.id ?? (plugin.inspect ? 'props' : 'theme'));
  const activeTable = tables.find((x) => x.id === tab) ?? null;

  const fields = useMemo(() => plugin.inspect?.(source, selected) ?? [], [plugin, source, selected]);

  return (
    <div className="property-panel">
      <div className="panel-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'props'} className={tab === 'props' ? 'active' : ''} onClick={() => setTab('props')}>
          {t('panel.props')}
        </button>
        {tables.map((tb) => (
          <button key={tb.id} role="tab" aria-selected={tab === tb.id} className={tab === tb.id ? 'active' : ''} onClick={() => setTab(tb.id)}>
            {tb.title}
          </button>
        ))}
        <button role="tab" aria-selected={tab === 'theme'} className={tab === 'theme' ? 'active' : ''} onClick={() => setTab('theme')}>
          {t('theme.tab')}
        </button>
      </div>
      <div className="panel-body">
        {tab === 'theme' ? (
          <ThemeFields source={source} editable={editable} />
        ) : activeTable ? (
          <TableEditor table={activeTable} source={source} editable={editable} selectedFrom={selectedFrom} />
        ) : multi.length > 1 ? (
          <BulkFields plugin={plugin} source={source} refs={multi} editable={editable} />
        ) : (
          <>
            <div className="panel-heading">
              {selected ? `${KIND_LABEL[selected.kind] ?? selected.kind}: ${selected.id}` : t('panel.diagram')}
            </div>
            {fields.length === 0 ? (
              <p className="muted small">{selected ? t('panel.noFields') : t('panel.selectHint')}</p>
            ) : (
              <div className="prop-grid">
                {fields.map((f) => (
                  <PropRow key={`${selected?.kind}:${selected?.id}:${f.id}`} field={f}>
                    <FieldInput
                      field={f}
                      disabled={!editable}
                      historyLabel={t('history.prop', { name: f.label })}
                      build={(src, v) => plugin.setProperty?.(src, selected, f.id, v) ?? null}
                    />
                  </PropRow>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});

/**
 * プロパティの 1 行（欄の名前と入力欄）。
 * 形の欄はボタンを並べた一覧なので label で囲まない（label は、中の空いた所や欄の名前を押しても
 * 最初のボタン（一覧を開け閉めするボタン）を押したことにするので、一覧が勝手に閉じたり開き直したりする）
 */
function PropRow({ field, children }: { field: PropertyField; children: ReactNode }) {
  const Row = field.type === 'shape' ? 'div' : 'label';
  return (
    <Row className="prop-row">
      <span>{field.label}</span>
      {children}
    </Row>
  );
}

/**
 * まとめて編集: 選んだ要素に共通するプロパティ（同じ種類の要素の、ID 以外の項目）を並べる。
 * 値がそろっていなければ空で出し、変えるとすべての要素に当てる（履歴は 1 ステップ）
 */
/** まとめて編集で、値がそろっていない選択欄の印（どの選択肢の値とも重ならない） */
const MIXED = '\u0000mixed';

function BulkFields({ plugin, source, refs, editable }: { plugin: DiagramPlugin; source: string; refs: ElementRef[]; editable: boolean }) {
  const kinds = [...new Set(refs.map((r) => r.kind))];
  const fields = useMemo(() => {
    if (kinds.length !== 1 || !plugin.inspect) return [];
    const each = refs.map((r) => plugin.inspect!(source, r));
    return each[0]
      // ID や名前（確定したときに反映する欄）は、まとめて変えると全部が同じ名前になって 1 つにまとまるので出さない
      .filter((f) => !f.readonly && !f.commitOnBlur && f.id !== 'id' && f.id !== 'name' && each.every((fs) => fs.some((g) => g.id === f.id && g.type === f.type)))
      .map((f) => {
        const values = new Set(each.map((fs) => fs.find((g) => g.id === f.id)!.value));
        if (values.size === 1) return f;
        // 値がそろっていない。選択欄は「（いろいろ）」という選べない印を出す（'' は「なし」などの本当の値のことがある）
        // 形の一覧には印を並べず、どれも選ばれていない状態で「（いろいろ）」と出す
        if (f.type === 'shape') return { ...f, value: MIXED, placeholder: t('bulk.mixed') };
        return f.type === 'select'
          ? { ...f, value: MIXED, options: [{ value: MIXED, label: t('bulk.mixed') }, ...(f.options ?? [])] }
          : { ...f, value: '', placeholder: t('bulk.mixed') };
      });
  }, [plugin, source, refs, kinds.length]);
  const key = refs.map(refKey).join(',');

  return (
    <>
      <div className="panel-heading">{t('bulk.heading', { n: String(refs.length), kind: kinds.length === 1 ? (KIND_LABEL[kinds[0]] ?? kinds[0]) : t('bulk.mixedKinds') })}</div>
      {fields.length === 0 ? (
        <p className="muted small">{t(kinds.length === 1 ? 'bulk.noFields' : 'bulk.differentKinds')}</p>
      ) : (
        <div className="prop-grid">
          {fields.map((f) => (
            <PropRow key={`${key}:${f.id}`} field={f}>
              <FieldInput
                field={f}
                disabled={!editable}
                historyLabel={t('bulk.prop', { name: f.label, n: String(refs.length) })}
                build={(src, v) => (v === MIXED ? null : composeEach(src, refs, (s, r) => plugin.setProperty?.(s, r, f.id, v) ?? null, isPositional))}
              />
            </PropRow>
          ))}
        </div>
      )}
      <p className="muted small">{t('bulk.hint')}</p>
    </>
  );
}

const THEME_PATH = ['config', 'theme'];
const colorPath = (key: string) => ['config', 'themeVariables', key];

/**
 * テーマ: 図の先頭の設定（frontmatter の config.theme と config.themeVariables）を編集する。
 * 書き換えるのは frontmatter の対象の行だけ。図の本文には触れない
 */
function ThemeFields({ source, editable }: { source: string; editable: boolean }) {
  const theme = getFrontmatterValue(source, THEME_PATH);
  const clear = async (path: string[], label: string) => {
    const spec = setFrontmatterValue(source, path, '');
    if (spec) await applyDiagramChange(spec, { label: t('theme.cleared', { name: label }) });
  };
  return (
    <>
      <div className="panel-heading">{t('theme.heading')}</div>
      <div className="prop-grid">
        <label className="prop-row">
          <span>{t('theme.theme')}</span>
          <FieldInput
            field={{ type: 'select', label: t('theme.theme'), value: theme, options: [{ value: '', label: t('theme.appDefault') }, ...withValue(DIAGRAM_THEMES.map((x) => ({ value: x, label: x })), theme || 'default')] }}
            disabled={!editable}
            historyLabel={t('history.prop', { name: t('theme.theme') })}
            build={(src, v) => setFrontmatterValue(src, THEME_PATH, v)}
          />
        </label>
        {THEME_COLORS.map((c) => {
          const raw = getFrontmatterValue(source, colorPath(c.key));
          return (
            <label key={c.key} className="prop-row">
              <span>{c.label}</span>
              <span className="color-field">
                <FieldInput
                  field={{ type: 'color', label: c.label, value: raw, placeholder: t('theme.unset') }}
                  disabled={!editable}
                  historyLabel={t('history.prop', { name: c.label })}
                  build={(src, v) => setFrontmatterValue(src, colorPath(c.key), v)}
                />
                {raw && (
                  <button className="icon-btn" title={t('theme.clear')} disabled={!editable} onClick={() => void clear(colorPath(c.key), c.label)}>
                    ✕
                  </button>
                )}
              </span>
            </label>
          );
        })}
      </div>
      <p className="muted small">{t('theme.hint')}</p>
    </>
  );
}

function TableEditor({ table, source, editable, selectedFrom }: { table: TableDef; source: string; editable: boolean; selectedFrom: number | null }) {
  const rows = useMemo(() => tableRows(source, table), [source, table]);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const current = focusRow !== null ? rows.find((r) => r.line.index === focusRow) ?? null : null;

  const apply = async (spec: Parameters<typeof applyDiagramChange>[0], label: string) => {
    const r = await applyDiagramChange(spec, { label });
    if (r === 'invalid') showToast(t('action.invalid'));
  };

  const rowAt = (src: string, row: TableRow) => tableRows(src, table).find((r) => r.line.index === row.line.index && r.schema.kind === row.schema.kind) ?? null;

  return (
    <div className="table-editor">
      <div className="table-actions">
        {table.schemas.map((s) => (
          <button
            key={s.kind}
            className="btn"
            disabled={!editable}
            onClick={() => void apply(addRow(source, rows, s, current), t('table.addRow', { kind: s.title }))}
          >
            ＋ {s.title}
          </button>
        ))}
      </div>
      {rows.length === 0 && <p className="muted small">{t('table.empty')}</p>}
      <div className="table-rows">
        {rows.map((row, i) => {
          const hit = selectedFrom !== null && selectedFrom >= row.line.from && selectedFrom <= row.line.to;
          return (
            <div
              key={`${row.line.index}:${row.schema.kind}`}
              className={`table-row${hit ? ' hit' : ''}${focusRow === row.line.index ? ' focus' : ''}`}
              onFocus={() => setFocusRow(row.line.index)}
              onClick={() => revealRange(row.line.from, row.line.from)}
            >
              <span className="row-kind">{row.schema.title}</span>
              {row.schema.fields.map((f) => (
                <span key={f.name} className="row-cell" style={{ flex: f.width ?? 1 }}>
                  <FieldInput
                    field={{ ...f, value: row.values[f.name] ?? '', placeholder: f.optional ? t('misc.table.optional', { label: f.label }) : f.label }}
                    disabled={!editable}
                    historyLabel={t('table.setCell', { kind: row.schema.title, name: f.label })}
                    build={(src, v) => {
                      const r = rowAt(src, row);
                      return r ? setCell(r, f.name, v) : null;
                    }}
                  />
                </span>
              ))}
              <span className="row-ops">
                <button className="icon-btn" title={t('table.up')} disabled={!editable || i === 0} onClick={() => { const c = moveRow(rows, i, -1); if (c) void apply(c, t('table.move', { kind: row.schema.title })); }}>
                  ↑
                </button>
                <button className="icon-btn" title={t('table.down')} disabled={!editable || i === rows.length - 1} onClick={() => { const c = moveRow(rows, i, 1); if (c) void apply(c, t('table.move', { kind: row.schema.title })); }}>
                  ↓
                </button>
                <button className="icon-btn danger" title={t('table.delete')} disabled={!editable} onClick={() => void apply(deleteRow(source, row), t('table.deleteRow', { kind: row.schema.title }))}>
                  ✕
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
