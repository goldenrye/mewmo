import { expect, type Page } from "@playwright/test";

export async function holdSpeech(page: Page, name = "Hold to speak") {
  const button = page.getByRole("button", { name, exact: true });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeEnabled();
  const box = (await button.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return point;
}
