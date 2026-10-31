import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { editorText, node, openApp } from './helpers';

// 設計書 §17.8: タイムラプスを GIF に書き出す（録画と違って実時間を待たないので、ほかの E2E と並べて走らせてよい）

test('作った過程を GIF に書き出す', async ({ page }) => {
  const errors = await openApp(page);
  await node(page, '開始').dblclick();
  await page.locator('.inline-label-editor input').fill('スタート');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toContain('A[スタート]');

  await page.getByTitle('作った過程を再生（タイムラプス）').click();
  const view = page.getByRole('dialog', { name: '作った過程を再生' });
  await expect(view.locator('.timelapse-step')).toContainText('2 / 2');
  const download = page.waitForEvent('download');
  await view.getByRole('button', { name: 'GIF に書き出す' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('フローチャート-作った過程.gif');
  const bytes = readFileSync((await file.path())!);
  expect(bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a');
  // 大きさは 800×450
  expect([bytes.readUInt16LE(6), bytes.readUInt16LE(8)]).toEqual([800, 450]);
  expect(bytes.length).toBeGreaterThan(2000);
  expect(errors).toEqual([]);
});
