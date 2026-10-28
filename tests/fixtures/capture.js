// 開発サーバー（npm run dev）を開いたページの DevTools のコンソールで実行し、
// 返ってきた JSON を tests/fixtures/rendered-svg.json に保存する（mermaid の版を上げたときに作り直す）。
// 例: copy(JSON.stringify(await ($0 = <この関数>)()))
async () => {
  const m = await import('/src/render/mermaid.ts');
  const { TEMPLATES } = await import('/src/core/templates.ts');
  m.configureMermaid('default');
  const extra = {
    'flowchart-subgraph': `flowchart LR
  A --> B
  subgraph S1
    C --> D
    D --> E
  end
  B --> C
  E --> A
  A --> C`,
    'sequence-blocks': `sequenceDiagram
  participant A
  participant B
  A->>B: hello
  alt ok
    B-->>A: fine
  else ng
    B-xA: error
  end
  Note over A,B: note
  loop every
    A->>A: self
  end
  B->>A: bye`,
    'architecture-full': `architecture-beta
    title 構成
    group cloud(cloud)[クラウド]
    group inner(server)[内側] in cloud
    service web(internet)[ウェブ]
    service api(server)[API サーバー] in cloud
    service db(database)["データ ベース"] in inner
    service bare in cloud
    junction j1 in cloud
    %% コメント
    web:R --> L:api{group}
    api:B -[読み書き]- T:j1
    j1:R -- L:db
    j1:B <--> T:bare`,
    'flowchart-full': `flowchart LR
  A[開始] --> B
  B -- はい --> C@{ shape: doc, label: "書類 {1}" }
  B ---> D@{ shape: cyl, label: 記録 }
  C & D --> E((終了)):::hot
  E ~~~ F
  subgraph S1 [外側]
    direction TB
    G --> H
    subgraph S2 [内側]
      I
    end
  end
  subgraph "日本語の題"
    J
  end
  F --> S1
  S2 --> J
  classDef hot fill:#f96,stroke:#333
  class A,B hot
  style F fill:#bbf
  linkStyle 0,2 stroke:#f00,stroke-width:3px`,
    'sequence-full': `sequenceDiagram
  title: 注文の流れ
  autonumber
  box Aqua 店
    actor U as 客
    participant W@{ "type": "boundary" } as 窓口
  end
  participant D@{ "type": "database" }
  U->>+W: 注文
  W-->>-U: 受付
  activate D
  Note left of U: 左の注釈
  Note right of D: 右の注釈
  opt 在庫あり
    W->>D: 引当
    rect rgb(200, 220, 255)
      D-->>W: 完了
    end
  end
  deactivate D
  par 並行1
    W->>U: 通知
  and 並行2
    W->>D: 記録
  end
  critical 決済
    U->>W: 支払い
  option 失敗
    W-xU: 拒否
  end
  break 中止
    U-)W: 取り消し
  end
  loop 外側
    loop 内側
      W->>W: 確認
    end
  end
  U-|\\W: 半分の矢印
  create participant N as 新規
  W->>N: 作成
  destroy N
  W->>N: 破棄`,
    'ishikawa-full': `ishikawa-beta
%% 上側の要因は、子を逆順に描く
遅配
    車両
        古いトラック
            故障が多い
        GPS が古い
    方法
        手作業の配車
    人
        夜勤の<br>教育不足
    天候`,
    'treeview-full': `treeView-beta
    title 構成
    "my project/"
        src/ :::highlight
            index.ts icon(mdi:language-typescript) ## 入口
            'utils file.ts'
        README.md icon()`,
    'venn-full': `venn-beta
  set A["一"]
    text a1["メモ"]
  set B
  set C["三"]
  union A,B,C["全部"]
  style A fill:#ff6b6b`,
    'railroad-call': `railroad-beta
number = sequence(optional(terminal("-")), oneOrMore(nonterminal("digit")));
digit = choice(terminal("0"), terminal("1"), special("any digit"));`,
    'railroad-abnf': `railroad-abnf-beta
number = [ "-" ] 1*DIGIT;
DIGIT = %x30-39;`,
    'railroad-peg': `railroad-peg-beta
Expr <- Term (("+" / "-") Term)*;
Term <- "0" / "1";`,
    packet: `packet
title パケット
0-15: "送信元ポート"
16-31: "宛先ポート"
32-63: "シーケンス番号"`,
    radar: `radar-beta
title 技術
axis a["設計"], b["実装"], c["試験"]
curve x["田中"]{4, 3, 5}
curve y["鈴木"]{2, 5, 3}`,
    treemap: `treemap-beta
"製品"
    "アプリ": 30
    "サーバー": 20
"サービス"
    "保守": 15`,
    'wardley-full': `wardley-beta
title Tea Shop
anchor Business [0.95, 0.63]
component Cup of Tea [0.79, 0.61] label [19, -4]
component Kettle [0.43, 0.35] (build) inertia
component "Power Supply" [0.10, 0.70]
pipeline Kettle {
  component Electric Kettle [0.60]
}
Business -> Cup of Tea
Cup of Tea -> Kettle; boil
Kettle -.-> "Power Supply"
note "Standard power" [0.30, 0.49]`,
  };
  const out = {};
  const all = { ...Object.fromEntries(TEMPLATES.filter((t) => t.text).map((t) => [t.id, t.text])), ...extra };
  for (const [id, source] of Object.entries(all)) {
    const r = await m.renderSvg(source);
    out[id] = r.ok ? { source, svg: r.svg } : { source, error: r.error.message };
  }
  return out;
}
