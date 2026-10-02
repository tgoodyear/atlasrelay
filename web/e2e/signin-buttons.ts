import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';

// Checks on the /signin buttons shared by the default build (sign-in.spec.ts) and the build with
// every provider (test-site/signin-buttons.spec.ts): each has its name, its provider's mark hidden
// from assistive technology, a layout that fits, and AA text contrast at rest, on hover and on
// focus. src/lib/providerLogos.ts has the marks.

export const MOBILE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 800 };

function luminance([r, g, b]: number[]): number {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function rgb(css: string): number[] {
  const parts = /rgba?\(([^)]+)\)/.exec(css)?.[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  if (!parts || parts.length < 3) throw new Error(`not a colour: ${css}`);
  if (parts.length > 3 && parts[3] !== 1) throw new Error(`a translucent colour needs the colour behind it: ${css}`);
  return parts.slice(0, 3);
}

/** The WCAG contrast ratio of a link's text against its own background, as the browser draws it now. */
async function textContrast(link: Locator): Promise<number> {
  const { color, background } = await link.evaluate((el) => {
    const style = getComputedStyle(el);
    return { color: style.color, background: style.backgroundColor };
  });
  const [a, b] = [luminance(rgb(color)), luminance(rgb(background))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The sign-in links on the page, checked one by one; returns them for more checks. */
export async function checkSignInButtons(page: Page, labels: string[]): Promise<Locator[]> {
  const options = page.getByRole('list', { name: 'Sign-in options' }).getByRole('link');
  await expect(options).toHaveText(labels.map((label) => `Sign in with ${label}`));
  const viewport = page.viewportSize();
  const links: Locator[] = [];
  for (const label of labels) {
    const link = page.getByRole('link', { name: `Sign in with ${label}`, exact: true });
    await expect(link).toHaveAccessibleName(`Sign in with ${label}`);
    const logo = link.locator('svg');
    await expect(logo).toHaveCount(1);
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('aria-hidden', 'true');
    await expect(logo).toHaveAttribute('focusable', 'false');
    await expect(logo).toHaveClass('signin-logo');

    // 18 to 20 px, beside the text and centred on it, and the whole button on screen.
    const box = (await logo.boundingBox())!;
    const text = (await link.locator('span').boundingBox())!;
    const button = (await link.boundingBox())!;
    expect(box.width, label).toBeGreaterThanOrEqual(18);
    expect(box.width, label).toBeLessThanOrEqual(20);
    expect(box.height, label).toBe(box.width);
    expect(Math.abs(box.y + box.height / 2 - (text.y + text.height / 2)), label).toBeLessThanOrEqual(1);
    const gap = text.x - (box.x + box.width);
    expect(gap, label).toBeGreaterThanOrEqual(8);
    expect(gap, label).toBeLessThanOrEqual(14);
    expect(box.x, label).toBeGreaterThan(button.x);
    expect(text.x + text.width, label).toBeLessThan(button.x + button.width);
    expect(await link.evaluate((el) => el.scrollWidth <= el.clientWidth), label).toBe(true);
    if (viewport) expect(button.x + button.width, label).toBeLessThanOrEqual(viewport.width);
    links.push(link);
  }

  // Every button is as wide as the others: one stacked column.
  const widths = await Promise.all(links.map(async (l) => (await l.boundingBox())!.width));
  expect(new Set(widths.map(Math.round)).size).toBe(1);

  // AA text contrast (4.5:1) at rest, on hover and on keyboard focus. The background eases over
  // 0.15 s, so each reading waits for it.
  for (const [i, link] of links.entries()) {
    expect(await textContrast(link), `${labels[i]} at rest`).toBeGreaterThanOrEqual(4.5);
    await link.hover();
    await page.waitForTimeout(300);
    expect(await textContrast(link), `${labels[i]} on hover`).toBeGreaterThanOrEqual(4.5);
  }
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  for (const [i, link] of links.entries()) {
    await link.focus();
    expect(await link.evaluate((el) => el.matches(':focus-visible')), labels[i]).toBe(true);
    await page.waitForTimeout(300);
    expect(await textContrast(link), `${labels[i]} on focus`).toBeGreaterThanOrEqual(4.5);
    expect(await link.evaluate((el) => getComputedStyle(el).outlineStyle), labels[i]).not.toBe('none');
  }
  return links;
}

/** axe-core on the whole page, WCAG 2.1 A and AA. */
export async function checkAxe(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => `${v.id}: ${v.help} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}
