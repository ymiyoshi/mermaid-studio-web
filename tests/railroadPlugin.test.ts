// @vitest-environment jsdom
// railroad（構文図）のプラグイン。4 つの書き方（関数形式・EBNF・ABNF・PEG）で、図からの操作の結果が mermaid.parse を通ること、
// 対象の範囲以外（コメント・空行・他の規則）が変わらないことを確かめる
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import fixtures from './fixtures/rendered-svg.json';
import { parseRailroad, railroadPlugin } from '../src/plugins/railroad';
import { pluginFor } from '../src/plugins/registry';
import { validate } from '../src/render/mermaid';
import type { DiagramTarget, ElementRef } from '../src/plugins/types';

const all = fixtures as Record<string, { source: string; svg: string }>;
const EBNF = all['railroad'].source;
const CALL = all['railroad-call'].source;
const ABNF = all['railroad-abnf'].source;
const PEG = all['railroad-peg'].source;

const applyRaw = (source: string, change: ChangeSpec) => ChangeSet.of(change, source.length).apply(Text.of(source.split('\n'))).toString();

/** 変更を当て、mermaid.parse を通ることを確かめる */
async function apply(source: string, change: ChangeSpec | null | undefined) {
  expect(change).toBeTruthy();
  const out = applyRaw(source, change!);
  const r = await validate(out);
  expect(r.ok, `通らない: ${out}`).toBe(true);
  return out;
}

const run = (id: string, source: string, refs: ElementRef[] = []) => railroadPlugin.actions!.find((a) => a.id === id)!.run(source, refs);
const prop = (source: string, ref: ElementRef | null, field: string, value: string) => railroadPlugin.setProperty!(source, ref, field, value);
const field = (source: string, ref: ElementRef | null, id: string) => railroadPlugin.inspect!(source, ref).find((f) => f.id === id);
const rule = (id: string): ElementRef => ({ kind: 'rule', id });
const term = (id: string): ElementRef => ({ kind: 'term', id });

function load(id: string): { source: string; targets: DiagramTarget[] } {
  const f = all[id];
  document.body.innerHTML = `<div>${f.svg}</div>`;
  return { source: f.source, targets: railroadPlugin.mapTargets(document.querySelector('svg')!, f.source) };
}
const at = (source: string, x: DiagramTarget) => source.slice(x.range!.from, x.range!.to);
const leafText = (source: string, ruleIndex: number) =>
  parseRailroad(source)!.rules[ruleIndex].leaves.map((l) => `${l.cls}:${l.value}${l.range ? '' : '(-)'}`);

describe('規則と記号を読む', () => {
  it('EBNF: 複数行にわたる規則・コメント・::=・除外（-）を読む', () => {
    const src = 'railroad-ebnf-beta\ntitle "文法"\n%% コメント\nexpr ::= term\n  , { ("+" | "-") term } (* 和 *) ;\nterm = ? 数字 ? - "0" | id ; id = "a;b" ;\n';
    const doc = parseRailroad(src)!;
    expect(doc.dialect).toBe('ebnf');
    expect(doc.rules.map((r) => r.name.text)).toEqual(['expr', 'term', 'id']);
    expect(src.slice(doc.rules[0].def.from, doc.rules[0].def.to)).toBe('term\n  , { ("+" | "-") term } (* 和 *)');
    expect(leafText(src, 0)).toEqual(['nonterminal:term', 'terminal:+', 'terminal:-', 'nonterminal:term']);
    // a - b は「a、- という終端、b」として描かれる（真ん中の - はソースに無い）
    expect(leafText(src, 1)).toEqual(['special:数字', 'terminal:-(-)', 'terminal:0', 'nonterminal:id']);
    // 文字列の中の ; は規則の終わりではない
    expect(src.slice(doc.rules[2].span.from, doc.rules[2].span.to)).toBe('id = "a;b" ;');
  });

  it('EBNF: ? … ? の特殊は、後置の ? より優先される（mermaid の字句と同じ）', () => {
    expect(leafText('railroad-ebnf-beta\nr = a? b? ;', 0)).toEqual(['nonterminal:a', 'special:b']);
  });

  it('ABNF: ; は直後が改行なら規則の終わり、それ以外は行末までのコメント', () => {
    const src = 'railroad-abnf-beta\nr = "a" ; 説明\n  / 2*3b ;\nDIGIT = %x30-39;\n';
    const doc = parseRailroad(src)!;
    expect(doc.rules.map((r) => r.name.text)).toEqual(['r', 'DIGIT']);
    expect(leafText(src, 0)).toEqual(['terminal:a', 'nonterminal:b']);
    expect(leafText(src, 1)).toEqual(['terminal:%x30-39']);
  });

  it('PEG: !x・&x・. は 1 つの特殊の箱になり、中身の箱は描かれない', () => {
    const src = 'railroad-peg-beta\nR <- !"a" &(B C) . D* # コメント\n;\n';
    expect(leafText(src, 0)).toEqual(['special:!"a"(-)', 'special:&(...)(-)', 'special:.(-)', 'nonterminal:D']);
  });

  it('railroad-beta: terminal・nonterminal・special の引数を、エスケープを読んで値にする', () => {
    const src = 'railroad-beta\nr = sequence(terminal("a\\"b"), nonterminal(\'x\'), zeroOrMore(special("s"))) /* c */;\n';
    expect(leafText(src, 0)).toEqual(['terminal:a"b', 'nonterminal:x', 'special:s']);
    const l = parseRailroad(src)!.rules[0].leaves[0];
    expect(src.slice(l.range!.from, l.range!.to)).toBe('a\\"b');
  });

  it('railroad の宣言でなければ読まない', () => {
    expect(parseRailroad('flowchart TD\n  A --> B')).toBeNull();
  });
});

describe('SVG との対応付け', () => {
  it('登録した 4 つの図種で使われる', () => {
    for (const type of ['railroad', 'railroadEbnf', 'railroadAbnf', 'railroadPeg']) expect(pluginFor(type)).toBe(railroadPlugin);
  });

  it('EBNF: 規則を名前で、箱を種類と文字で対応付ける（同じ文字の箱は出てくる順）', () => {
    const { source, targets } = load('railroad');
    const rules = targets.filter((x) => x.ref?.kind === 'rule');
    expect(rules.map((x) => x.ref!.id)).toEqual(['number', 'digit']);
    // 図の文字は「number =」だが、ラベルは名前だけ。
    // 名前はほかの規則から参照されるので、図の上では書き換えない（名前の変更はプロパティパネルで、参照もまとめて変える）
    expect(rules.map((x) => [x.label, x.range])).toEqual([
      ['number', null],
      ['digit', null],
    ]);
    const terms = targets.filter((x) => x.ref?.kind === 'term');
    expect(terms.map((x) => x.ref!.id)).toEqual(['0:0', '0:1', '0:2', ...Array.from({ length: 10 }, (_, k) => `1:${k}`)]);
    for (const x of terms) expect(at(source, x)).toBe(x.label);
    // 2 つ目の digit は、ソースの 2 つ目の digit を指す
    const second = terms.find((x) => x.ref!.id === '0:2')!;
    expect(second.range!.from).toBe(source.indexOf('{ digit }') + 2);
  });

  it('railroad-beta・ABNF・PEG も、箱を引用符の内側・名前に対応付ける', () => {
    let { source, targets } = load('railroad-call');
    const special = targets.find((x) => x.ref?.id === '1:2')!;
    expect(special.label).toBe('any digit');
    expect(at(source, special)).toBe('any digit');
    expect(at(source, targets.find((x) => x.ref?.id === '0:1')!)).toBe('digit');

    ({ source, targets } = load('railroad-abnf'));
    expect(targets.filter((x) => x.ref?.kind === 'rule').map((x) => x.ref!.id)).toEqual(['number', 'DIGIT']);
    expect(at(source, targets.find((x) => x.ref?.id === '1:0')!)).toBe('%x30-39');

    ({ source, targets } = load('railroad-peg'));
    const terms = targets.filter((x) => x.ref?.kind === 'term').map((x) => at(source, x));
    expect(terms).toEqual(['Term', '+', '-', 'Term', '0', '1']);
  });

  it('同じ名前の規則は 2 回描かれ、2 つ目は「名前#2」で指す', () => {
    const src = 'railroad-ebnf-beta\nr = "a" ;\nr = "b" ;\n';
    const g = (text: string, name: string) =>
      `<g class="railroad-rule"><g><g class="railroad-terminal"><rect></rect><text>${text}</text></g></g><g class="railroad-rule-name-group"><text class="railroad-rule-name">${name} =</text></g></g>`;
    document.body.innerHTML = `<svg class="railroad-diagram">${g('a', 'r')}${g('b', 'r')}</svg>`;
    const targets = railroadPlugin.mapTargets(document.querySelector('svg')!, src);
    expect(targets.filter((x) => x.ref).map((x) => `${x.ref!.kind}:${x.ref!.id}:${x.range ? at(src, x) : x.label}`)).toEqual(['rule:r:r', 'term:0:0:a', 'rule:r#2:r', 'term:1:0:b']);
  });
});

describe('図からの操作', () => {
  it('規則を足す（書き方ごとに正しい既定の定義で、名前は ASCII で重ならない）', async () => {
    expect(await apply(EBNF, run('add-rule', EBNF)!.change)).toBe(EBNF.replace(/\n$/, '\nrule1 = "a" ;\n'));
    expect(await apply(CALL, run('add-rule', CALL)!.change)).toBe(`${CALL}\nrule1 = terminal("a");`);
    expect(await apply(ABNF, run('add-rule', ABNF)!.change)).toBe(`${ABNF}\nrule1 = "a";`);
    expect(await apply(PEG, run('add-rule', PEG)!.change)).toBe(`${PEG}\nRule1 <- "a";`);
    const res = run('add-rule', EBNF)!;
    expect(res.select).toEqual(rule('rule1'));
    // ::= で書いた文法では ::= を使う。規則・参照に使われている名前は避ける
    const src = 'railroad-ebnf-beta\nrule1 ::= rule2 ;';
    expect(await apply(src, run('add-rule', src)!.change)).toBe('railroad-ebnf-beta\nrule1 ::= rule2 ;\nrule3 ::= "a" ;');
  });

  it('規則が無い図では、title などの後ろに足す', async () => {
    for (const header of ['railroad-beta', 'railroad-ebnf-beta', 'railroad-abnf-beta', 'railroad-peg-beta']) {
      const src = `${header}\n    title 文法\n`;
      const out = await apply(src, run('add-rule', src)!.change);
      expect(out.startsWith(`${header}\n    title 文法\n    `)).toBe(true);
      // 規則をすべて消した図も、構文として正しい
      const doc = parseRailroad(out)!;
      expect(await apply(out, run('delete', out, [rule(doc.rules[0].id)])!.change)).toBe(src);
    }
  });

  it('次の規則（Tab）は、選んだ規則の直後に足す', async () => {
    let out = await apply(EBNF, run('add-next', EBNF, [rule('number')])!.change);
    expect(out).toBe('railroad-ebnf-beta\nnumber = [ "-" ] , digit , { digit } ;\nrule1 = "a" ;\ndigit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" ;\n');
    // 箱を選んでいるときは、その箱のある規則の後ろ
    out = await apply(PEG, run('add-next', PEG, [term('0:0')])!.change);
    expect(out).toBe('railroad-peg-beta\nExpr <- Term (("+" / "-") Term)*;\nRule1 <- "a";\nTerm <- "0" / "1";');
    // 1 行に複数の規則があれば、; の直後に続けて書く
    const src = 'railroad-ebnf-beta\na = "x" ; b = a ; (* メモ *)\n';
    expect(await apply(src, run('add-next', src, [rule('a')])!.change)).toBe('railroad-ebnf-beta\na = "x" ; rule1 = "a" ; b = a ; (* メモ *)\n');
    // 後ろのコメントが次の行まで続くなら、その後ろの行に
    const src2 = 'railroad-ebnf-beta\na = "x" ; (* 続く\n  コメント *)\nb = a ;\n';
    expect(await apply(src2, run('add-next', src2, [rule('a')])!.change)).toBe('railroad-ebnf-beta\na = "x" ; (* 続く\n  コメント *)\nrule1 = "a" ;\nb = a ;\n');
    // ABNF は ; の後ろを改行にする（同じ行に書くとコメントになる）
    out = await apply(ABNF, run('add-next', ABNF, [rule('number')])!.change);
    expect(out).toBe('railroad-abnf-beta\nnumber = [ "-" ] 1*DIGIT;\nrule1 = "a";\nDIGIT = %x30-39;');
  });

  it('規則を上下に動かす（規則の文だけを入れ替え、間のコメント・空行は残す）', async () => {
    const src = 'railroad-ebnf-beta\n  a = "x"\n    | "y" ;\n\n  %% メモ\n  b = a ;\n';
    const res = run('move-down', src, [rule('a')])!;
    expect(await apply(src, res.change)).toBe('railroad-ebnf-beta\n  b = a ;\n\n  %% メモ\n  a = "x"\n    | "y" ;\n');
    expect(res.select).toEqual(rule('a'));
    expect(run('move-up', src, [rule('a')])).toBeNull();
    expect(run('move-down', src, [rule('b')])).toBeNull();
    for (const s of [CALL, ABNF, PEG]) {
      const doc = parseRailroad(s)!;
      const out = await apply(s, run('move-up', s, [rule(doc.rules[1].id)])!.change);
      expect(parseRailroad(out)!.rules.map((r) => r.name.text)).toEqual([doc.rules[1].name.text, doc.rules[0].name.text]);
    }
  });

  it('同じ名前の規則を動かすと、選択は動かした規則を指し続ける', () => {
    const src = 'railroad-ebnf-beta\nr = "a" ;\ns = "b" ;\nr = "c" ;\n';
    expect(run('move-up', src, [rule('r#2')])!.select).toEqual(rule('r#2'));
    const res = run('move-up', applyRaw(src, run('move-up', src, [rule('r#2')])!.change), [rule('r#2')])!;
    expect(res.select).toEqual(rule('r'));
  });

  it('ドラッグで並べ替える', async () => {
    const src = 'railroad-peg-beta\nA <- "a";\nB <- "b";\nC <- "c";\n';
    const r = railroadPlugin.reorder!;
    expect(r.axis(src, rule('A'))).toBe('y');
    expect(r.accepts!(rule('A'), term('0:0'), src)).toBe(false);
    const out = await apply(src, r.move!(src, rule('C'), rule('A'), true)!.change);
    expect(out).toBe('railroad-peg-beta\nC <- "c";\nA <- "a";\nB <- "b";\n');
    expect(r.move!(src, rule('A'), rule('B'), true)).toBeNull();
  });

  it('規則を消す（規則だけの行は行ごと、同じ行に他の規則があればその部分だけ）', async () => {
    expect(await apply(EBNF, run('delete', EBNF, [rule('number')])!.change)).toBe('railroad-ebnf-beta\ndigit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" ;\n');
    expect(await apply(ABNF, run('delete', ABNF, [rule('DIGIT')])!.change)).toBe('railroad-abnf-beta\nnumber = [ "-" ] 1*DIGIT;');
    const src = 'railroad-ebnf-beta\n  a = "x" ; b = a ;\n  c = "z"\n    | b ; (* c の説明 *)\n%% 最後\n';
    expect(await apply(src, run('delete', src, [rule('a')])!.change)).toBe('railroad-ebnf-beta\n  b = a ;\n  c = "z"\n    | b ; (* c の説明 *)\n%% 最後\n');
    expect(await apply(src, run('delete', src, [rule('b')])!.change)).toBe('railroad-ebnf-beta\n  a = "x" ;\n  c = "z"\n    | b ; (* c の説明 *)\n%% 最後\n');
    expect(await apply(src, run('delete', src, [rule('c')])!.change)).toBe('railroad-ebnf-beta\n  a = "x" ; b = a ;\n%% 最後\n');
  });
});

describe('プロパティ', () => {
  it('図全体: タイトル（宣言の次の行に足し、あれば書き換える）', async () => {
    for (const s of [EBNF, CALL, ABNF, PEG]) {
      const out = await apply(s, prop(s, null, 'title', '数の文法'));
      expect(out.split('\n')[1]).toBe('title "数の文法"');
      expect(field(out, null, 'title')!.value).toBe('数の文法');
      expect(await apply(out, prop(out, null, 'title', ''))).toBe(s);
    }
  });

  it('規則の名前を変えると、他の規則からの参照も変わる（コメント・文字列の中は変えない）', async () => {
    const src = 'railroad-ebnf-beta\nnumber = digit , { digit } , "digit" ; (* digit *)\ndigit = "0" | digit-x ;\n';
    expect(field(src, rule('digit'), 'name')).toMatchObject({ value: 'digit', commitOnBlur: true });
    expect(await apply(src, prop(src, rule('digit'), 'name', 'd'))).toBe('railroad-ebnf-beta\nnumber = d , { d } , "digit" ; (* digit *)\nd = "0" | digit-x ;\n');
    // railroad-beta の参照は nonterminal("…") の引数
    expect(await apply(CALL, prop(CALL, rule('digit'), 'name', 'd'))).toBe(CALL.replace('nonterminal("digit")', 'nonterminal("d")').replace('digit =', 'd ='));
    expect(await apply(ABNF, prop(ABNF, rule('DIGIT'), 'name', 'NUM'))).toBe('railroad-abnf-beta\nnumber = [ "-" ] 1*NUM;\nNUM = %x30-39;');
    expect(await apply(PEG, prop(PEG, rule('Term'), 'name', 'T'))).toBe('railroad-peg-beta\nExpr <- T (("+" / "-") T)*;\nT <- "0" / "1";');
  });

  it('使えない名前・他の規則と同じ名前には変えない', () => {
    expect(prop(EBNF, rule('digit'), 'name', '数字')).toBeNull();
    expect(prop(EBNF, rule('digit'), 'name', '1a')).toBeNull();
    expect(prop(EBNF, rule('digit'), 'name', 'number')).toBeNull();
    // ABNF の名前に _ は使えない
    expect(prop(ABNF, rule('DIGIT'), 'name', 'A_B')).toBeNull();
  });

  it('同じ名前の規則が複数あれば、名前を変えても参照は変えない', async () => {
    const src = 'railroad-ebnf-beta\nr = "a" ;\nr = "b" ;\ns = r ;\n';
    expect(await apply(src, prop(src, rule('r#2'), 'name', 'q'))).toBe('railroad-ebnf-beta\nr = "a" ;\nq = "b" ;\ns = r ;\n');
  });

  it('定義を 1 つの文字列として書き換える', async () => {
    expect(field(EBNF, rule('number'), 'definition')!.value).toBe('[ "-" ] , digit , { digit }');
    expect(await apply(EBNF, prop(EBNF, rule('number'), 'definition', 'digit , { digit }'))).toBe(EBNF.replace('[ "-" ] , digit , { digit }', 'digit , { digit }'));
    expect(await apply(PEG, prop(PEG, rule('Term'), 'definition', '"0" / "1" / "2"'))).toBe(PEG.replace('"0" / "1"', '"0" / "1" / "2"'));
    // ; や行末までのコメントは、規則の区切りを変えてしまうので受け付けない（文字列の中の ; はよい）
    expect(prop(EBNF, rule('number'), 'definition', 'digit ; x = "a"')).toBeNull();
    expect(prop(EBNF, rule('number'), 'definition', 'digit %% メモ')).toBeNull();
    expect(prop(PEG, rule('Term'), 'definition', '"0" # メモ')).toBeNull();
    expect(prop(ABNF, rule('number'), 'definition', '"a" ; メモ')).toBeNull();
    expect(prop(ABNF, rule('number'), 'definition', '')).toBeNull();
    expect(await apply(EBNF, prop(EBNF, rule('number'), 'definition', '"a;b"'))).toContain('number = "a;b" ;');
    // 複数行の定義は表示だけ
    const src = 'railroad-ebnf-beta\nr = "a"\n  | "b" ;\n';
    expect(field(src, rule('r'), 'definition')).toMatchObject({ value: '"a" | "b"', readonly: true });
  });

  it('箱の文字: 終端は引用符の中に書ける形にし、名前・ABNF の数値・特殊は書ける値だけ受け付ける', async () => {
    expect(railroadPlugin.inspect!(EBNF, term('0:0')).map((f) => [f.id, f.value])).toEqual([
      ['kind', '終端記号'],
      ['text', '-'],
    ]);
    expect(await apply(EBNF, prop(EBNF, term('0:0'), 'text', 'a"b\\c'))).toBe(EBNF.replace('"-"', '"a\\"b\\\\c"'));
    expect(await apply(EBNF, prop(EBNF, term('0:1'), 'text', 'num'))).toBe(EBNF.replace(', digit ,', ', num ,'));
    expect(prop(EBNF, term('0:1'), 'text', '数')).toBeNull();
    expect(await apply(ABNF, prop(ABNF, term('1:0'), 'text', '%x41-5A'))).toBe(ABNF.replace('%x30-39', '%x41-5A'));
    expect(prop(ABNF, term('1:0'), 'text', 'x41')).toBeNull();
    expect(await apply(ABNF, prop(ABNF, term('0:0'), 'text', 'a"b'))).toBe(ABNF.replace('"-"', '"ab"'));
    expect(await apply(CALL, prop(CALL, term('1:2'), 'text', 'その他'))).toBe(CALL.replace('special("any digit")', 'special("その他")'));
    const sp = 'railroad-ebnf-beta\nr = ?  空白  ? ;';
    expect(await apply(sp, prop(sp, term('0:0'), 'text', '文字'))).toBe('railroad-ebnf-beta\nr = ?  文字  ? ;');
    expect(prop(sp, term('0:0'), 'text', 'a ? b')).toBeNull();
    // ソースに書かれていない箱（PEG の !x）は表示だけ
    const peg = 'railroad-peg-beta\nR <- !"a" B;';
    expect(field(peg, term('0:0'), 'text')).toMatchObject({ value: '!"a"', readonly: true });
    expect(prop(peg, term('0:0'), 'text', 'x')).toBeNull();
  });
});

describe('mermaid が描く箱の並びと一致する', () => {
  // 決まった種から作った定義を mermaid に読ませ、描く箱（種類と文字）の並びが、こちらで読んだ並びと同じことを確かめる
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pick = <T,>(a: T[]) => a[rnd(a.length)];
  const many = (n: number, f: () => string, sep: string) => Array.from({ length: 1 + rnd(n) }, f).join(sep);
  const gen: Record<string, (depth: number) => string> = {
    ebnf: (dp) => {
      const prim = () => (dp <= 0 || rnd(2) ? pick(['"a"', "'b\'c'", 'x', 'y-z', '? 特殊 ?', '"-"']) : pick(['( # )', '[ # ]', '{ # }']).replace('#', gen.ebnf(dp - 1)));
      return many(3, () => many(3, () => prim() + pick(['', '', '*', '+', ' - x']), pick([' ', ' , '])), ' | ');
    },
    abnf: (dp) => {
      const prim = () => (dp <= 0 || rnd(2) ? pick(['"a"', 'x', 'y-z', '%x30-39', '%d1.2']) : pick(['( # )', '[ # ]']).replace('#', gen.abnf(dp - 1)));
      return many(3, () => many(3, () => pick(['', '', '*', '1*', '2*3', '*1', '3']) + prim(), ' '), ' / ');
    },
    peg: (dp) => {
      const prim = () => (dp <= 0 || rnd(2) ? pick(['"a"', "'b'", 'X', 'y_z', '.']) : `( ${gen.peg(dp - 1)} )`);
      return many(3, () => many(3, () => pick(['', '', '!', '&']) + prim() + pick(['', '', '?', '*', '+']), ' '), ' / ');
    },
    rr: (dp): string => {
      if (dp <= 0) return pick(['terminal("a")', "nonterminal('x')", 'special("s p")', 'terminal("q\\"r")']);
      const f = pick(['sequence', 'choice', 'optional', 'oneOrMore', 'zeroOrMore']);
      return `${f}(${(f === 'sequence' || f === 'choice' ? many(3, () => gen.rr(dp - 1), ', ') : gen.rr(dp - 1))})`;
    },
  };
  const HEAD: Record<string, string> = { ebnf: 'railroad-ebnf-beta', abnf: 'railroad-abnf-beta', peg: 'railroad-peg-beta', rr: 'railroad-beta' };
  type AstNode = { type: string; value?: string; name?: string; text?: string; elements?: AstNode[]; alternatives?: AstNode[]; element?: AstNode };
  const boxes = (n: AstNode): string[] =>
    n.type === 'terminal' ? [`terminal:${n.value}`] : n.type === 'nonterminal' ? [`nonterminal:${n.name}`] : n.type === 'special' ? [`special:${n.text}`] : (n.elements ?? n.alternatives ?? [n.element!]).flatMap(boxes);

  for (const d of Object.keys(gen)) {
    it(d, async () => {
      const mermaid = (await import('mermaid')).default;
      let compared = 0;
      for (let n = 0; n < 15; n++) {
        const src = `${HEAD[d]}\n${['r0', 'r1'].map((name) => `${name} ${d === 'peg' ? '<-' : '='} ${gen[d](rnd(3))};`).join('\n')}\n`;
        if (!(await validate(src)).ok) continue;
        const diagram = await (mermaid as unknown as { mermaidAPI: { getDiagramFromText(s: string): Promise<{ db: { getRules(): { definition: AstNode }[] } }> } }).mermaidAPI.getDiagramFromText(src);
        const theirs = diagram.db.getRules().map((r) => boxes(r.definition));
        const mine = parseRailroad(src)!.rules.map((r) => r.leaves.map((l) => `${l.cls}:${l.value}`));
        expect(mine, src).toEqual(theirs);
        compared++;
      }
      expect(compared).toBeGreaterThan(5);
    });
  }
});
