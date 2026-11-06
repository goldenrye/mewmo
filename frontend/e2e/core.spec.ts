import { test, expect } from "@playwright/test";
import { Buffer } from "node:buffer";
import process from "node:process";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-06T12:00:00"));
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page
    .getByLabel("Your password")
    .fill(process.env.MEWMO_TEST_PASSWORD || "mewmo-local-test");
  await page.getByRole("button", { name: "Come on in" }).click();
  await expect(
    page.getByRole("heading", { name: "A little less on your mind." }),
  ).toBeVisible();
});

test("Chinese capture requires confirmation and shows Sunday with full date", async ({
  page,
}) => {
  const before = await page.request.get("/api/items").then((r) => r.json());
  await page
    .getByRole("textbox", { name: "Natural language input" })
    .fill("后天9点有医生预约");
  await page.getByRole("button", { name: "Preview draft" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Title")).toHaveValue("医生预约");
  await expect(
    dialog.getByText("Sunday, November 8, 2026 at 09:00"),
  ).toBeVisible();
  const during = await page.request.get("/api/items").then((r) => r.json());
  expect(during.length).toBe(before.length);
  await dialog.getByRole("button", { name: "Confirm & save" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("医生预约", { exact: true }).first(),
  ).toBeVisible();
  const after = await page.request.get("/api/items").then((r) => r.json());
  const created = after.find(
    (item: { id: string }) =>
      !before.some((b: { id: string }) => b.id === item.id),
  );
  expect(created.title).toBe("医生预约");
  await page.request.delete(`/api/items/${created.id}`);
});

test("manual bill supports paid, undo, history, edit, delivery status, and delete", async ({
  page,
}) => {
  const title = `Browser electricity ${Date.now()}`;
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  const dialog = page.getByRole("dialog");
  // Use a short non-account identifier so privacy redaction does not alter the title.
  const safeTitle = title.replace(/\d/g, "");
  await dialog.getByLabel("Title", { exact: true }).fill(safeTitle);
  await dialog.getByLabel("Payee", { exact: true }).fill("Utility Co");
  await dialog.getByLabel("Amount", { exact: true }).fill("120.50");
  await dialog.getByLabel("Due date", { exact: true }).fill("2099-11-20");
  await dialog.getByRole("button", { name: "Confirm & save" }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", {
      name: `Mark ${safeTitle.trim()} as paid`,
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Bill marked as paid. One less thing."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByText("Item reopened. Future reminders restored."),
  ).toBeVisible();
  await page.getByText(safeTitle.trim(), { exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Reminder delivery" }),
  ).toBeVisible();
  await expect(dialog.getByText("pending", { exact: true })).toHaveCount(4);
  await dialog.getByRole("button", { name: "Edit item" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Title", { exact: true })
    .fill("Edited electricity");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save changes" })
    .click();
  await page
    .getByRole("button", { name: "Mark Edited electricity as paid" })
    .click();
  await page
    .getByRole("button", { name: "History", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByText("Edited electricity", { exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("cancelled", { exact: true }),
  ).toHaveCount(4);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete item", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Yes, delete item" })
    .click();
  await expect(
    page.getByText("Edited electricity", { exact: true }),
  ).toHaveCount(0);
});

test("failed import offers manual entry and does not save", async ({
  page,
}) => {
  const before = await page.request.get("/api/items").then((r) => r.json());
  await page.locator("input[type=file]").setInputFiles({
    name: "unreadable.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await expect(
    page.getByRole("button", { name: "Enter manually" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Enter manually" }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Does this look right?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close editor" }).click();
  const after = await page.request.get("/api/items").then((r) => r.json());
  expect(after.length).toBe(before.length);
});

test("calendar and settings work without horizontal overflow", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Calendar", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByRole("button", { name: "Next month" })).toBeVisible();
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(
    page.getByRole("heading", { name: "December 2026" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByText("Keyboard dictation", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .filter({ visible: true })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome to Mewmo" }),
  ).toBeVisible();
});
