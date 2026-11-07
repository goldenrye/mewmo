import { expect, test, type Page } from "@playwright/test";

type SpeechTest = {
  starts: number;
  aborts: number;
  language: string;
  say(text: string): void;
  fail(): void;
};
async function setup(page: Page, language = "en", ai = false) {
  await page.addInitScript((language) => {
    localStorage.setItem("mewmo:language", language);
    let active: FakeSpeech;
    const control: SpeechTest = {
      starts: 0,
      aborts: 0,
      language: "",
      say(text) {
        active.onresult?.({ results: [[{ transcript: text }]] });
      },
      fail() {
        active.onerror?.({ error: "not-allowed" });
      },
    };
    class FakeSpeech {
      lang = "";
      onstart?: () => void;
      onend?: () => void;
      onresult?: (event: { results: { transcript: string }[][] }) => void;
      onerror?: (event: { error: string }) => void;
      start() {
        active = this;
        control.starts++;
        control.language = this.lang;
        this.onstart?.();
      }
      stop() {
        this.onend?.();
      }
      abort() {
        control.aborts++;
      }
    }
    Object.assign(window, {
      SpeechRecognition: FakeSpeech,
      speechTest: control,
    });
  }, language);
  await page.route("**/api/model-settings", (route) =>
    route.fulfill({
      json: {
        available: true,
        provider: "openai",
        model: "example",
        has_key: ai,
        enabled: ai,
        allow_images: false,
      },
    }),
  );
  await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "mewmo-local-test" },
  });
  await page.goto("/");
}
async function say(page: Page, text: string) {
  await page.evaluate(
    (text) =>
      (window as unknown as { speechTest: SpeechTest }).speechTest.say(text),
    text,
  );
}
async function stats(page: Page) {
  return page.evaluate(() => {
    const { starts, aborts, language } = (
      window as unknown as { speechTest: SpeechTest }
    ).speechTest;
    return { starts, aborts, language };
  });
}
async function navigate(page: Page, name: string) {
  await page
    .getByRole("button", { name, exact: true })
    .filter({ visible: true })
    .click();
}

test("Chinese speech becomes an editable reminder and saves only after confirmation", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-06T12:00:00"));
  await setup(page, "zh-CN");
  const before = await page.request.get("/api/items").then((r) => r.json());
  await page.getByRole("button", { name: "通过语音添加提醒" }).click();
  expect((await stats(page)).starts).toBe(0);
  await expect(page.getByText(/系统语音服务可能在线处理音频/)).toBeVisible();
  await page.getByRole("button", { name: "开始聆听" }).click();
  expect((await stats(page)).language).toBe("zh-CN");
  await say(page, "后天9点");
  await say(page, "后天9点有医生预约");
  await expect(page.getByLabel("用自然语言添加事项")).toHaveValue(
    "后天9点有医生预约",
  );
  await expect(page.getByRole("button", { name: "预览草稿" })).toBeDisabled();
  await page.getByRole("button", { name: "停止聆听" }).click();
  await expect(page.getByLabel("用自然语言添加事项")).toHaveValue(
    "后天9点有医生预约",
  );
  expect(await page.request.get("/api/items").then((r) => r.json())).toEqual(
    before,
  );
  await page.getByRole("button", { name: "预览草稿" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("标题", { exact: true })).toHaveValue(
    "医生预约",
  );
  await expect(dialog.locator(".date-preview")).toContainText("2026年11月8日");
  await expect(dialog.locator(".date-preview")).toContainText("星期日");
  await expect(dialog.locator(".date-preview")).toContainText("09:00");
  expect(await page.request.get("/api/items").then((r) => r.json())).toEqual(
    before,
  );
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/items") && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "确认并保存" }).click();
  const saved = await response;
  expect(saved.status()).toBe(201);
  const item = await saved.json();
  try {
    expect(item.due_date).toBe("2026-11-08");
  } finally {
    await page.request.delete(`/api/items/${item.id}`);
  }
});

test("opening audio clears typed input and cancellation discards speech", async ({
  page,
}) => {
  await setup(page);
  await page.getByLabel("Natural language input").fill("Keep my original text");
  await page.getByRole("button", { name: "Add a reminder by audio" }).click();
  await expect(page.getByLabel("Natural language input")).toHaveValue("");
  await page.getByRole("button", { name: "Start listening" }).click();
  await page.evaluate(() =>
    (window as unknown as { speechTest: SpeechTest }).speechTest.fail(),
  );
  await expect(page.getByRole("alert")).toContainText("permission was denied");
  await page.getByRole("button", { name: "Start listening" }).click();
  await say(page, "This will be cancelled");
  await page.getByRole("button", { name: "Cancel voice input" }).click();
  await expect(page.getByLabel("Natural language input")).toHaveValue("");
  await expect(page.getByLabel("Natural language input")).toBeEditable();
  expect((await stats(page)).aborts).toBe(2);
});

test("AI interpretation uses the existing text endpoint only after explicit preview", async ({
  page,
}) => {
  await setup(page, "en", true);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/drafts/text", async (route) => {
    const body = route.request().postDataJSON();
    bodies.push(body);
    await route.fulfill({
      json: {
        ...body,
        title: "Dentist",
        kind: "appointment",
        payee: null,
        amount: null,
        currency: null,
        due_date: "2099-11-08",
        due_time: "09:00",
        status: "open",
        account_last4: null,
        rules: [],
        source: "text",
        uncertain: [],
        duplicates: [],
        warnings: [
          "AI suggested draft fields. Review them carefully; nothing has been saved.",
        ],
      },
    });
  });
  await page.getByRole("button", { name: "Add a reminder by audio" }).click();
  await expect(
    page.getByText("AI helps interpret your text when you preview."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start listening" }).click();
  await say(page, "Dentist tomorrow at nine");
  await page.getByRole("button", { name: "Stop listening" }).click();
  await page
    .getByLabel("Natural language input", { exact: true })
    .fill("Dentist tomorrow at 9am");
  expect(bodies).toHaveLength(0);
  await page.getByRole("button", { name: "Preview draft" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "AI suggested draft fields",
  );
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    text: "Dentist tomorrow at 9am",
    timezone: expect.any(String),
    local_date: expect.any(String),
  });
  expect(Object.keys(bodies[0]).sort()).toEqual([
    "local_date",
    "text",
    "timezone",
  ]);
});

test("navigation stops recognition and narrow controls remain usable", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole("button", { name: "Add a reminder by audio" }).click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await say(page, "Unsaved private speech");
  const box = await page.getByLabel("Natural language input").boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(56);
  expect(box!.y + box!.height).toBeLessThan(600);
  await expect(page.locator(".voice-panel textarea")).toHaveCount(0);
  const audioButton = page.getByRole("button", {
    name: "Add a reminder by audio",
  });
  const importButton = page.getByRole("button", { name: "Import a bill" });
  expect(
    await audioButton.evaluate((node) => getComputedStyle(node).fontSize),
  ).toBe(
    await importButton.evaluate((node) => getComputedStyle(node).fontSize),
  );
  expect((await audioButton.boundingBox())!.height).toBe(
    (await importButton.boundingBox())!.height,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await navigate(page, "Calendar");
  expect((await stats(page)).aborts).toBe(1);
  await navigate(page, "Overview");
  await expect(page.getByLabel("Natural language input")).toHaveValue("");
});

test("unsupported browsers keep manual capture available without prompting", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() =>
    Object.assign(window, {
      SpeechRecognition: undefined,
      webkitSpeechRecognition: undefined,
    }),
  );
  await page.getByRole("button", { name: "Add a reminder by audio" }).click();
  await expect(
    page.getByText(/Speech recognition is unavailable here/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start listening" }),
  ).toHaveCount(0);
  await page
    .getByLabel("Natural language input")
    .fill("Dentist tomorrow at 9am");
  await expect(
    page.getByRole("button", { name: "Preview draft" }),
  ).toBeEnabled();
});
