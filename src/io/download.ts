// ファイルとしてダウンロードさせる。File System Access API の無いブラウザでの保存にも使う。

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** ファイル名に使えない文字を置き換える */
export function safeFileName(title: string): string {
  const s = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return s === '' ? 'diagram' : s.slice(0, 120);
}

/** ファイル選択ダイアログ（File System Access API が無いとき用） */
export function pickFileWithInput(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

export const isAbortError = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
