import type { ChangeSpec } from '@codemirror/state';
import type { Sel } from '../core/history';
import type { TableDef } from './table';

// 設計書 §7.1: 図種プラグインのインターフェース。

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
  /** range が無いとき、ラベルを差し込める位置（A → A[ラベル] の [ と ] など） */
  insertAt?: { at: number; prefix: string; suffix: string };
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
  /** 適用後に選択する要素（並べ替えで番号が変わる要素を選び続けるため） */
  select?: ElementRef;
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
  /** true なら要素の上のボタンには出さず、右クリックのメニューにだけ出す */
  menuOnly?: boolean;
  run(source: string, refs: ElementRef[]): ActionResult | null;
}

/** プロパティパネルの入力欄 */
export interface PropertyField {
  id: string;
  label: string;
  /** color は文字でも打て、パレットからも選べる欄 */
  type: 'text' | 'number' | 'select' | 'color';
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
  /** 描画済み SVG の要素をソースに対応付ける（§5.2） */
  mapTargets(svg: SVGSVGElement, source: string): DiagramTarget[];
  actions?: DiagramAction[];
  /** 要素（null なら図全体）のプロパティ */
  inspect?(source: string, ref: ElementRef | null): PropertyField[];
  /** プロパティの変更を TextEdit に変換する */
  setProperty?(source: string, ref: ElementRef | null, fieldId: string, value: string): ChangeSpec | null;
  /** 行単位の表で編集できる部分（pie のスライス、gantt のタスクなど） */
  tables?: TableDef[];
  /** ドラッグでの並べ替え（設計書 §6.3: 座標は保存せず、並び順の変更として扱う） */
  reorder?: ReorderSpec;
}

export interface ReorderSpec {
  /** ドラッグで並べ替えられる要素なら、動かす向き（x: 左右、y: 上下）。動かせなければ null */
  axis(source: string, ref: ElementRef): 'x' | 'y' | null;
  /** ref を target の前後に落とせるか（ドラッグ中の落とし先の候補を絞る） */
  accepts(ref: ElementRef, target: ElementRef): boolean;
  /** ref を target の前（before）か後ろへ動かす変更 */
  move(source: string, ref: ElementRef, target: ElementRef, before: boolean): ActionResult | null;
}

/** 選択肢に今の値が無ければ足す（読めない値でも選択欄の表示が崩れないように） */
export const withValue = (options: { value: string; label: string }[], value: string) =>
  options.some((o) => o.value === value) ? options : [...options, { value, label: value }];

export const sameRef = (a: ElementRef | undefined | null, b: ElementRef | undefined | null) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;

export const refKey = (r: ElementRef) => `${r.kind}:${r.id}`;

/**
 * 番号（ソースの中の何番目か）で指す参照か（エッジ・メッセージ・遷移など）。
 * こうした参照は、他の要素を消したり足したりすると別の要素を指すようになるので、描いた図が今のテキストと合っているときだけ使う
 */
export const isPositional = (r: ElementRef) => /^\d+(:\d+)*$/.test(r.id);
