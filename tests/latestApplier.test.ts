import { describe, expect, it } from 'vitest';
import { LatestValueApplier } from '../src/ui/latestApplier';

/** 呼ばれた値を記録し、resolve を外から呼べる apply */
function controlled(fail: (v: string) => boolean = () => false) {
  const calls: string[] = [];
  const waits: (() => void)[] = [];
  const apply = (v: string) =>
    new Promise<boolean>((resolve) => {
      calls.push(v);
      waits.push(() => resolve(!fail(v)));
    });
  const step = async () => {
    waits.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { calls, apply, step };
}

describe('LatestValueApplier', () => {
  it('反映の途中に来た値は、最新の値だけを反映する', async () => {
    const c = controlled();
    const a = new LatestValueApplier(c.apply, 'a');
    void a.push('ab');
    void a.push('abc');
    void a.push('abcd');
    await c.step();
    await c.step();
    expect(c.calls).toEqual(['ab', 'abcd']);
  });

  it('反映済みの値と同じなら反映しない', async () => {
    const c = controlled();
    const a = new LatestValueApplier(c.apply, 'x');
    await a.push('x');
    expect(c.calls).toEqual([]);
  });

  it('失敗した値は保留し、次の値で改めて試す', async () => {
    const c = controlled((v) => v === 'A[');
    const a = new LatestValueApplier(c.apply, 'A');
    void a.push('A[');
    await c.step();
    expect(c.calls).toEqual(['A[']);
    void a.push('A[b]');
    await c.step();
    expect(c.calls).toEqual(['A[', 'A[b]']);
  });

  it('止めている間は反映せず、run() で保留の値を反映する', async () => {
    const c = controlled();
    let paused = true;
    const a = new LatestValueApplier(c.apply, '', () => paused);
    void a.push('に');
    void a.push('にほ');
    expect(c.calls).toEqual([]);
    paused = false;
    void a.run();
    await c.step();
    expect(c.calls).toEqual(['にほ']);
  });

  it('reset で反映済みの値をそろえる', async () => {
    const c = controlled();
    const a = new LatestValueApplier(c.apply, 'old');
    a.reset('new');
    await a.push('new');
    expect(c.calls).toEqual([]);
    expect(a.pending).toBe('new');
  });
});
