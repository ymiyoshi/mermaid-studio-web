// 新規作成用のテンプレート。全図種の表示確認にも使う。

export interface Template {
  id: string;
  name: string;
  text: string;
}

export const TEMPLATES: Template[] = [
  { id: 'blank', name: '空の図', text: '' },
  {
    id: 'flowchart',
    name: 'フローチャート',
    text: `flowchart TD
    %% 処理の流れ
    A[開始] --> B{条件を満たす?}
    B -->|はい| C[処理を実行]
    B -->|いいえ| D[スキップ]
    C --> E[終了]
    D --> E
`,
  },
  {
    id: 'sequence',
    name: 'シーケンス図',
    text: `sequenceDiagram
    participant U as ユーザー
    participant S as サーバー
    U->>S: リクエスト
    S-->>U: レスポンス
    Note over U,S: 通信は暗号化
`,
  },
  {
    id: 'class',
    name: 'クラス図',
    text: `classDiagram
    class Animal {
      +String name
      +move()
    }
    class Dog {
      +bark()
    }
    Animal <|-- Dog
`,
  },
  {
    id: 'state',
    name: '状態遷移図',
    text: `stateDiagram-v2
    [*] --> 待機
    待機 --> 実行中: 開始
    実行中 --> 待機: 停止
    実行中 --> [*]: 完了
`,
  },
  {
    id: 'er',
    name: 'ER 図',
    text: `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    CUSTOMER {
      string name
      string email
    }
`,
  },
  {
    id: 'gantt',
    name: 'ガントチャート',
    text: `gantt
    title 開発計画
    dateFormat YYYY-MM-DD
    section 設計
    要件定義 :a1, 2026-11-01, 7d
    基本設計 :after a1, 10d
    section 実装
    Phase 0 :2026-11-20, 14d
`,
  },
  {
    id: 'pie',
    name: '円グラフ',
    text: `pie title 利用ブラウザ
    "Chrome" : 62
    "Safari" : 20
    "Firefox" : 10
    "その他" : 8
`,
  },
  {
    id: 'mindmap',
    name: 'マインドマップ',
    text: `mindmap
  root((Mermaid Studio))
    表示
      全図種
    編集
      テキスト
      図
    履歴
      ツリー
      永続化
`,
  },
  {
    id: 'gitgraph',
    name: 'Git グラフ',
    text: `gitGraph
    commit
    branch feature
    checkout feature
    commit
    commit
    checkout main
    merge feature
    commit
`,
  },
  {
    id: 'journey',
    name: 'ユーザージャーニー',
    text: `journey
    title 図を作る
    section 準備
      テンプレートを選ぶ: 5: ユーザー
    section 編集
      ラベルを直す: 4: ユーザー
      履歴を戻る: 3: ユーザー
`,
  },
  {
    id: 'timeline',
    name: 'タイムライン',
    text: `timeline
    title リリース
    2026-11 : Phase 0
    2026-12 : Phase 1 : flowchart
    2027-01 : Phase 2
`,
  },
  {
    id: 'quadrant',
    name: '4 象限チャート',
    text: `quadrantChart
    title 優先度
    x-axis 低い工数 --> 高い工数
    y-axis 低い効果 --> 高い効果
    quadrant-1 計画する
    quadrant-2 すぐやる
    quadrant-3 後回し
    quadrant-4 見直す
    機能A: [0.3, 0.8]
    機能B: [0.7, 0.6]
`,
  },
  {
    id: 'usecase',
    name: 'ユースケース図',
    text: `usecase-beta
    actor User
    actor Admin
    User --> "ログイン"
    Admin --> "図を管理"
`,
  },
  {
    id: 'kanban',
    name: 'カンバン',
    text: `kanban
  todo[やること]
    t1[設計書を書く]
    t2[図を描く]
  doing[作業中]
    t3[実装]
  done[完了]
    t4[調査]
`,
  },
  {
    id: 'architecture',
    name: 'アーキテクチャ図',
    text: `architecture-beta
    group api(cloud)[API]
    service db(database)[データベース] in api
    service server(server)[サーバー] in api
    db:L -- R:server
`,
  },
  {
    id: 'c4',
    name: 'C4 図',
    text: `C4Context
    title システム構成
    Person(user, "利用者")
    System(sys, "Mermaid Studio", "ブラウザだけで動く")
    Rel(user, sys, "図を描く")
`,
  },
  {
    id: 'sankey',
    name: 'サンキー図',
    text: `sankey-beta
Visit,New,40
Visit,Template,25
New,Saved,30
Template,Saved,20
`,
  },
  {
    id: 'requirement',
    name: '要求図',
    text: `requirementDiagram
    requirement undo_history {
    id: 1
    text: "無制限に undo できる"
    risk: medium
    verifymethod: test
    }
    element history_tree {
    type: module
    }
    history_tree - satisfies -> undo_history
`,
  },
  {
    id: 'xychart',
    name: 'XY チャート',
    text: `xychart
    title "月別の図の数"
    x-axis ["1月", "2月", "3月", "4月"]
    y-axis "件数" 0 --> 50
    bar [10, 22, 31, 45]
    line [10, 22, 31, 45]
`,
  },
  {
    id: 'block',
    name: 'ブロック図',
    text: `block-beta
    columns 3
    %% 画面とサーバーの構成
    front["フロント"] api["API"]:2
    block:back:3
        db[("データベース")] cache["キャッシュ"] queue>"キュー"]
    end
    front --> api
    api --> db
`,
  },
];
