import { expect, test, type Page } from "@playwright/test";
import type { Item } from "../src/types";

async function navigate(page: Page, name: string) {
  await page
    .getByRole("button", { name, exact: true })
    .filter({ visible: true })
    .click();
}

function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const rgb = hex
      .replace("#", "")
      .match(/../g)!
      .map((part) => {
        const value = Number.parseInt(part, 16) / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("lilac palette has readable text, distinct statuses, and matching browser chrome", async ({
  page,
}) => {
  await page.goto("/");
  const palette = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      [
        "canvas",
        "surface",
        "ink",
        "muted",
        "accent",
        "accent-hover",
        "accent-soft",
        "peach",
        "peach-strong",
        "neutral",
        "success",
        "success-soft",
        "warning",
        "warning-soft",
        "danger",
        "danger-soft",
        "control-line",
      ].map((name) => [name, style.getPropertyValue(`--${name}`).trim()]),
    );
  });
  for (const background of [
    "canvas",
    "surface",
    "peach",
    "neutral",
    "accent-soft",
  ]) {
    for (const foreground of ["ink", "muted", "accent-hover"]) {
      expect(
        contrast(palette[foreground], palette[background]),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
  for (const name of ["accent", "accent-hover", "danger"]) {
    expect(
      contrast("#ffffff", palette[name]),
      `white on ${name}`,
    ).toBeGreaterThanOrEqual(4.5);
  }
  for (const name of ["success", "warning", "danger"]) {
    expect(
      contrast(palette[name], palette[`${name}-soft`]),
      name,
    ).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast(palette["control-line"], "#ffffff")).toBeGreaterThanOrEqual(
    3,
  );
  expect(contrast(palette.accent, palette.canvas)).toBeGreaterThanOrEqual(3);
  expect(palette.accent).toBe("#8466a6");
  expect(
    contrast(palette["peach-strong"], palette.canvas),
  ).toBeGreaterThanOrEqual(3);
  expect(
    new Set([palette.success, palette.warning, palette.danger, palette.accent])
      .size,
  ).toBe(4);
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(248, 246, 242)",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    palette.canvas,
  );
  const manifest = await page.request
    .get("/manifest.webmanifest")
    .then((response) => response.json());
  expect(manifest.theme_color).toBe(palette.canvas);
  expect(manifest.background_color).toBe(palette.canvas);
  await expect(page.locator(".brand-mark")).toHaveAttribute(
    "src",
    "/icon-192.png",
  );
  await page.getByLabel("Username", { exact: true }).focus();
  await expect(page.getByLabel("Username", { exact: true })).toHaveCSS(
    "outline-color",
    "rgb(132, 102, 166)",
  );
});

test("selected navigation, calendar, and draft use the shared palette without layout changes", async ({
  page,
}, testInfo) => {
  await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "mewmo-local-test" },
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".capture-card")).toHaveCSS(
    "background-color",
    "rgb(255, 253, 250)",
  );
  await expect(page.locator(".parse-button")).toHaveCSS(
    "background-color",
    "rgb(132, 102, 166)",
  );
  await expect(page.locator(".capture-input textarea")).toHaveCSS(
    "color",
    "rgb(46, 45, 43)",
  );
  const selected = page
    .locator(".sidebar button.active, .mobile-nav button.active")
    .filter({ visible: true });
  await expect(selected).toHaveCSS("background-color", "rgb(246, 221, 210)");
  await expect(selected).toHaveCSS("color", "rgb(46, 45, 43)");
  await page.screenshot({
    path: testInfo.outputPath("lilac-overview.png"),
    fullPage: true,
  });
  await navigate(page, "Calendar");
  const today = page.locator(".calendar-grid button.today");
  await expect(page.locator(".full-calendar")).toHaveCSS(
    "border-radius",
    "20px",
  );
  await expect(page.locator(".calendar-legend > i")).toHaveCSS(
    "background-color",
    "rgb(132, 102, 166)",
  );
  await expect(today).toHaveCSS("background-color", "rgb(132, 102, 166)");
  await expect(today).toHaveCSS("color", "rgb(255, 255, 255)");
  await today.click();
  await expect(today).toHaveCSS("background-color", "rgb(132, 102, 166)");
  await expect(today).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(today).toHaveCSS("outline-color", "rgb(115, 85, 143)");
  await page.screenshot({
    path: testInfo.outputPath("lilac-calendar.png"),
    fullPage: true,
  });
  await navigate(page, "Overview");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCSS("color", "rgb(46, 45, 43)");
  await expect(dialog).toHaveCSS("background-color", "rgb(255, 253, 250)");
  await expect(dialog.locator(".date-preview")).toHaveCSS(
    "background-color",
    "rgb(240, 234, 245)",
  );
  await expect(dialog.locator(".segmented button.active")).toHaveCSS(
    "background-color",
    "rgb(246, 221, 210)",
  );
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("lilac-draft.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("reference-style item cards stay readable and usable on narrow screens", async ({
  page,
}, testInfo) => {
  const item: Item = {
    id: "theme-preview",
    kind: "bill",
    title: "Boost Mobile",
    payee: "Boost Mobile",
    amount: "61.78",
    currency: "USD",
    account_last4: null,
    due_date: "2099-11-12",
    due_time: "09:00",
    timezone: "UTC",
    due_at: "2099-11-12T09:00:00Z",
    status: "open",
    rules: [],
    created_at: "2026-11-07T00:00:00Z",
    finished_at: null,
  };
  await page.route("**/api/items", (route) => route.fulfill({ json: [item] }));
  await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "mewmo-local-test" },
  });
  await page.goto("/");
  await navigate(page, "Calendar");
  const card = page.locator(".item-row");
  await expect(card).toHaveCSS("background-color", "rgb(255, 253, 250)");
  await expect(card).toHaveCSS("border-left-color", "rgb(132, 102, 166)");
  await expect(card).toHaveCSS("border-radius", "14px");
  await expect(card.locator(".item-amount")).toHaveCSS(
    "color",
    "rgb(115, 85, 143)",
  );
  await page.screenshot({
    path: testInfo.outputPath("lilac-calendar-with-item.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 740 });
  const paid = page.getByRole("button", { name: "Mark Boost Mobile as paid" });
  await expect(paid).toBeVisible();
  expect((await paid.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(
    await card.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
