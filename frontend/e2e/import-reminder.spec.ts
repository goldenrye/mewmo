import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";
import type { Item, Kind, Rule } from "../src/types";

const kindName = { bill: "Bill", appointment: "Appointment", dated_item: "Dated item" };
const before = (minutes: number): Rule => ({ mode: "before", minutes, days: 0, at: "09:00" });
const day = (days: number): Rule => ({ mode: "day", minutes: 60, days, at: "09:00" });
const rules: Record<Kind, Rule[]> = {
  appointment: [before(1440), before(60)],
  dated_item: [before(10080), before(1440), day(0)],
  bill: [before(10080), before(1440), day(0), day(1)],
};

for (const language of ["en", "zh-CN"]) {
  for (const kind of ["bill", "appointment", "dated_item"] as Kind[]) {
    test(`import ${kind} requires confirmation (${language})`, async ({
      page,
    }) => {
      await page.addInitScript(
        (value) => localStorage.setItem("mewmo:language", value),
        language,
      );
      await page.request.post("/api/auth/login", {
        data: { username: "admin", password: "mewmo-local-test" },
      });
      const before: Item[] = await page.request
        .get("/api/items")
        .then((r) => r.json());
      const title = `Imported ${kind} notice`;
      // OCR/provider behavior is covered in backend tests; exercise review and persistence here.
      await page.route("**/api/drafts/file?**", (route) =>
        route.fulfill({
          json: {
            title,
            kind,
            source: "file",
            status: "open",
            payee: kind === "bill" ? "Utility Co" : null,
            amount: kind === "bill" ? "42" : null,
            currency: kind === "bill" ? "USD" : null,
            account_last4: null,
            due_date: "2099-11-08",
            due_time: "09:00",
            timezone: "Asia/Shanghai",
            local_date: "2026-11-06",
            rules: rules[kind],
            duplicates: [],
            uncertain: ["title", "kind"],
            warnings: [
              "Review every field. OCR can make mistakes. The original file has been discarded.",
            ],
          },
        }),
      );
      await page.goto("/");
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("button", {
          name: language === "en" ? "Import reminder" : "导入提醒",
          exact: true,
        })
        .click();
      await (
        await chooser
      ).setFiles({
        name: "reminder.png",
        mimeType: "image/png",
        buffer: Buffer.from("mock OCR input"),
      });
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const chineseKind = {
        bill: "账单",
        appointment: "预约",
        dated_item: "待办",
      };
      await expect(dialog.locator(".kind-switch .active")).toHaveText(
        language === "en" ? kindName[kind] : chineseKind[kind],
      );
      await expect(dialog.locator('input[type="number"]:visible')).toHaveCount(
        kind === "bill" ? 1 : 0,
      );
      await expect(dialog.locator(".date-preview")).toContainText("2099");
      await expect(dialog.locator(".date-preview")).toContainText("09:00");
      const during: Item[] = await page.request
        .get("/api/items")
        .then((r) => r.json());
      expect(during.map((item) => item.id)).toEqual(
        before.map((item) => item.id),
      );
      await dialog.locator('button[type="submit"]').click();
      await expect(dialog).not.toBeVisible();
      const after: Item[] = await page.request
        .get("/api/items")
        .then((r) => r.json());
      const created = after.find(
        (item) => !before.some((old) => old.id === item.id),
      )!;
      try {
        expect(created.kind).toBe(kind);
        expect(created.title).toBe(title);
        expect(created.status).toBe("open");
        expect(created.rules).toEqual(rules[kind]);
      } finally {
        if (created) await page.request.delete(`/api/items/${created.id}`);
      }
    });
  }
}
