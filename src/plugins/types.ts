import type { ChangeSpec } from '@codemirror/state';
import type { Sel } from '../core/history';

// 設計書 §7.1: 図種プラグインのインターフェース。

export type Capability = 'label' | 'add-node' | 'connect' | 'delete' | 'reorder' | 'props';

export interface SourceRange {
  from: number;
  to: number;
}

/** 図上の要素と、それに対応するソース上の範囲 */
export interface DiagramTarget {
  /** 図の描画ごとに一意な ID */
  id: string;
  /** クリック判定と強調表示に使う要素 */
  el: Element;
  /** ラベル編集の入力欄を重ねる要素 */
  labelEl: Element;
  label: string;
  /** ラベルのソース上の範囲。特定できなければ null（その要素のラベルは図から編集できない） */
  range: SourceRange | null;
  /** 意味上の ID（flowchart のノード ID、sequence の参加者 ID）。追加・接続の操作の対象になる */
  elementId?: string;
}

export interface ActionResult {
  change: ChangeSpec;
  /** 履歴ビューに出す説明 */
  label: string;
  /** 適用後のエディタの選択範囲 */
  selAfter?: Sel;
  /** 適用後にラベル編集を始める要素の elementId */
  focus?: string;
  /** elementId の無い要素（メッセージなど）のときは、ラベルの開始位置で指定する */
  focusAt?: number;
}

/** 図からの追加・接続の操作 */
export interface DiagramAction {
  id: string;
  /** ボタンの表示 */
  title: string;
  /** 0: 対象なし（ツールバー） / 1: 選択中の要素 / 2: 選択中の要素 → クリックした要素 */
  arity: 0 | 1 | 2;
  /** arity 2 のとき、2 つ目の要素を選ぶよう促す文 */
  prompt?: string;
  run(source: string, args: string[]): ActionResult | null;
}

export interface DiagramPlugin {
  /** mermaid.parse が返す diagramType。'*' は汎用フォールバック */
  type: string;
  capabilities: Capability[];
  /** 描画済み SVG の要素をソースに対応付ける（§5.2） */
  mapTargets(svg: SVGSVGElement, source: string): DiagramTarget[];
  /** ラベルの書き換えを TextEdit に変換する */
  renameLabel(source: string, target: DiagramTarget, value: string): ChangeSpec | null;
  actions?: DiagramAction[];
}
