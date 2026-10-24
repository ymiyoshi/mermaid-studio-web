// 図種プラグインの文言（graph）。キーは「分野.名前」。en は ja と同じキーをすべて持つ（型で確かめる）。

export const ja = {} as const;

export const en: Record<keyof typeof ja, string> = {};
