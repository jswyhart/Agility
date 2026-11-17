// Tab strip: reopening, reordering, moving to a window, keyboard use, overflow, session restore.
import { test, expect } from '@playwright/test';
import { launch, fixture, tabStrip } from './helpers.mjs';

const three = () => launch({ files: [fixture('sample.pdf'), fixture('outline.pdf'), fixture('paragraphs.pdf')] });
const titles = (strip) => strip.locator('.tab .title').allTextContents();

// Click an application menu item by label, as its accelerator would.
const menu = (app, label) => app.evaluate(({ Menu }, label) => {
  const find = (m) => {
    for (const item of m.items) {
      if (item.label === label) return item;
      const hit = item.submenu && find(item.submenu);
      if (hit) return hit;
    }
    return null;
  };
  find(Menu.getApplicationMenu()).click();
}, label);

async function loadedTitles(ctx, expected) {
  await expect.poll(() => titles(tabStrip(ctx.app))).toEqual(expected);
}

test('a closed tab can be reopened', async () => {
  const ctx = await three();
  const strip = tabStrip(ctx.app);
  await loadedTitles(ctx, ['sample.pdf', 'outline.pdf', 'paragraphs.pdf']);
  await menu(ctx.app, 'Close Tab');
  await loadedTitles(ctx, ['sample.pdf', 'outline.pdf']);
  await menu(ctx.app, 'Reopen Closed Tab');
  await loadedTitles(ctx, ['sample.pdf', 'outline.pdf', 'paragraphs.pdf']);
  await expect(strip.locator('.tab.active .title')).toHaveText('paragraphs.pdf');
  await ctx.close();
});

test('closing the last document leaves a start page, and closing that closes the window', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const strip = tabStrip(ctx.app);
  await loadedTitles(ctx, ['sample.pdf']);
  await menu(ctx.app, 'Close Tab');
  await loadedTitles(ctx, ['New Tab']);
  const closed = ctx.app.waitForEvent('close');
  await strip.locator('.tab .close').click();
  await closed;
});

test('dragging a tab sideways reorders the tabs', async () => {
  const ctx = await three();
  const strip = tabStrip(ctx.app);
  await loadedTitles(ctx, ['sample.pdf', 'outline.pdf', 'paragraphs.pdf']);
  const first = await strip.locator('.tab >> nth=0').boundingBox();
  const last = await strip.locator('.tab >> nth=2').boundingBox();
  await strip.mouse.move(first.x + 40, first.y + first.height / 2);
  await strip.mouse.down();
  await strip.mouse.move(last.x + last.width - 20, last.y + last.height / 2, { steps: 12 });
  await strip.mouse.up();
  await loadedTitles(ctx, ['outline.pdf', 'paragraphs.pdf', 'sample.pdf']);
  await expect(strip.locator('.tab.active .title')).toHaveText('sample.pdf');
  await ctx.close();
});

test('dragging a tab out of the strip moves it to its own window', async () => {
  const ctx = await three();
  const strip = tabStrip(ctx.app);
  await loadedTitles(ctx, ['sample.pdf', 'outline.pdf', 'paragraphs.pdf']);
  const box = await strip.locator('.tab >> nth=1').boundingBox();
  await strip.mouse.move(box.x + 40, box.y + box.height / 2);
  await strip.mouse.down();
  await strip.mouse.move(box.x + 60, box.y + 300, { steps: 8 });
  await strip.mouse.up();
  await loadedTitles(ctx, ['sample.pdf', 'paragraphs.pdf']);
  await expect.poll(() => ctx.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(2);
  // Every document is still loaded: the tab moved, it wasn't reopened.
  const docs = ctx.app.context().pages().filter((p) => p.url().includes('index.html'));
  const names = await Promise.all(docs.map((p) => p.evaluate(() => window.agility.state.pdf && window.agility.state.fileName)));
  expect(names.sort()).toEqual(['outline.pdf', 'paragraphs.pdf', 'sample.pdf']);
  // The new window's strip takes a moment to load, so look for the strips on each try.
  const strips = () => ctx.app.context().pages().filter((p) => p.url().includes('tabs.html'));
  await expect.poll(async () => (await Promise.all(strips().map(titles))).flat().sort()).toEqual(['outline.pdf', 'paragraphs.pdf', 'sample.pdf']);
  expect(strips()).toHaveLength(2);
  await ctx.close();
});

test('the tab strip works from the keyboard', async () => {
  const ctx = await three();
  const strip = tabStrip(ctx.app);
  await loadedTitles(ctx, ['sample.pdf', 'outline.pdf', 'paragraphs.pdf']);
  await menu(ctx.app, 'Focus Tab Bar');
  await expect(strip.locator('.tab.active')).toBeFocused();
  await strip.keyboard.press('ArrowLeft');
  await expect(strip.locator('.tab.active .title')).toHaveText('outline.pdf');
  await expect(strip.locator('.tab.active')).toBeFocused(); // focus stays in the strip
  await strip.keyboard.press('Home');
  await expect(strip.locator('.tab.active .title')).toHaveText('sample.pdf');
  await strip.keyboard.press('ArrowLeft'); // wraps around
  await expect(strip.locator('.tab.active .title')).toHaveText('paragraphs.pdf');
  await strip.keyboard.press('Delete');
  await loadedTitles(ctx, ['sample.pdf', 'outline.pdf']);
  await menu(ctx.app, 'Tab 1');
  await expect(strip.locator('.tab.active .title')).toHaveText('sample.pdf');
  await menu(ctx.app, 'Last Tab');
  await expect(strip.locator('.tab.active .title')).toHaveText('outline.pdf');
  await ctx.close();
});

test('too many tabs to fit scroll, with the active tab kept in view', async () => {
  const ctx = await launch({ files: [fixture('sample.pdf')] });
  const strip = tabStrip(ctx.app);
  await expect(strip.locator('#list')).toBeHidden();
  for (let i = 0; i < 16; i++) await menu(ctx.app, 'New Tab');
  await expect(strip.locator('.tab')).toHaveCount(17);
  await expect(strip.locator('#list')).toBeVisible();
  await expect(strip.locator('#new')).toBeInViewport();
  await expect(strip.locator('.tab.active')).toBeInViewport();
  await expect(strip.locator('.tab >> nth=0')).not.toBeInViewport();
  await menu(ctx.app, 'Tab 1');
  await expect(strip.locator('.tab >> nth=0')).toBeInViewport();
  await ctx.close();
});

test('the documents open at quit are reopened at the next launch', async () => {
  const first = await launch({ files: [fixture('sample.pdf'), fixture('outline.pdf')] });
  await loadedTitles(first, ['sample.pdf', 'outline.pdf']);
  await first.app.evaluate(({ app }) => app.quit());
  await first.app.waitForEvent('close').catch(() => {});
  const second = await launch({ profile: first.profile, wait: false });
  await loadedTitles(second, ['sample.pdf', 'outline.pdf']);
  await second.close();
});
