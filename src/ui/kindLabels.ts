import { t } from '../i18n';

// 図の要素の種類（ElementRef.kind）の表示名。プロパティパネルの見出しと、要素の一覧（§17.4）で使う。

export const KIND_LABEL: Record<string, string> = {
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
  row: t('misc.kind.row'),
  effect: t('misc.kind.effect'),
  cause: t('misc.kind.cause'),
  entry: t('misc.kind.entry'),
  anchor: t('misc.kind.anchor'),
  component: t('misc.kind.component'),
  link: t('misc.kind.link'),
  pipeline: t('misc.kind.pipeline'),
  frame: t('misc.kind.frame'),
  set: t('misc.kind.set'),
  union: t('misc.kind.union'),
  vtext: t('misc.kind.vtext'),
  domain: t('misc.kind.domain'),
  rule: t('misc.kind.rule'),
  term: t('misc.kind.term'),
};

/** 種類の表示名（知らない種類はそのまま） */
export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;
