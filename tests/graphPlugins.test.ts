// @vitest-environment jsdom
// mermaid.parse は DOMPurify（DOM）を使うため jsdom で動かす
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import mermaid from 'mermaid';
import { classPlugin, parseRelations } from '../src/plugins/classDiagram';
import { parseTransitions, statePlugin, stateLabel } from '../src/plugins/stateDiagram';
import { erPlugin, parseRelationships } from '../src/plugins/erDiagram';
import type { DiagramPlugin, ElementRef } from '../src/plugins/types';

const apply = (source: string, spec: ChangeSpec | null | undefined) => {
  expect(spec).toBeTruthy();
  return ChangeSet.of(spec!, source.length).apply(Text.of(source.split('\n'))).toString();
};
const valid = async (s: string) => expect(mermaid.parse(s)).resolves.toBeTruthy();

function act(plugin: DiagramPlugin, id: string, source: string, refs: ElementRef[] = []) {
  const res = plugin.actions!.find((a) => a.id === id)!.run(source, refs);
  expect(res).toBeTruthy();
  return apply(source, res!.change);
}
const prop = (plugin: DiagramPlugin, source: string, ref: ElementRef | null, field: string, value: string) =>
  apply(source, plugin.setProperty!(source, ref, field, value));

const CLASS = `classDiagram
    %% 動物
    class Animal {
      +String name
      +move()
    }
    class Dog["犬"]
    Animal <|-- Dog
    Animal "1" --> "*" Leg : has
    Dog : +bark()
`;

describe('classDiagram', () => {
  it('関係を読む', () => {
    const rels = parseRelations(CLASS);
    expect(rels.map((r) => `${r.a} ${r.values.rel} ${r.b}`)).toEqual(['Animal <|-- Dog', 'Animal --> Leg']);
    expect(rels[1].values).toMatchObject({ ca: '1', cb: '*', label: 'has' });
  });

  it('クラス・メンバー・関係を追加する', async () => {
    let out = act(classPlugin, 'add-class', CLASS);
    expect(out).toContain('class Class1["新しいクラス"]');
    await valid(out);
    out = act(classPlugin, 'add-member', CLASS, [{ kind: 'class', id: 'Animal' }]);
    expect(out).toContain('      +move()\n      +新しいメンバー\n    }');
    await valid(out);
    out = act(classPlugin, 'add-member', CLASS, [{ kind: 'class', id: 'Dog' }]);
    expect(out).toContain('    Dog : +bark()\n    Dog : +新しいメンバー\n');
    await valid(out);
    out = act(classPlugin, 'connect', CLASS, [{ kind: 'class', id: 'Dog' }, { kind: 'class', id: 'Leg' }]);
    expect(out).toContain('    Dog --> Leg\n');
    await valid(out);
  });

  it('クラスを消すと、ブロック・関係・メンバーの行も消える', async () => {
    const out = act(classPlugin, 'delete', CLASS, [{ kind: 'class', id: 'Animal' }]);
    expect(out).toBe('classDiagram\n    %% 動物\n    class Dog["犬"]\n    Dog : +bark()\n');
    await valid(out);
  });

  it('関係の種類・多重度・ラベル、クラスの表示名・種類・名前を変える', async () => {
    let out = prop(classPlugin, CLASS, { kind: 'relation', id: '0' }, 'rel', '*--');
    expect(out).toContain('Animal *-- Dog');
    out = prop(classPlugin, CLASS, { kind: 'relation', id: '1' }, 'ca', '');
    expect(out).toContain('    Animal --> "*" Leg : has\n');
    out = prop(classPlugin, CLASS, { kind: 'relation', id: '0' }, 'label', '継承');
    expect(out).toContain('Animal <|-- Dog : 継承');
    out = prop(classPlugin, CLASS, { kind: 'class', id: 'Dog' }, 'label', 'イヌ');
    expect(out).toContain('class Dog["イヌ"]');
    out = prop(classPlugin, CLASS, { kind: 'class', id: 'Animal' }, 'annotation', 'abstract');
    expect(out).toContain('<<abstract>> Animal');
    await valid(out);
    out = prop(classPlugin, CLASS, { kind: 'class', id: 'Animal' }, 'name', 'Creature');
    expect(out).toContain('class Creature {');
    expect(out).toContain('Creature <|-- Dog');
    expect(out).toContain('%% 動物');
    await valid(out);
  });
});

const STATE = `stateDiagram-v2
    [*] --> Idle
    state "待機中" as Idle
    Idle --> Run : start
    state Run {
        [*] --> Fast
    }
    Run --> [*]
`;

describe('stateDiagram', () => {
  it('遷移と表示名を読む', () => {
    expect(parseTransitions(STATE).map((t) => `${t.a}>${t.b}`)).toEqual(['[*]>Idle', 'Idle>Run', '[*]>Fast', 'Run>[*]']);
    const r = stateLabel(STATE, 'Idle')!;
    expect(STATE.slice(r.from, r.to)).toBe('待機中');
  });

  it('状態を追加・次の状態を追加・遷移を追加', async () => {
    let out = act(statePlugin, 'add-state', STATE);
    expect(out).toContain('state "新しい状態" as S1');
    await valid(out);
    out = act(statePlugin, 'add-next', STATE, [{ kind: 'state', id: 'Fast' }]);
    expect(out).toContain('        [*] --> Fast\n        state "新しい状態" as S1\n        Fast --> S1\n    }');
    await valid(out);
    out = act(statePlugin, 'connect', STATE, [{ kind: 'state', id: 'Run' }, { kind: 'state', id: 'Idle' }]);
    expect(out).toContain('Run --> Idle');
    await valid(out);
  });

  it('状態を消すと、関係する遷移と複合状態のブロックが消える', async () => {
    const out = act(statePlugin, 'delete', STATE, [{ kind: 'state', id: 'Run' }]);
    expect(out).toBe('stateDiagram-v2\n    [*] --> Idle\n    state "待機中" as Idle\n');
    await valid(out);
  });

  it('遷移のラベルと状態の名前を変える', async () => {
    let out = prop(statePlugin, STATE, { kind: 'transition', id: '1' }, 'label', '');
    expect(out).toContain('    Idle --> Run\n');
    out = prop(statePlugin, STATE, { kind: 'transition', id: '3' }, 'label', '完了');
    expect(out).toContain('Run --> [*] : 完了');
    out = prop(statePlugin, STATE, { kind: 'state', id: 'Run' }, 'label', '実行中');
    expect(out).toContain('    Run : 実行中\n');
    await valid(out);
    out = prop(statePlugin, STATE, { kind: 'state', id: 'Idle' }, 'name', 'Wait');
    expect(out).toContain('state "待機中" as Wait');
    expect(out).toContain('Wait --> Run : start');
    await valid(out);
  });
});

const ER = `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : "contains items"
    CUSTOMER {
        string name
        string ORDER_NOTE
    }
`;

describe('erDiagram', () => {
  it('リレーションを読む', () => {
    expect(parseRelationships(ER).map((r) => `${r.a} ${r.v.l}${r.v.mid}${r.v.r} ${r.b} ${r.v.label}`)).toEqual([
      'CUSTOMER ||--o{ ORDER places',
      'ORDER ||--|{ LINE_ITEM "contains items"',
    ]);
  });

  it('エンティティ・属性・リレーションを追加', async () => {
    let out = act(erPlugin, 'add-entity', ER);
    expect(out).toContain('ENTITY1 {\n        string id\n    }');
    await valid(out);
    out = act(erPlugin, 'add-attribute', ER, [{ kind: 'entity', id: 'CUSTOMER' }]);
    expect(out).toContain('        string ORDER_NOTE\n        string 新しい属性\n    }');
    await valid(out);
    out = act(erPlugin, 'add-attribute', ER, [{ kind: 'entity', id: 'ORDER' }]);
    expect(out).toContain('ORDER {\n        string 新しい属性\n    }');
    await valid(out);
    out = act(erPlugin, 'connect', ER, [{ kind: 'entity', id: 'LINE_ITEM' }, { kind: 'entity', id: 'CUSTOMER' }]);
    expect(out).toContain('LINE_ITEM ||--o{ CUSTOMER : has');
    await valid(out);
  });

  it('エンティティを消す（他のエンティティの属性は残す）', async () => {
    const out = act(erPlugin, 'delete', ER, [{ kind: 'entity', id: 'ORDER' }]);
    expect(out).toBe('erDiagram\n    CUSTOMER {\n        string name\n        string ORDER_NOTE\n    }\n');
    await valid(out);
  });

  it('多重度・線・ラベル・名前を変える', async () => {
    let out = prop(erPlugin, ER, { kind: 'relationship', id: '0' }, 'r', '|{');
    expect(out).toContain('CUSTOMER ||--|{ ORDER : places');
    out = prop(erPlugin, ER, { kind: 'relationship', id: '0' }, 'mid', '..');
    expect(out).toContain('CUSTOMER ||..o{ ORDER : places');
    out = prop(erPlugin, ER, { kind: 'relationship', id: '1' }, 'label', '含む 明細');
    expect(out).toContain('LINE_ITEM : "含む 明細"');
    await valid(out);
    out = prop(erPlugin, ER, { kind: 'entity', id: 'ORDER' }, 'name', 'PURCHASE');
    expect(out).toContain('CUSTOMER ||--o{ PURCHASE : places');
    expect(out).toContain('PURCHASE ||--|{ LINE_ITEM');
    expect(out).toContain('string ORDER_NOTE');
    await valid(out);
  });
});
