import { memo, useMemo, useState } from 'react';
import { applyDiagramChange, revealRange, showToast, useSession } from '../core/session';
import type { DiagramPlugin, ElementRef } from '../plugins/types';
import { addRow, deleteRow, moveRow, setCell, tableRows, type TableDef, type TableRow } from '../plugins/table';
import { FieldInput } from './FieldInput';
import { t } from '../i18n';

// 設計書 §6.1: 選択した要素の属性をフォームで編集するパネルと、行を表で編集するタブ。

interface Props {
  plugin: DiagramPlugin;
  selected: ElementRef | null;
  /** 図で選択中の要素がソースのどこにあるか（表の行を強調する） */
  selectedFrom: number | null;
  editable: boolean;
}

const KIND_LABEL: Record<string, string> = {
  node: 'ノード',
  edge: 'エッジ',
  participant: '参加者',
  message: 'メッセージ',
  class: 'クラス',
  relation: '関係',
  state: '状態',
  transition: '遷移',
  entity: 'エンティティ',
  relationship: 'リレーション',
  topic: 'トピック',
  column: '列',
  card: 'カード',
  item: '項目',
  note: '注釈',
  block: '枠',
  'block-item': 'ブロック',
  section: '区切り',
  subgraph: 'サブグラフ',
};

// 図ビューはパンやドラッグのたびに描き直されるので、props が変わらないときは描き直さない
export const PropertyPanel = memo(function PropertyPanel({ plugin, selected, selectedFrom, editable }: Props) {
  const text = useSession((s) => s.current?.text);
  const source = useMemo(() => text?.toString() ?? '', [text]);
  const tables = plugin.tables ?? [];
  // 表で編集する図種は、表のタブを最初に開く（補助の表しか無い図種はプロパティのタブを開く）
  const [tab, setTab] = useState<string>(() => tables.find((x) => !x.secondary)?.id ?? 'props');
  const activeTable = tables.find((x) => x.id === tab) ?? null;

  const fields = useMemo(() => plugin.inspect?.(source, selected) ?? [], [plugin, source, selected]);

  return (
    <div className="property-panel">
      <div className="panel-tabs" role="tablist">
        <button role="tab" aria-selected={!activeTable} className={!activeTable ? 'active' : ''} onClick={() => setTab('props')}>
          {t('panel.props')}
        </button>
        {tables.map((tb) => (
          <button key={tb.id} role="tab" aria-selected={tab === tb.id} className={tab === tb.id ? 'active' : ''} onClick={() => setTab(tb.id)}>
            {tb.title}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {activeTable ? (
          <TableEditor table={activeTable} source={source} editable={editable} selectedFrom={selectedFrom} />
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
                  <label key={`${selected?.kind}:${selected?.id}:${f.id}`} className="prop-row">
                    <span>{f.label}</span>
                    <FieldInput
                      field={f}
                      disabled={!editable}
                      historyLabel={t('history.prop', { name: f.label })}
                      build={(src, v) => plugin.setProperty?.(src, selected, f.id, v) ?? null}
                    />
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});

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
                    field={{ ...f, value: row.values[f.name] ?? '', placeholder: f.optional ? `${f.label}（省略可）` : f.label }}
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
