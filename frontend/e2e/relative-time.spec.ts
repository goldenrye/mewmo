import { expect, test } from "@playwright/test";

test.use({ timezoneId: "Asia/Shanghai" });

for (const text of [
  "增加一个5分钟后的测试提示",
  "Add a notification 5 minutes later",
]) {
  test(`countdown preview and confirmed reminder: ${text}`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2099-11-09T13:33:00+08:00"));
    await page.goto("/");
    await page.getByLabel("Username", { exact: true }).fill("admin");
    await page.getByLabel("Your password").fill("mewmo-local-test");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    const before = await page.request
      .get("/api/items")
      .then((response) => response.json());
    await page
      .getByRole("textbox", { name: "Natural language input" })
      .fill(text);
    const request = page.waitForRequest((request) =>
      request.url().endsWith("/drafts/text"),
    );
    await page.getByRole("button", { name: "Preview draft" }).click();
    expect((await request).postDataJSON().client_now).toBe(
      "2099-11-09T05:33:00.000Z",
    );
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Time", { exact: true })).toHaveValue(
      "13:38",
    );
    await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue(
      "2099-11-09",
    );
    expect(
      await page.request.get("/api/items").then((response) => response.json()),
    ).toHaveLength(before.length);
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/items") &&
        response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Confirm & save" }).click();
    const item = await (await saved).json();
    await expect(dialog).not.toBeVisible();
    const reminders = await page.request
      .get(`/api/items/${item.id}/reminders`)
      .then((response) => response.json());
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      rule_key: "before:0",
      status: "pending",
    });
    expect(new Date(reminders[0].fire_at).toISOString()).toBe(
      "2099-11-09T05:38:00.000Z",
    );
    await page.request.delete(`/api/items/${item.id}`);
  });
}

test("countdown crosses midnight and rounds up instead of firing early", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2099-11-09T23:58:20+08:00"));
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Your password").fill("mewmo-local-test");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Natural language input" })
    .fill("5分钟后提醒我");
  await page.getByRole("button", { name: "Preview draft" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Time", { exact: true })).toHaveValue("00:04");
  await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue(
    "2099-11-10",
  );
  await expect(
    dialog.getByText(
      "Relative reminder times are rounded up to the next minute.",
    ),
  ).toBeVisible();
});
