import { expect, test, type Page } from "@playwright/test";
import { Buffer } from "node:buffer";
import type { Note, NoteDraft, NoteResults } from "../src/types";

const importRoute = /\/api\/notes\/drafts\/file(?:\?.*)?$/;
const draft: NoteDraft = {
  title: "Floor dimensions",
  body: "Living room: 12500 mm by 6400 mm.\nMeasured 2026-11-11.",
  source: "file",
  interpretation: "local",
  warnings: [
    "Review the imported text. OCR can make mistakes. The original file has been discarded.",
  ],
  duplicates: [],
};
const upload = {
  name: "floor.png",
  mimeType: "image/png",
  buffer: Buffer.from("mock OCR input"),
};

async function setup(page: Page, language = "en") {
  await page.addInitScript(
    (language) => localStorage.setItem("mewmo:language", language),
    language,
  );
  await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "mewmo-local-test" },
  });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: language === "en" ? "Notes" : "笔记",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: language === "en" ? "Import note" : "导入笔记",
      exact: true,
    }),
  ).toBeEnabled();
}
async function choose(page: Page, zh = false) {
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: zh ? "导入笔记" : "Import note", exact: true })
    .click();
  await (await chooser).setFiles(upload);
}
async function notes(page: Page): Promise<NoteResults> {
  return page.request.get("/api/notes").then((r) => r.json());
}
async function remove(page: Page, note: Note) {
  await page.request.delete(`/api/notes/${note.id}?version=${note.version}`);
}

for (const language of ["en", "zh-CN"]) {
  const zh = language !== "en";
  test(`note import reviews, cancels, edits, and saves without reminders (${language})`, async ({
    page,
  }) => {
    await page.route(importRoute, (route) => route.fulfill({ json: draft }));
    await setup(page, language);
    const before = await notes(page);
    const items = await page.request.get("/api/items").then((r) => r.json());
    await page
      .getByLabel(zh ? "笔记内容" : "Note text")
      .fill("Keep my typed draft");
    await choose(page, zh);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(zh ? "笔记内容" : "Note text")).toHaveValue(
      draft.body,
    );
    await expect(
      dialog.locator('input[type="date"], input[type="time"]'),
    ).toHaveCount(0);
    await expect(
      dialog.getByText(
        zh ? "只有确认后才会保存。" : "Nothing is saved until you confirm.",
      ),
    ).toBeVisible();
    expect((await notes(page)).total).toBe(before.total);
    await dialog
      .getByRole("button", { name: zh ? "取消" : "Cancel", exact: true })
      .click();
    await expect(page.getByLabel(zh ? "笔记内容" : "Note text")).toHaveValue(
      "Keep my typed draft",
    );
    await choose(page, zh);
    await dialog
      .getByLabel(zh ? "标题" : "Title", { exact: true })
      .fill("Imported floor information");
    await dialog
      .getByLabel(zh ? "笔记内容" : "Note text")
      .fill(draft.body + "\nReviewed.");
    const saved = page.waitForResponse(
      (r) => r.url().endsWith("/api/notes") && r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: zh ? "确认并保存" : "Confirm & save" })
      .click();
    const note: Note = await (await saved).json();
    try {
      await expect(dialog).not.toBeVisible();
      expect(note.body).toBe(draft.body + "\nReviewed.");
      expect((await notes(page)).total).toBe(before.total + 1);
      expect(
        await page.request.get("/api/items").then((r) => r.json()),
      ).toEqual(items);
      await page.locator(".note-card").filter({ hasText: note.title }).click();
      await expect(dialog.locator(".note-body")).toHaveText(note.body);
    } finally {
      await remove(page, note);
    }
  });

  test(`note import controls and warnings fit small screens (${language})`, async ({
    page,
  }, testInfo) => {
    await page.route(importRoute, (route) =>
      route.fulfill({
        json: {
          ...draft,
          warnings: [
            ...draft.warnings,
            "This note exceeds 10,000 characters. Only the first part is included; import the rest separately.",
            "Possible duplicate: a saved note has the same text.",
          ],
          duplicates: ["existing-note"],
        },
      }),
    );
    await setup(page, language);
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const buttons = page.locator(".notes-workspace .capture-actions button");
      const boxes = await buttons.evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { y: rect.y, height: rect.height, right: rect.right };
        }),
      );
      expect(boxes).toHaveLength(2);
      expect(boxes[0].y).toBeCloseTo(boxes[1].y);
      expect(boxes.every((box) => box.height >= 44 && box.right <= width)).toBe(
        true,
      );
    }
    await page.setViewportSize({ width: 320, height: 844 });
    await choose(page, zh);
    const dialog = page.getByRole("dialog");
    await expect(
      dialog
        .getByRole("status")
        .filter({ hasText: zh ? "可能重复" : "Possible duplicate" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("status").filter({ hasText: "10,000" }),
    ).toBeVisible();
    await dialog
      .getByText(zh ? "识别详情" : "Extraction details", { exact: true })
      .click();
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`note-import-${language}.png`),
      fullPage: true,
    });
  });
}

test("unreadable note import offers manual entry and same-file retry", async ({
  page,
}) => {
  await setup(page);
  const before = await notes(page);
  await choose(page);
  await expect(page.locator(".import-error")).toBeVisible();
  await page.getByRole("button", { name: "Enter manually" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Review note" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.route(importRoute, (route) => route.fulfill({ json: draft }));
  await choose(page);
  await expect(dialog.getByLabel("Note text")).toHaveValue(draft.body);
  expect((await notes(page)).total).toBe(before.total);
});

test("note image consent follows model chain and resets after each attempt", async ({
  page,
}) => {
  await page.route("**/api/model-settings", (route) =>
    route.fulfill({
      json: {
        available: true,
        enabled: true,
        allow_images: true,
        provider: "openai",
        revision: 42,
        image_chain_token: "chain-consent",
        models: [
          { provider: "openai", model: "first" },
          { provider: "anthropic", model: "backup" },
        ],
      },
    }),
  );
  await setup(page);
  const requests: URL[] = [];
  await page.route(importRoute, (route) => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ json: draft });
  });
  const checkbox = page.locator(".notes-workspace input[type=checkbox]");
  await expect(checkbox).not.toBeChecked();
  await expect(
    page.getByText("Tried in order: openai / first → anthropic / backup"),
  ).toBeVisible();
  await choose(page);
  expect(requests[0].searchParams.has("use_image_ai")).toBe(false);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await checkbox.check();
  await choose(page);
  expect(Object.fromEntries(requests[1].searchParams)).toEqual({
    use_image_ai: "true",
    image_provider: "openai",
    image_revision: "42",
    image_chain: "chain-consent",
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await page.getByRole("button", { name: "Find notes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import note" })).toHaveCount(
    0,
  );
  await expect(checkbox).toHaveCount(0);
  await page.getByRole("button", { name: "Write a note", exact: true }).click();
  await expect(checkbox).not.toBeChecked();
});

test("leaving Notes ignores an in-flight import and preserves no private draft", async ({
  page,
}) => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route(importRoute, async (route) => {
    await pending;
    await route.fulfill({ json: draft });
  });
  await setup(page);
  const request = page.waitForRequest(importRoute);
  await choose(page);
  await request;
  await expect(
    page.getByRole("button", { name: "Import note" }),
  ).toBeDisabled();
  const response = page.waitForResponse(importRoute);
  await page
    .locator(".home-switch")
    .getByRole("button", { name: "Reminders", exact: true })
    .click();
  finish();
  await response;
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import note" })).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Note text")).toHaveValue("");
});

test("note import rejects oversized uploads before sending and accepts drop", async ({
  page,
}) => {
  await setup(page);
  const requests: string[] = [];
  await page.route(importRoute, (route) => {
    requests.push(route.request().url());
    return route.fulfill({ json: draft });
  });
  await page.locator(".notes-workspace input[type=file]").setInputFiles({
    name: "too-large.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(12 * 1024 * 1024 + 1),
  });
  await expect(page.locator(".import-error")).toContainText("12 MB");
  expect(requests).toHaveLength(0);
  const dataTransfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(
      new File(["mock OCR input"], "floor.png", { type: "image/png" }),
    );
    return data;
  });
  await page
    .locator(".notes-workspace .capture-card")
    .dispatchEvent("drop", { dataTransfer });
  await expect(page.getByRole("dialog").getByLabel("Note text")).toHaveValue(
    draft.body,
  );
  expect(requests).toHaveLength(1);
});
