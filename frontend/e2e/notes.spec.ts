import { expect, test, type Page } from "@playwright/test";
import type { Note, NoteResults } from "../src/types";

async function setup(page: Page, language = "en") {
  await page.addInitScript((language) => {
    localStorage.setItem("mewmo:language", language);
    let active: FakeSpeech;
    class FakeSpeech {
      onstart?: () => void;
      onend?: () => void;
      onresult?: (event: { results: { transcript: string }[][] }) => void;
      start() {
        active = this;
        this.onstart?.();
      }
      stop() {
        this.onend?.();
      }
      abort() {
        (window as unknown as { aborts: number }).aborts++;
      }
    }
    Object.assign(window, {
      SpeechRecognition: FakeSpeech,
      aborts: 0,
      say: (text: string) =>
        active.onresult?.({ results: [[{ transcript: text }]] }),
    });
  }, language);
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
    page.getByRole("heading", {
      name: language === "en" ? /Your notes/ : /我的笔记/,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(language === "en" ? "Loading..." : "加载中…", {
      exact: true,
    }),
  ).not.toBeVisible();
}
async function say(page: Page, text: string) {
  await page.evaluate(
    (text) => (window as unknown as { say: (value: string) => void }).say(text),
    text,
  );
}
async function list(page: Page) {
  return page.request
    .get("/api/notes")
    .then((response) => response.json()) as Promise<NoteResults>;
}
async function seed(
  page: Page,
  title = "Floor size",
  body = "Living room floor: 12500 mm by 6400 mm.",
) {
  const response = await page.request.post("/api/notes", {
    data: { title, body, confirmed: true },
  });
  expect(response.status()).toBe(201);
  return response.json() as Promise<Note>;
}
async function remove(page: Page, id: string) {
  const response = await page.request.get(`/api/notes/${id}`);
  if (response.ok()) {
    const note = await response.json();
    await page.request.delete(`/api/notes/${id}?version=${note.version}`);
  }
}

for (const lang of ["en", "zh-CN"]) {
  const zh = lang === "zh-CN";
  test(`audio note creation and contextual retrieval (${lang})`, async ({
    page,
  }) => {
    await setup(page, lang);
    const before = await list(page);
    const content = zh
      ? "客厅地板长12500毫米，宽6400毫米。"
      : "Living room floor: 12500 mm by 6400 mm.";
    await page
      .getByRole("button", {
        name: zh ? "通过语音添加笔记" : "Add a note by audio",
      })
      .click();
    await page
      .getByRole("button", { name: zh ? "开始聆听" : "Start listening" })
      .click();
    await say(page, content);
    await expect(
      page.getByRole("button", { name: zh ? "预览笔记" : "Preview note" }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: zh ? "停止聆听" : "Stop listening" })
      .click();
    expect(await list(page)).toEqual(before);
    await page
      .getByRole("button", { name: zh ? "预览笔记" : "Preview note" })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.locator('input[type="date"], input[type="time"]'),
    ).toHaveCount(0);
    await expect(dialog.getByLabel(zh ? "笔记内容" : "Note text")).toHaveValue(
      content,
    );
    await dialog
      .getByLabel(zh ? "标题" : "Title", { exact: true })
      .fill(zh ? "客厅地板" : "Living room floor");
    expect(await list(page)).toEqual(before);
    const saved = page.waitForResponse(
      (r) => r.url().endsWith("/api/notes") && r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: zh ? "确认并保存" : "Confirm & save" })
      .click();
    const note = await (await saved).json();
    try {
      await expect(dialog).not.toBeVisible();
      await page
        .getByRole("button", {
          name: zh ? "查找笔记" : "Find notes",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: zh ? "通过语音查找笔记" : "Find notes by audio",
        })
        .click();
      await page
        .getByRole("button", { name: zh ? "开始聆听" : "Start listening" })
        .click();
      await say(
        page,
        zh ? "找一下关于地板的笔记" : "the notes about the floor",
      );
      await page
        .getByRole("button", { name: zh ? "停止聆听" : "Stop listening" })
        .click();
      await page
        .getByRole("button", {
          name: zh ? "搜索笔记" : "Search notes",
          exact: true,
        })
        .click();
      const card = page.locator(".note-card").filter({ hasText: note.title });
      await expect(card).toBeVisible();
      await card.click();
      await expect(page.getByRole("dialog").locator(".note-body")).toHaveText(
        content,
      );
      expect((await list(page)).total).toBe(before.total + 1);
      expect(
        await page.evaluate(() => JSON.stringify(localStorage)),
      ).not.toContain("12500");
    } finally {
      await remove(page, note.id);
    }
  });
}

test("editing a note and creating a reminder preserve independent data", async ({
  page,
}) => {
  await setup(page);
  const note = await seed(page);
  let itemId: string | undefined;
  try {
    await page.reload();
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await page.locator(".note-card").filter({ hasText: note.title }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Edit note", exact: true })
      .click();
    await dialog
      .getByLabel("Note text")
      .fill("Updated floor area: 80 square metres.");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).not.toBeVisible();
    await page.locator(".note-card").filter({ hasText: note.title }).click();
    await expect(dialog.locator(".note-body")).toHaveText(
      "Updated floor area: 80 square metres.",
    );
    await dialog
      .getByRole("button", { name: "Add reminder", exact: true })
      .click();
    await expect(dialog.getByLabel("Date", { exact: false })).toHaveValue("");
    await expect(
      dialog.getByLabel("Time", { exact: false }).first(),
    ).toHaveValue("");
    await dialog.locator('input[type="date"]').fill("2099-11-20");
    await dialog.locator('input[type="time"]').first().fill("19:15");
    const saved = page.waitForResponse(
      (r) => r.url().endsWith("/api/items") && r.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Confirm & save" }).click();
    const item = await (await saved).json();
    itemId = item.id;
    expect(item.title).toBe(note.title);
    await expect(dialog).not.toBeVisible();
    await page.locator(".note-card").filter({ hasText: note.title }).click();
    await dialog
      .getByRole("button", { name: "Delete note", exact: true })
      .click();
    await expect(
      dialog.getByText(
        "Delete this note? Reminders created from it will stay.",
      ),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Yes, delete note" }).click();
    await expect(dialog).not.toBeVisible();
    expect(
      (await page.request.get("/api/items").then((r) => r.json())).some(
        (row: { id: string }) => row.id === itemId,
      ),
    ).toBe(true);
  } finally {
    await remove(page, note.id);
    if (itemId) await page.request.delete(`/api/items/${itemId}`);
  }
});

test("switching capture modes cancels microphone and stale recognition", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "Add a note by audio" }).click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await say(page, "Unsaved note content");
  await page.getByRole("button", { name: "Find notes", exact: true }).click();
  expect(
    await page.evaluate(() => (window as unknown as { aborts: number }).aborts),
  ).toBe(1);
  await say(page, "Late transcript");
  await expect(
    page.getByRole("textbox", { name: "Search notes", exact: true }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "Write a note", exact: true }).click();
  await expect(page.getByLabel("Note text")).toHaveValue("");
  await page.getByRole("button", { name: "Add a note by audio" }).click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await say(page, "Another private transcript");
  await page
    .locator(".home-switch")
    .getByRole("button", { name: "Reminders", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as unknown as { aborts: number }).aborts),
  ).toBe(2);
  await expect(page.getByLabel("Natural language input")).toHaveValue("");
});

test("note search uses explicit consent and has an honest empty state", async ({
  page,
}) => {
  await page.route("**/api/model-settings", (route) =>
    route.fulfill({
      json: {
        available: true,
        enabled: true,
        has_key: true,
        model: "test",
        provider: "openai",
        allow_images: false,
      },
    }),
  );
  await setup(page);
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/notes/search", async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({
      json: { items: [], total: 0, mode: "local", warning: null },
    });
  });
  await page.getByRole("button", { name: "Find notes", exact: true }).click();
  await expect(
    page.getByLabel("Use AI to understand this search"),
  ).not.toBeChecked();
  await page
    .getByRole("textbox", { name: "Search notes", exact: true })
    .fill("the notes about the floor");
  expect(calls).toHaveLength(0);
  await page.getByRole("button", { name: "Search notes", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching notes" }),
  ).toBeVisible();
  expect(calls[0].use_ai).toBe(false);
  await page.getByLabel("Use AI to understand this search").check();
  await page.getByRole("button", { name: "Search notes", exact: true }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]).toEqual({
    query: "the notes about the floor",
    offset: 0,
    use_ai: true,
  });
});

test("notes fit narrow layouts and speech keeps the main text visible", async ({
  page,
}, testInfo) => {
  await setup(page);
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByLabel("Note text").fill("Floor dimensions ".repeat(30));
    await page.getByRole("button", { name: "Preview note" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    for (const field of await dialog.locator("input, textarea, button").all()) {
      const box = (await field.boundingBox())!;
      const parent = (await dialog.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(parent.x);
      expect(box.x + box.width).toBeLessThanOrEqual(parent.x + parent.width);
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole("button", { name: "Add a note by audio" }).click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await say(page, "Floor size is 20 square metres");
  const box = (await page.getByLabel("Note text").boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(56);
  expect(box.y + box.height).toBeLessThan(600);
  await page.screenshot({
    path: testInfo.outputPath("notes-recording.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel voice input" }).click();
});

test("failed saves retain draft text and cancellation never writes a note", async ({
  page,
}) => {
  await setup(page);
  const before = await list(page);
  await page.getByLabel("Note text").fill("Floor information to keep");
  await page.getByRole("button", { name: "Preview note" }).click();
  await page.route("**/api/notes", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 503,
          json: { detail: "Test service unavailable" },
        })
      : route.continue(),
  );
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Confirm & save" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Test service unavailable",
  );
  await expect(dialog.getByLabel("Note text")).toHaveValue(
    "Floor information to keep",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await list(page)).toEqual(before);
});

test("reopening after a concurrent edit fetches the latest note", async ({
  page,
}) => {
  await setup(page);
  const note = await seed(page);
  try {
    await page.reload();
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await page.locator(".note-card").filter({ hasText: note.title }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Edit note", exact: true })
      .click();
    await page.request.put(`/api/notes/${note.id}`, {
      data: {
        title: note.title,
        body: "Changed on another device",
        version: note.version,
        confirmed: true,
      },
    });
    await dialog.getByLabel("Note text").fill("Stale editor changes");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "changed on another device",
    );
    await dialog.getByRole("button", { name: "Close note" }).click();
    await page.locator(".note-card").filter({ hasText: note.title }).click();
    await expect(dialog.locator(".note-body")).toHaveText(
      "Changed on another device",
    );
  } finally {
    await remove(page, note.id);
  }
});

test("an account switch clears notes and unsaved private text", async ({
  page,
}) => {
  await setup(page);
  const note = await seed(
    page,
    "Private floor details",
    "Private text only for the first account",
  );
  try {
    await page.getByLabel("Note text").fill("Unsaved private text");
    const invitation = await page.request
      .post("/api/admin/invitations")
      .then((r) => r.json());
    const username = `notes-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const registered = await page.request.post("/api/auth/register", {
      data: {
        invite_token: new URLSearchParams(
          new URL(invitation.url).hash.slice(1),
        ).get("invite"),
        username,
        display_name: "Notes test",
        password: "browser-notes-test-password",
      },
    });
    expect(registered.status()).toBe(201);
    await page.reload();
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "No notes yet" }),
    ).toBeVisible();
    await expect(page.getByLabel("Note text")).toHaveValue("");
    await expect(page.getByText(note.title)).toHaveCount(0);
    await page.getByRole("button", { name: "Find notes", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Search notes", exact: true })
      .fill("floor");
    await page
      .getByRole("button", { name: "Search notes", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "No matching notes" }),
    ).toBeVisible();
  } finally {
    await page.request.post("/api/auth/login", {
      data: { username: "admin", password: "mewmo-local-test" },
    });
    await remove(page, note.id);
  }
});
