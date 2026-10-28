import { genericPlugin } from './generic';
import { flowchartPlugin } from './flowchart';
import { agentflowPlugin } from './agentflow';
import { sequencePlugin } from './sequence';
import { classPlugin } from './classDiagram';
import { statePlugin } from './stateDiagram';
import { erPlugin } from './erDiagram';
import { mindmapPlugin } from './mindmap';
import { kanbanPlugin } from './kanban';
import { blockPlugin } from './block';
import { architecturePlugin } from './architecture';
import { DATA_PLUGINS } from './dataPlugins';
import { ishikawaPlugin } from './ishikawa';
import { treeViewPlugin } from './treeView';
import { vennPlugin } from './venn';
import { cynefinPlugin } from './cynefin';
import { wardleyPlugin } from './wardley';
import { eventmodelingPlugin } from './eventmodeling';
import { railroadPlugin } from './railroad';
import type { DiagramPlugin } from './types';

// 図種ごとのプラグイン。登録の無い図種は汎用フォールバック（ラベル編集のみ）になる。
const plugins = new Map<string, DiagramPlugin>();

export function registerPlugin(p: DiagramPlugin, ...aliases: string[]) {
  plugins.set(p.type, p);
  for (const a of aliases) plugins.set(a, p);
}

// swimlane はフローチャートそのもの（最上位の subgraph がレーンになる）
registerPlugin(flowchartPlugin, 'flowchart', 'flowchart-elk', 'swimlane');
registerPlugin(agentflowPlugin);
registerPlugin(sequencePlugin);
registerPlugin(classPlugin, 'class');
registerPlugin(statePlugin, 'state');
registerPlugin(erPlugin);
registerPlugin(mindmapPlugin);
registerPlugin(kanbanPlugin);
registerPlugin(blockPlugin, 'block-beta');
registerPlugin(architecturePlugin);
for (const { plugin, aliases } of DATA_PLUGINS) registerPlugin(plugin, ...(aliases ?? []));
registerPlugin(ishikawaPlugin);
registerPlugin(treeViewPlugin);
registerPlugin(vennPlugin);
registerPlugin(cynefinPlugin);
registerPlugin(wardleyPlugin);
registerPlugin(eventmodelingPlugin);
// railroad は 4 つの書き方（関数・EBNF・ABNF・PEG）で、図の描き方は同じ
registerPlugin(railroadPlugin, 'railroadEbnf', 'railroadAbnf', 'railroadPeg');

export function pluginFor(diagramType: string | null): DiagramPlugin {
  return (diagramType && plugins.get(diagramType)) || genericPlugin;
}
