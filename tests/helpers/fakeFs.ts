// テスト用の File System Access API の代わり（メモリ上のファイル）。

export class FakeHandle {
  readonly kind = 'file';
  writes = 0;
  constructor(
    public name: string,
    public content: string,
    public mtime = 1000,
  ) {}
  async getFile() {
    return new File([this.content], this.name, { lastModified: this.mtime });
  }
  async createWritable() {
    let buf = '';
    return {
      write: async (c: string) => {
        buf += c;
      },
      close: async () => {
        this.content = buf;
        this.mtime += 10;
        this.writes++;
      },
    };
  }
  async queryPermission() {
    return 'granted' as PermissionState;
  }
  async requestPermission() {
    return 'granted' as PermissionState;
  }
  async isSameEntry(other: unknown) {
    return other === this;
  }
  /** 外部のエディタで書き換えられたことにする */
  touch(content: string) {
    this.content = content;
    this.mtime += 100;
  }
}

/** window.showOpenFilePicker / showSaveFilePicker を差し替える。null を渡すと API が無いブラウザにする */
export function installPickers(open: FakeHandle | null, save: FakeHandle | null = open) {
  const w = window as unknown as Record<string, unknown>;
  if (open === null && save === null) {
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
    return;
  }
  w.showOpenFilePicker = async () => [open];
  w.showSaveFilePicker = async () => save;
}

/** ダウンロード（a.click）を横取りして、中身を取り出せるようにする */
export function captureDownloads() {
  const blobs = new Map<string, Blob>();
  const downloads: { name: string; blob: Blob }[] = [];
  let n = 0;
  URL.createObjectURL = (b: Blob | MediaSource) => {
    const url = `blob:test/${++n}`;
    blobs.set(url, b as Blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.download) downloads.push({ name: this.download, blob: blobs.get(this.href)! });
  };
  return downloads;
}
