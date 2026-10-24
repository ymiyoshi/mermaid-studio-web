import type { ChangeSpec } from '@codemirror/state';
import type { Sel } from '../core/history';
import type { TableDef } from './table';

// 設計書 §7.1: 図種プラグインのインターフェース。

export type Capability = 'label' | 'add-node' | 'connect' | 'delete' | 'reorder' | 'props';

export interface SourceRange {
  from: number;
  to: number;
}

/** 図の要素を、再描画をまたいで指すための参照（DOM には依存しない） */
export interface ElementRef {
  /** 'node' | 'edge' | 'participant' | 'message' など、図種ごとの要素の種類 */
  kind: string;
  /** 意味上の ID（ノード ID、エッジの番号など） */
  id: string;
}

/** 図上の要素と、それに対応するソース上の範囲 */
export interface DiagramTarget {
  /** 図の描画ごとに一意な ID */
  id: string;
  /** 強調表示に使う要素 */
  el: Element;
  /** el 以外にクリックを受け付ける要素（細い線の当たり判定、エッジのラベルなど） */
  hits?: Element[];
  /** ラベル編集の入力欄を重ねる要素 */
  labelEl: Element;
  label: string;
  /** ラベルのソース上の範囲。特定できなければ null（その要素のラベルは図から編集できない） */
  range: SourceRange | null;
  /** 追加・接続・削除・プロパティの対象になる要素 */
  ref?: ElementRef;
}

export interface ActionResult {
  change: ChangeSpec;
  /** 履歴ビューに出す説明 */
  label: string;
  /** 適用後のエディタの選択範囲 */
  selAfter?: Sel;
  /** 適用後にラベル編集を始める要素 */
  focus?: ElementRef;
  /** ref の無い要素（メッセージなど）のときは、ラベルの開始位置で指定する */
  focusAt?: number;
}

/** 図からの追加・接続・削除の操作 */
export interface DiagramAction {
  id: string;
  /** ボタンの表示 */
  title: string;
  /** 0: 対象なし（ツールバー） / 1: 選択中の要素 / 2: 選択中の要素 → クリックした要素 */
  arity: 0 | 1 | 2;
  /** arity 1・2 のとき、対象にできる要素の種類（省略時は 'node'） */
  appliesTo?: string[];
  /** arity 2 のとき、2 つ目に選べる要素の種類（省略時は appliesTo と同じ） */
  targetKinds?: string[];
  /** arity 2 のとき、2 つ目の要素を選ぶよう促す文 */
  prompt?: string;
  /** キーボードの割り当て（'Tab' / 'Delete' / 'Enter+Shift' など） */
  key?: string;
  danger?: boolean;
  run(source: string, refs: ElementRef[]): ActionResult | null;
}

/** プロパティパネルの入力欄 */
export interface PropertyField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'select';
  value: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  /** 表示だけで変更できない値 */
  readonly?: boolean;
  /** true なら入力のたびではなく、確定（Enter・フォーカスを外す）したときに反映する（ID の変更など） */
  commitOnBlur?: boolean;
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
  /** 要素（null なら図全体）のプロパティ */
  inspect?(source: string, ref: ElementRef | null): PropertyField[];
  /** プロパティの変更を TextEdit に変換する */
  setProperty?(source: string, ref: ElementRef | null, fieldId: string, value: string): ChangeSpec | null;
  /** 行単位の表で編集できる部分（pie のスライス、gantt のタスクなど） */
  tables?: TableDef[];
}

export const sameRef = (a: ElementRef | undefined | null, b: ElementRef | undefined | null) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;

export const refKey = (r: ElementRef) => `${r.kind}:${r.id}`;
