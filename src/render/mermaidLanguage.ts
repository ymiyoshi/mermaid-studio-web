import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// エディタ用の簡易ハイライト。構文の正しさの判定は mermaid.parse に任せる。

const DIAGRAM_TYPES =
  /^(flowchart|graph|sequenceDiagram|classDiagram(-v2)?|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|mindmap|timeline|zenuml|sankey(-beta)?|xychart(-beta)?|block(-beta)?|packet(-beta)?|kanban|architecture(-beta)?|radar(-beta)?|treemap(-beta)?|usecase(-beta)?)\b/;

const KEYWORDS =
  /^(subgraph|end|direction|classDef|class|style|linkStyle|click|participant|actor|loop|alt|else|opt|par|and|critical|break|rect|note|over|left of|right of|activate|deactivate|autonumber|title|section|dateFormat|axisFormat|excludes|state|commit|branch|checkout|merge|cherry-pick|showData|accTitle|accDescr|TB|TD|BT|RL|LR)\b/;

const ARROWS = /^(<<?-{1,2}>>?|<?={2,}>?|<?-\.+->?|-{2,}[>xo]?|[xo<]?-{2,}|-{1,2}[>)x]{1,2}|\|{1,2}[o|]?-{2}[o|]?\|{0,2}|\}[o|]-{2}[o|]\{|\.\.>?|<\|--|--\|>|\*--|--\*|o--|--o)/;

export const mermaidLanguage = StreamLanguage.define<{ inFrontmatter: boolean; lineStart: boolean }>({
  name: 'mermaid',
  startState: () => ({ inFrontmatter: false, lineStart: true }),
  token(stream, state) {
    if (stream.sol()) state.lineStart = true;
    if (stream.sol() && stream.match(/^---\s*$/)) {
      state.inFrontmatter = !state.inFrontmatter;
      return 'meta';
    }
    if (state.inFrontmatter) {
      stream.skipToEnd();
      return 'meta';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('%%')) {
      stream.skipToEnd();
      return 'comment';
    }
    const atLineStart = state.lineStart;
    state.lineStart = false;
    if (stream.match(/^"[^"]*"?/)) return 'string';
    if (atLineStart && stream.match(DIAGRAM_TYPES)) return 'keyword';
    if (stream.match(KEYWORDS)) return 'keyword';
    if (stream.match(ARROWS)) return 'operator';
    if (stream.match(/^\|[^|]*\|/)) return 'string';
    if (stream.match(/^[[\](){}<>]+/)) return 'bracket';
    if (stream.match(/^-?\d+(\.\d+)?/)) return 'number';
    if (stream.match(/^:::?/)) return 'punctuation';
    if (stream.match(/^[\p{L}\p{N}_][\p{L}\p{N}_-]*/u)) return 'variableName';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '%%' } },
});

const style = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: tags.string, color: 'var(--syn-string)' },
  { tag: tags.operator, color: 'var(--syn-operator)' },
  { tag: tags.number, color: 'var(--syn-number)' },
  { tag: tags.meta, color: 'var(--syn-meta)' },
  { tag: tags.bracket, color: 'var(--syn-bracket)' },
  { tag: tags.variableName, color: 'var(--syn-name)' },
]);

export const mermaidHighlighting = syntaxHighlighting(style);
