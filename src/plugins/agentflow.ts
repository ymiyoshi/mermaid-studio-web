import { EDGE_ARROWS, flowPlugin, SHAPE_OPTIONS } from './flowchart';
import { t } from '../i18n';

// agentflow（AI エージェントの処理の流れ）のプラグイン（設計書 §7.3）。
// フローチャートの書き方を狭めた図種なので、フローチャートのプラグインを、形と矢印の選択肢を絞って使う。
// 枠は subgraph ではなく flow で書く（flowchartSyntax が宣言行で見分ける）。

/** agentflow が描ける形（他の形は書けても四角で描かれる）と、agentflow での呼び名 */
const SHAPES: Record<string, string> = {
  rect: t('af.shape.task'),
  subroutine: t('af.shape.tool'),
  lean: t('af.shape.input'),
  rhombus: t('af.shape.decision'),
  '@lin-doc': t('af.shape.refdoc'),
  hexagon: t('af.shape.action'),
};

/** 順番の線・失敗の線・参照の線だけ */
const ARROWS = ['-->', '--x', '-.-'];

export const agentflowPlugin = flowPlugin({
  type: 'agentflow',
  nodePrefix: 'agentflow',
  shapes: SHAPE_OPTIONS.filter((s) => s.value in SHAPES).map((s) => ({ value: s.value, label: SHAPES[s.value] })),
  arrows: EDGE_ARROWS.filter((a) => ARROWS.includes(a.value)),
});
