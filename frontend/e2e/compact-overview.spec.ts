import { expect, test } from "@playwright/test";

for (const language of ["en", "zh-CN"]) {
  for (const ai of [false, true]) {
    test(`compact overview and import disclosure (${language}, AI ${ai})`, async ({
      page,
    }, testInfo) => {
      const zh = language !== "en";
      await page.addInitScript(
        (language) => localStorage.setItem("mewmo:language", language),
        language,
      );
      await page.route("**/api/model-settings", (route) =>
        route.fulfill({
          json: {
            available: true,
            enabled: ai,
            allow_images: ai,
            provider: "openai",
            model: "first",
            revision: 1,
            models: [
              { provider: "openai", model: "first" },
              { provider: "anthropic", model: "backup" },
            ],
          },
        }),
      );
      await page.request.post("/api/auth/login", {
        data: { username: "admin", password: "mewmo-local-test" },
      });
      await page.route("**/api/items", (route) =>
        route.fulfill({
          json: [
            {
              id: "compact-overdue",
              kind: "dated_item",
              title: "Overdue reminder",
              due_at: "2020-01-01T09:00:00Z",
              due_date: "2020-01-01",
              due_time: "09:00",
              timezone: "UTC",
              status: "open",
              rules: [],
              amount: null,
            },
          ],
        }),
      );
      await page.goto("/");
      const heading = page.locator(".home-heading h1");
      await expect(heading).toBeVisible();
      await expect(page.locator(".overdue-summary")).toContainText("1");
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        const title = (await heading.boundingBox())!;
        const tabs = (await page.locator(".home-switch").boundingBox())!;
        expect(
          Math.abs(title.y + title.height / 2 - tabs.y - tabs.height / 2),
        ).toBeLessThan(2);
        expect(title.x + title.width).toBeLessThanOrEqual(tabs.x);
        expect(
          (await page.locator(".capture-card").boundingBox())!.height,
        ).toBeLessThan(280);
        expect(
          (await page.locator("#items-list").boundingBox())!.y,
        ).toBeLessThan(460);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(page.locator(".overdue-summary")).toBeVisible();
        const controls = await page
          .locator(
            ".home-heading button, .capture-card button, .capture-card summary",
          )
          .filter({ visible: true })
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getBoundingClientRect().height),
          );
        expect(controls.every((height) => height >= 44)).toBe(true);
        const manual = page.getByRole("button", {
          name: zh ? "添加事项" : "Add item",
          exact: true,
        });
        await expect(manual).toBeVisible();
        const manualBox = (await manual.boundingBox())!;
        const captureTitle = (await page
          .locator(".capture-heading h2")
          .boundingBox())!;
        expect(captureTitle.x + captureTitle.width).toBeLessThanOrEqual(
          manualBox.x,
        );
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const options = page.locator(".import-options");
      await expect(options).not.toHaveAttribute("open", "");
      await expect(options.locator(".import-options-body")).not.toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`compact-${language}-${ai}.png`),
        fullPage: true,
      });
      await options.locator("summary").focus();
      await page.keyboard.press("Enter");
      await expect(options.locator(".import-options-body")).toBeVisible();
      if (ai) {
        const checkbox = options.getByRole("checkbox");
        await expect(checkbox).not.toBeChecked();
        await expect(options.getByText(/openai \/ first/)).toContainText(
          "anthropic / backup",
        );
        await checkbox.check();
        await options.locator("summary").click();
        await expect(options.locator("summary")).toContainText(
          zh ? "已启用 AI 图片" : "AI images on",
        );
        await options.locator("summary").click();
        await checkbox.uncheck();
      } else {
        await expect(options.getByRole("checkbox")).toHaveCount(0);
      }
      await page
        .getByRole("button", {
          name: zh ? "添加事项" : "Add item",
          exact: true,
        })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: zh ? "取消" : "Cancel", exact: true })
        .click();
      await page
        .locator(".home-switch")
        .getByRole("button", { name: zh ? "笔记" : "Notes", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: zh ? "导入笔记" : "Import note",
          exact: true,
        }),
      ).toBeEnabled();
      await expect(
        page.locator(".notes-workspace .import-options"),
      ).not.toHaveAttribute("open", "");
      expect(
        (await page.locator(".notes-workspace .capture-card").boundingBox())!
          .height,
      ).toBeLessThan(280);
      await page.locator(".notes-workspace .import-options summary").click();
      if (ai)
        await expect(
          page.locator(".notes-workspace").getByRole("checkbox"),
        ).not.toBeChecked();
    });
  }
}
