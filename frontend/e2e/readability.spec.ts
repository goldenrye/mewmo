import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Your password").fill("mewmo-local-test");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
}

async function navigate(page: Page, name: string) {
  await page
    .getByRole("button", { name, exact: true })
    .filter({ visible: true })
    .click();
}

async function expectReadable(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const text = await page
    .locator(
      "main p, main label, main summary, main .item-text strong, main .tabs button",
    )
    .filter({ visible: true })
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.textContent?.slice(0, 60),
        size: Number.parseFloat(getComputedStyle(node).fontSize),
      })),
    );
  for (const node of text)
    expect(node.size, node.text).toBeGreaterThanOrEqual(14);
  const controls = await page
    .locator("main button, main input, main summary")
    .filter({ visible: true })
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.getAttribute("aria-label") || node.textContent?.slice(0, 40),
        height: node.getBoundingClientRect().height,
      })),
    );
  for (const node of controls)
    expect(node.height, node.text || "").toBeGreaterThanOrEqual(44);
}

test("each page has readable content and settings are progressively disclosed", async ({
  page,
}, testInfo) => {
  await login(page);
  await expect(
    page.locator(".stats-grid, .right-rail, .sidebar-note, .page-footer"),
  ).toHaveCount(0);
  await expectReadable(page);
  await page.screenshot({
    path: testInfo.outputPath("overview.png"),
    fullPage: true,
  });
  for (const name of ["Calendar", "History", "Notifications", "Settings"]) {
    await navigate(page, name);
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expectReadable(page);
    if (name === "Settings") {
      await expect(
        page.getByLabel("Current password", { exact: true }),
      ).not.toBeVisible();
      await expect(
        page.getByRole("button", { name: "Enable on this device" }),
      ).toHaveCount(0);
      await page
        .locator("summary")
        .filter({ hasText: "Change password" })
        .click();
      await expect(
        page.getByLabel("Current password", { exact: true }),
      ).toBeVisible();
      await page
        .locator("summary")
        .filter({ hasText: "Privacy & preferences" })
        .click();
      await expect(
        page.getByText("System speech recognition", { exact: true }),
      ).toBeVisible();
      await expectReadable(page);
    }
    await page.screenshot({
      path: testInfo.outputPath(`${name.toLowerCase()}.png`),
      fullPage: true,
    });
  }
});

test("optional editor fields and reminder rules remain editable without saving a draft", async ({
  page,
}) => {
  await login(page);
  const before = await page.request
    .get("/api/items")
    .then((response) => response.json());
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Nothing is saved until you confirm."),
  ).toBeVisible();
  await expect(dialog.getByLabel("Title", { exact: true })).toBeVisible();
  await expect(
    dialog.getByLabel("Time zone", { exact: true }),
  ).not.toBeVisible();
  await expect(dialog.getByLabel("Reminder 1 mode")).not.toBeVisible();
  await dialog
    .locator("summary")
    .filter({ hasText: "Time zone & account details" })
    .click();
  await dialog
    .getByLabel("Time zone", { exact: true })
    .fill("America/New_York");
  await dialog.getByLabel("Account last 4 digits (optional)").fill("4321");
  await dialog.locator("summary").filter({ hasText: "Reminders" }).click();
  await dialog.getByLabel("Reminder 1 offset").fill("30");
  await dialog
    .getByRole("button", { name: "Add reminder", exact: true })
    .click();
  await expect(dialog.getByLabel("Reminder 5 offset")).toHaveValue("30");
  await dialog
    .getByRole("button", { name: "Remove reminder 5", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Reset defaults" }).click();
  await expect(dialog.getByLabel("Reminder 1 offset")).toHaveValue("10080");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(
    await page.request.get("/api/items").then((response) => response.json()),
  ).toEqual(before);
});

test("small phones keep long item titles and expanded forms within the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await login(page);
  const response = await page.request.post("/api/items", {
    data: {
      confirmed: true,
      local_date: "2026-11-06",
      timezone: "UTC",
      kind: "bill",
      title:
        "Electricity bill for my apartment with a longer descriptive title",
      payee: "Utility company",
      amount: "120.50",
      currency: "USD",
      due_date: "2099-11-20",
      due_time: "09:00",
      rules: [],
    },
  });
  expect(response.status()).toBe(201);
  const item = await response.json();
  try {
    await page.reload();
    await expect(page.getByText(item.title, { exact: true })).toBeVisible();
    const title = page
      .locator(".item-text strong")
      .filter({ hasText: item.title });
    expect(
      await title.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    for (const name of [
      "Overview",
      "Calendar",
      "History",
      "Notifications",
      "Settings",
    ]) {
      await navigate(page, name);
      await expectReadable(page);
    }
    await navigate(page, "Overview");
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("summary").filter({ hasText: "Reminders" }).click();
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    for (const input of await dialog
      .locator("input, select")
      .filter({ visible: true })
      .all()) {
      expect(
        await input.evaluate((node) =>
          Number.parseFloat(getComputedStyle(node).fontSize),
        ),
      ).toBeGreaterThanOrEqual(16);
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally {
    await page.request.delete(`/api/items/${item.id}`);
  }
});
