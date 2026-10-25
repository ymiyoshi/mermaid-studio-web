// 入力の値を、非同期の検証つきで順番に反映する（ラベルの直接編集とプロパティの入力欄で共通）。
// - 反映の途中に新しい値が来たら、終わってから最新の値だけを反映する（途中の値は飛ばす）
// - 反映に失敗した値は保留し、次の値が来たときに改めて試す
// - isPaused() が true の間（IME の変換中など）は反映しない

export class LatestValueApplier {
  private latest: string;
  private settled: string;
  private busy = false;

  /**
   * apply: 値を反映し、成功したら true
   * settled: すでに反映されている値（これと同じ値は反映しない）
   */
  constructor(
    private readonly apply: (value: string) => Promise<boolean>,
    settled: string,
    private readonly isPaused: () => boolean = () => false,
  ) {
    this.latest = settled;
    this.settled = settled;
  }

  /** 外から値が変わったとき（入力し直しの開始時など）に、反映済みの値をそろえる */
  reset(value: string) {
    this.latest = value;
    this.settled = value;
  }

  get pending(): string {
    return this.latest;
  }

  push(value: string): Promise<void> {
    this.latest = value;
    return this.run();
  }

  /** 保留中の値があれば反映する（IME の確定後など） */
  async run(): Promise<void> {
    if (this.busy || this.isPaused()) return;
    this.busy = true;
    try {
      while (this.latest !== this.settled) {
        const value = this.latest;
        if (!(await this.apply(value))) {
          // 待つ間に次の値が来ていたら、それを続けて試す（来ていない・IME の変換中なら保留して次の push / run を待つ）
          if (this.latest === value || this.isPaused()) break;
          continue;
        }
        this.settled = value;
      }
    } finally {
      this.busy = false;
    }
  }
}
