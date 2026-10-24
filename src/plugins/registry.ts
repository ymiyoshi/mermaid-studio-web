import { genericPlugin } from './generic';
import { flowchartPlugin } from './flowchart';
import { sequencePlugin } from './sequence';
import { classPlugin } from './classDiagram';
import { statePlugin } from './stateDiagram';
import { erPlugin } from './erDiagram';
import { mindmapPlugin } from './mindmap';
import { kanbanPlugin } from './kanban';
import { DATA_PLUGINS } from './dataPlugins';
import type { DiagramPlugin } from './types';

// 図種ごとのプラグイン。登録の無い図種は汎用フォールバック（ラベル編集のみ）になる。
const plugins = new Map<string, DiagramPlugin>();

export function registerPlugin(p: DiagramPlugin, ...aliases: string[]) {
  plugins.set(p.type, p);
  for (const a of aliases) plugins.set(a, p);
}

registerPlugin(flowchartPlugin, 'flowchart');
registerPlugin(sequencePlugin);
registerPlugin(classPlugin, 'class');
registerPlugin(statePlugin, 'state');
registerPlugin(erPlugin);
registerPlugin(mindmapPlugin);
registerPlugin(kanbanPlugin);
for (const { plugin, aliases } of DATA_PLUGINS) registerPlugin(plugin, ...(aliases ?? []));

export function pluginFor(diagramType: string | null): DiagramPlugin {
  return (diagramType && plugins.get(diagramType)) || genericPlugin;
}
