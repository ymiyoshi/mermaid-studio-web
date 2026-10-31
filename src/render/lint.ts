import { isDefinition, nodeDefinition, nodeRefs, parseFlowchart } from '../plugins/flowchartSyntax';
import { nodeIds } from '../plugins/flowchartStructure';
import { parseSequence } from '../plugins/sequence';
import { removeLine } from '../plugins/lineOps';
import { bodyLines, isComment, type SourceLine } from '../plugins/source';
import type { ErrorFix } from './errorHelp';
import { t } from '../i18n';

// 構文は正しいが、怪しいところの警告（設計書 §17.5）。mermaid は黙って描くが、たいてい書き間違いであるもの。
// 直し方の案は対象の範囲だけを書き換える変更にし、画面で出す前に mermaid.parse を通るか確かめる（errorHelp と同じ）。

export interface LintWarning {
  from: number;
  to: number;
  /** warning: たいてい間違い / info: 意図したものかもしれない */
  severity: 'warning' | 'info';
  message: string;
  fixes: ErrorFix[];
}

const FLOW_TYPES = new Set(['flowchart-v2', 'flowchart', 'flowchart-elk', 'swimlane', 'agentflow']);

/** 大文字小文字を区別する編集距離（ID の打ち間違いを見つける）。隣どうしの入れ替え（Strat / Start）も 1 と数える */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const asFix = (label: string, spec: { from: number; to: number; insert?: string }): ErrorFix => ({
  label,
  spec: { from: spec.from, to: spec.to, insert: spec.insert ?? '' },
});

const lineRange = (line: SourceLine) => ({ from: line.from, to: line.to });

function lintFlowchart(source: string): LintWarning[] {
  const doc = parseFlowchart(source);
  const out: LintWarning[] = [];
  const ids = nodeIds(doc);
  const sgIds = new Set(doc.subgraphs.map((s) => s.id));
  const known = new Set([...ids, ...sgIds]);

  // 1 回しか出てこず、形もラベルも無いノードで、定義のあるノードと 1 文字違い → 打ち間違い
  const defined = ids.filter((id) => nodeDefinition(doc, id) !== null);
  for (const id of ids) {
    const refs = nodeRefs(doc, id);
    if (refs.length !== 1 || isDefinition(refs[0].ref) || id.length < 3) continue;
    // 数字だけが違う ID（Step1 と Step2）は、連番で付けた別のノードなので打ち間違いとしない
    const digitsOnly = (a: string, b: string) => a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#');
    const near = defined.find((d) => d !== id && d.length >= 3 && distance(id, d) === 1 && !digitsOnly(id, d));
    if (!near) continue;
    const r = refs[0].ref;
    out.push({
      from: r.from,
      to: r.idTo,
      severity: 'warning',
      message: t('lint.typoId', { id, near }),
      fixes: [asFix(t('lint.fixReplace', { from: id, to: near }), { from: r.from, to: r.idTo, insert: near })],
    });
  }

  // 使っていない classDef
  const used = new Set<string>();
  for (const c of doc.classes) used.add(c.name.value);
  for (const st of doc.statements) for (const g of st.groups) for (const r of g) if (r.cls) used.add(r.cls.value);
  for (const sg of doc.subgraphs) {
    const m = /:::([\w-]+)/.exec(source.slice(sg.line.from, sg.line.to));
    if (m) used.add(m[1]);
  }
  for (const cd of doc.classDefs) {
    // 「classDef a, b」のように区切りの後ろに空白があると、名前の欄が「a,」で切れ、b は props の側に入る。
    // どれを定義したのか確かでないので、空の名前があるときは警告しない（行を消す案で、使っている定義を消さないため）
    const names = cd.names.value.split(',').map((n) => n.trim());
    if (names.some((n) => n === '' || n === 'default' || used.has(n))) continue;
    out.push({
      ...lineRange(cd.line),
      severity: 'warning',
      message: t('lint.unusedClassDef', { name: cd.names.value }),
      fixes: [asFix(t('lint.fixRemoveLine'), removeLine(source, cd.line) as { from: number; to: number })],
    });
  }

  // 無いノードへの style・class
  for (const s of doc.styles) {
    if (known.has(s.id.value)) continue;
    out.push({
      from: s.id.from,
      to: s.id.to,
      severity: 'warning',
      message: t('lint.missingTarget', { id: s.id.value }),
      fixes: [asFix(t('lint.fixRemoveLine'), removeLine(source, s.line) as { from: number; to: number })],
    });
  }
  for (const c of doc.classes) {
    for (const x of c.ids) {
      const id = x.value.trim();
      if (known.has(id)) continue;
      out.push({ from: x.from, to: x.to, severity: 'warning', message: t('lint.missingTarget', { id }), fixes: [] });
    }
  }

  // どこにもつながっていないノード（図に 2 つ以上のノードがあり、サブグラフに入っていないもの）
  if (ids.length > 1) {
    const linked = new Set(doc.edges.flatMap((e) => [e.from, e.to]));
    for (const id of ids) {
      if (linked.has(id) || doc.connectors.some((c) => c.id === id)) continue;
      const inSubgraph = nodeRefs(doc, id).some(({ statement }) => doc.subgraphs.some((sg) => statement.line.index > sg.line.index && (!sg.end || statement.line.index < sg.end.index)));
      if (inSubgraph) continue;
      const r = nodeRefs(doc, id)[0]?.ref;
      if (!r) continue;
      out.push({ from: r.from, to: r.idTo, severity: 'info', message: t('lint.isolated', { id }), fixes: [] });
    }
  }
  return out;
}

const ACTIVATION = /^\s*(activate|deactivate)\s+([^\s:]+)/;

function lintSequence(source: string): LintWarning[] {
  const seq = parseSequence(source);
  const out: LintWarning[] = [];
  // 活性化が閉じていない参加者（+ / activate の数が - / deactivate より多い）
  const open = new Map<string, number>();
  const firstOpen = new Map<string, SourceLine>();
  const bump = (id: string, d: number, line: SourceLine) => {
    open.set(id, (open.get(id) ?? 0) + d);
    if (d > 0 && !firstOpen.has(id)) firstOpen.set(id, line);
  };
  for (const line of seq.body) {
    if (isComment(line.text)) continue;
    const a = ACTIVATION.exec(line.text);
    if (a) bump(a[2], a[1] === 'activate' ? 1 : -1, line);
    const m = seq.messages.find((x) => x.line === line);
    if (m?.act.value === '+') bump(m.to, 1, line);
    if (m?.act.value === '-') bump(m.from, -1, line);
  }
  const lastLine = bodyLines(source).body.at(-1);
  for (const [id, n] of open) {
    if (n <= 0) continue;
    const line = firstOpen.get(id)!;
    const indent = /^\s*/.exec(lastLine?.text ?? '')![0] || '    ';
    const at = lastLine?.to ?? source.length;
    out.push({
      ...lineRange(line),
      severity: 'warning',
      message: t('lint.openActivation', { id, n: String(n) }),
      fixes: [asFix(t('lint.fixDeactivate', { id }), { from: at, to: at, insert: Array.from({ length: n }, () => `\n${indent}deactivate ${id}`).join('') })],
    });
  }
  // 宣言しただけで、メッセージにも注釈にも出てこない参加者
  const usedIds = new Set<string>();
  for (const m of seq.messages) usedIds.add(m.from).add(m.to);
  for (const n of seq.notes) for (const p of n.parts.value.split(',')) usedIds.add(p.trim());
  for (const r of seq.refs) usedIds.add(r.id);
  for (const d of seq.decls) {
    if (usedIds.has(d.id)) continue;
    out.push({
      from: d.idRange.from,
      to: d.idRange.to,
      severity: 'info',
      message: t('lint.unusedParticipant', { id: d.id }),
      fixes: [asFix(t('lint.fixRemoveLine'), removeLine(source, d.line) as { from: number; to: number })],
    });
  }
  return out;
}

const GANTT_TAGS = new Set(['crit', 'done', 'active', 'milestone', 'vert']);
const GANTT_TASK = /^\s*[^:%]+?\s*:\s*(.+?)\s*$/;

function lintGantt(source: string): LintWarning[] {
  const out: LintWarning[] = [];
  const tasks: { line: SourceLine; parts: string[]; metaFrom: number }[] = [];
  for (const line of bodyLines(source).body) {
    if (isComment(line.text) || /^\s*(title|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|section)\b/.test(line.text)) continue;
    const m = GANTT_TASK.exec(line.text);
    if (!m) continue;
    tasks.push({ line, parts: m[1].split(',').map((p) => p.trim()), metaFrom: line.from + line.text.indexOf(m[1]) });
  }
  const ids = new Set<string>();
  for (const task of tasks) {
    const id = task.parts.find((p) => /^[A-Za-z_][\w-]*$/.test(p) && !GANTT_TAGS.has(p));
    if (id) ids.add(id);
  }
  for (const task of tasks) {
    for (const p of task.parts) {
      const m = /^(after|until)\s+(.+)$/.exec(p);
      if (!m) continue;
      for (const ref of m[2].split(/\s+/)) {
        if (ids.has(ref)) continue;
        const at = task.line.text.indexOf(ref, task.metaFrom - task.line.from);
        const from = task.line.from + (at < 0 ? 0 : at);
        out.push({ from, to: from + ref.length, severity: 'warning', message: t('lint.missingTask', { id: ref, kw: m[1] }), fixes: [] });
      }
    }
  }
  return out;
}

/** 図種に合わせて警告を集める（ソースの順） */
export function lintDiagram(source: string, diagramType: string | null): LintWarning[] {
  if (!diagramType) return [];
  let out: LintWarning[] = [];
  if (FLOW_TYPES.has(diagramType)) out = lintFlowchart(source);
  else if (diagramType === 'sequence') out = lintSequence(source);
  else if (diagramType === 'gantt') out = lintGantt(source);
  return out.sort((a, b) => a.from - b.from);
}
