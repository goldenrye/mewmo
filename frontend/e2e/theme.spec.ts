import { expect, test, type Page } from "@playwright/test";

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

test("warm palette has readable text, distinct statuses, and matching browser chrome", async ({
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
        "teal",
        "teal-hover",
        "teal-soft",
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
    "teal-soft",
  ]) {
    for (const foreground of ["ink", "muted"]) {
      expect(
        contrast(palette[foreground], palette[background]),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
  for (const name of ["teal", "teal-hover", "danger"]) {
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
  expect(contrast(palette.teal, palette.canvas)).toBeGreaterThanOrEqual(3);
  expect(
    contrast(palette["peach-strong"], palette.canvas),
  ).toBeGreaterThanOrEqual(3);
  expect(
    new Set([palette.success, palette.warning, palette.danger, palette.teal])
      .size,
  ).toBe(4);
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(250, 247, 242)",
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
    "rgb(33, 104, 99)",
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
    "rgb(255, 253, 249)",
  );
  await expect(page.locator(".parse-button")).toHaveCSS(
    "background-color",
    "rgb(33, 104, 99)",
  );
  await expect(page.locator(".capture-input textarea")).toHaveCSS(
    "color",
    "rgb(41, 46, 49)",
  );
  const selected = page
    .locator(".sidebar button.active, .mobile-nav button.active")
    .filter({ visible: true });
  await expect(selected).toHaveCSS("background-color", "rgb(250, 227, 211)");
  await expect(selected).toHaveCSS("color", "rgb(41, 46, 49)");
  await page.screenshot({
    path: testInfo.outputPath("warm-overview.png"),
    fullPage: true,
  });
  await navigate(page, "Calendar");
  const today = page.locator(".calendar-grid button.today");
  await expect(today).toHaveCSS("background-color", "rgb(33, 104, 99)");
  await expect(today).toHaveCSS("color", "rgb(255, 255, 255)");
  await today.click();
  await expect(today).toHaveCSS("background-color", "rgb(250, 227, 211)");
  await expect(today).toHaveCSS("color", "rgb(41, 46, 49)");
  await navigate(page, "Overview");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCSS("color", "rgb(41, 46, 49)");
  await expect(dialog).toHaveCSS("background-color", "rgb(255, 253, 249)");
  await expect(dialog.locator(".date-preview")).toHaveCSS(
    "background-color",
    "rgb(232, 242, 239)",
  );
  await expect(dialog.locator(".segmented button.active")).toHaveCSS(
    "background-color",
    "rgb(250, 227, 211)",
  );
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("warm-draft.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
