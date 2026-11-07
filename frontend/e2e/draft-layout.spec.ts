import { expect, test } from "@playwright/test";

for (const language of ["en", "zh-CN"]) {
  test(`draft review keeps important warnings visible without overlapping fields (${language})`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(
      (value) => localStorage.setItem("mewmo:language", value),
      language,
    );
    await page.request.post("/api/auth/login", {
      data: { username: "admin", password: "mewmo-local-test" },
    });
    await page.route("**/api/drafts/text", (route) =>
      route.fulfill({
        json: {
          title: "Boost Mobile",
          payee: "Boost Mobile",
          kind: "bill",
          amount: "61.78",
          currency: "USD",
          account_last4: null,
          due_date: "2026-11-12",
          due_time: "09:00",
          timezone: "America/Los_Angeles",
          status: "open",
          source: "file",
          duplicates: ["existing-bill"],
          uncertain: ["amount", "currency", "due_date", "due_time"],
          rules: [
            { mode: "before", minutes: 1440, days: 0, at: "09:00" },
            { mode: "day", minutes: 0, days: 1, at: "09:00" },
          ],
          warnings: [
            "AI suggested draft fields. Review them carefully; nothing has been saved.",
            "Review every field. OCR can make mistakes. The original file has been discarded.",
            "AI assistance was unavailable. Review the local draft or enter missing fields manually.",
            "Possible duplicate: an existing bill has a matching amount and payee or due date.",
          ],
        },
      }),
    );
    await page.goto("/");
    await page.locator(".capture-input textarea").fill("Review this bill");
    await page.locator(".parse-button").click();
    const dialog = page.getByRole("dialog");
    const notes = dialog.locator(".extraction-notes");
    await expect(notes).not.toHaveAttribute("open");
    await expect(dialog.locator(".draft-source")).toBeVisible();
    await expect(
      dialog
        .locator(".notice")
        .filter({
          hasText:
            language === "en"
              ? "AI assistance was unavailable"
              : "AI 辅助暂不可用",
        }),
    ).toBeVisible();
    await expect(dialog.locator(".checkbox-label.notice")).toBeVisible();
    await expect(dialog.locator(".date-preview")).toContainText("2026");
    await expect(dialog.locator(".date-preview")).toContainText("09:00");
    await dialog.locator(".rules summary").click();
    for (const width of [320, 390, 520, 768]) {
      await page.setViewportSize({ width, height: 850 });
      const failures = await dialog.evaluate((root) => {
        const controls = Array.from(
          root.querySelectorAll<HTMLElement>(
            "input:not([type=checkbox]), select, .rule-row button",
          ),
        ).filter((node) => node.getClientRects().length);
        const bad: string[] = [];
        for (const [index, control] of controls.entries()) {
          const a = control.getBoundingClientRect();
          const parent = control.parentElement!.getBoundingClientRect();
          if (a.left < parent.left - 1 || a.right > parent.right + 1)
            bad.push(
              `Overflow: ${control.getAttribute("aria-label") || control.outerHTML}`,
            );
          for (const other of controls.slice(index + 1)) {
            const b = other.getBoundingClientRect();
            if (
              Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
            )
              bad.push("Overlapping controls");
          }
        }
        if (root.scrollWidth > root.clientWidth) bad.push("Dialog overflow");
        return bad;
      });
      expect(failures, `width ${width}`).toEqual([]);
    }
    await notes.locator("summary").click();
    await expect(notes.locator("p")).toHaveCount(2);
    await expect(notes.locator("p").first()).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`draft-${language}.png`),
      fullPage: true,
    });
    await dialog.locator(".dialog-footer button[type=button]").click();
  });
}
