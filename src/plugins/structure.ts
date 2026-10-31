import { inSubtree, subtreeEnd, type OutlineNode } from './outline';
import { sameRef, type DuplicateSpec, type ElementRef, type StructureLink, type StructureSpec } from './types';
import { lastParse } from './source';
import { t } from '../i18n';

// 設計書 §17.2: 図の構造（親子と線のつながり）をたどる共通処理。
// 図種ごとの StructureSpec を、vi の ]e・[e・]g・[g・>>・<<、アウトライン、読み上げから使う。

/** インデントの木（mindmap・kanban・ishikawa・treeView）の StructureSpec。items はノードと参照の組（ソースの順） */
export function treeStructure(items: (source: string) => { node: OutlineNode; ref: ElementRef }[]): StructureSpec {
  // 一覧は要素ごとに parent を呼ぶので、同じソースを読み直さない
  const itemsOnce = lastParse(items);
  const find = (source: string, ref: ElementRef) => {
    const list = itemsOnce(source);
    return { list, hit: list.find((x) => sameRef(x.ref, ref)) };
  };
  const refOf = (list: { node: OutlineNode; ref: ElementRef }[], node: OutlineNode) => list.find((x) => x.node === node)?.ref ?? null;
  return {
    parent(source, ref) {
      const { list, hit } = find(source, ref);
      return hit?.node.parent ? refOf(list, hit.node.parent) : null;
    },
    children(source, ref) {
      const { list, hit } = find(source, ref);
      return hit ? hit.node.children.flatMap((c) => refOf(list, c) ?? []) : [];
    },
  };
}

/** ref から線をたどった先（forward なら出ていく先、そうでなければ入ってくる元）。ref が線なら、その端 */
export function followLinks(spec: StructureSpec, source: string, ref: ElementRef, forward: boolean): ElementRef[] {
  const links = spec.links?.(source) ?? [];
  const asEdge = links.find((l) => l.edge && sameRef(l.edge, ref));
  if (asEdge) return [forward ? asEdge.to : asEdge.from];
  return links.filter((l) => sameRef(forward ? l.from : l.to, ref)).map((l) => (forward ? l.to : l.from));
}

/** ref を端に持つ線（ref が線そのものなら空） */
export function linksOf(spec: StructureSpec, source: string, ref: ElementRef): StructureLink[] {
  return (spec.links?.(source) ?? []).filter((l) => sameRef(l.from, ref) || sameRef(l.to, ref));
}

/** 親の並び（内側から外側へ）。循環していても止まる */
export function ancestors(spec: StructureSpec, source: string, ref: ElementRef): ElementRef[] {
  const out: ElementRef[] = [];
  for (let p = spec.parent(source, ref); p && out.length < 100 && !out.some((x) => sameRef(x, p)); p = spec.parent(source, p)) out.push(p);
  return out;
}

/** 線だけを持つ図種（state・class・ER）の StructureSpec。親子は持たない */
export function linkStructure(links: (source: string) => StructureLink[]): StructureSpec {
  return { parent: () => null, children: () => [], links };
}

/**
 * インデントの木の複製（設計書 §17.3）。部分木の行を、その部分木のすぐ後ろ（兄弟として）に写す。
 * renameLine で行ごとに ID を振り直す（kanban のカードの ID など）。copyRef は写した最初のノードの参照（index は写した後の番号）
 */
export function treeDuplicate(o: {
  items(source: string): { node: OutlineNode; ref: ElementRef }[] | null;
  accepts(ref: ElementRef): boolean;
  /** 複製できるノードか（根は 1 つしか書けない図種など） */
  allowed?(node: OutlineNode): boolean;
  renameLine?(text: string, taken: Set<string>, source: string): string;
  copyRef(index: number, text: string, original: ElementRef): ElementRef;
}): DuplicateSpec {
  return {
    accepts: o.accepts,
    run(source, refs) {
      const list = o.items(source);
      if (!list) return null;
      const picked = refs.flatMap((r) => list.find((x) => sameRef(x.ref, r))?.node ?? []);
      const top = picked
        .filter((n) => (o.allowed?.(n) ?? true) && !picked.some((p) => p !== n && inSubtree(n, p)))
        .sort((a, b) => a.index - b.index);
      if (top.length === 0) return null;
      const taken = new Set<string>();
      const change = top.map((n) => {
        const end = subtreeEnd(n);
        const text = source
          .slice(n.line.from, end.to)
          .split('\n')
          .map((l) => o.renameLine?.(l, taken, source) ?? l)
          .join('\n');
        return { from: end.to, insert: '\n' + text, text };
      });
      const first = top[0];
      let last = first;
      while (last.children.length) last = last.children[last.children.length - 1];
      return {
        change: change.map(({ from, insert }) => ({ from, insert })),
        label: t('dup.history', { n: String(top.length) }),
        select: o.copyRef(last.index + 1, change[0].text, list.find((x) => x.node === first)!.ref),
      };
    },
  };
}
