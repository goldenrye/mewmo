import { expect, test, type Page } from "@playwright/test";
import { holdSpeech } from "./speech-gesture";

type SpeechTest = {
  starts: number;
  aborts: number;
  language: string;
  deferStart: boolean;
  begin(): void;
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
      deferStart: false,
      begin() {
        active.onstart?.();
      },
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
        if (!control.deferStart) this.onstart?.();
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
    .dispatchEvent("click");
}

test("Chinese speech becomes an editable reminder and saves only after confirmation", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-06T12:00:00"));
  await setup(page, "zh-CN");
  const before = await page.request.get("/api/items").then((r) => r.json());
  await page.getByRole("button", { name: "语音输入" }).click();
  expect((await stats(page)).starts).toBe(0);
  await expect(page.getByText(/系统语音服务可能在线处理音频/)).toBeVisible();
  await holdSpeech(page, "按住说话");
  expect((await stats(page)).language).toBe("zh-CN");
  await say(page, "后天9点");
  await say(page, "后天9点有医生预约");
  await expect(page.getByLabel("用自然语言添加事项")).toHaveValue(
    "后天9点有医生预约",
  );
  await expect(page.getByRole("button", { name: "预览草稿" })).toBeDisabled();
  await page.mouse.up();
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
  await page.getByRole("button", { name: "Voice input" }).click();
  await expect(page.getByLabel("Natural language input")).toHaveValue("");
  await holdSpeech(page);
  await page.evaluate(() =>
    (window as unknown as { speechTest: SpeechTest }).speechTest.fail(),
  );
  await expect(page.getByRole("alert")).toContainText("permission was denied");
  await page.mouse.up();
  await holdSpeech(page);
  await say(page, "This will be cancelled");
  await page.keyboard.press("Escape");
  await page.mouse.up();
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
  await page.getByRole("button", { name: "Voice input" }).click();
  await expect(
    page.getByText("AI helps interpret your text when you preview."),
  ).toBeVisible();
  await holdSpeech(page);
  await say(page, "Dentist tomorrow at nine");
  await page.mouse.up();
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
    client_now: expect.any(String),
  });
  expect(Object.keys(bodies[0]).sort()).toEqual([
    "client_now",
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
  await page.getByRole("button", { name: "Voice input" }).click();
  await holdSpeech(page);
  await say(page, "Unsaved private speech");
  const box = await page.getByLabel("Natural language input").boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(56);
  expect(box!.y + box!.height).toBeLessThan(600);
  await expect(page.locator(".voice-panel textarea")).toHaveCount(0);
  const audioButton = page.getByRole("button", {
    name: "Voice input",
    exact: true,
  });
  const importButton = page.getByRole("button", { name: "Import reminder" });
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
  await page.mouse.up();
  expect((await stats(page)).aborts).toBe(1);
  await navigate(page, "Overview");
  await expect(page.getByLabel("Natural language input")).toHaveValue("");
});

for (const language of ["en", "zh-CN"]) {
  test(`compact capture actions stay on one line (${language})`, async ({
    page,
  }) => {
    await setup(page, language);
    const upload = page.getByRole("button", {
      name: language === "en" ? "Import reminder" : "导入提醒",
      exact: true,
    });
    const audio = page.getByRole("button", {
      name: language === "en" ? "Voice input" : "语音输入",
      exact: true,
    });
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(upload).toBeVisible();
      await expect(audio).toBeVisible();
      const left = (await upload.boundingBox())!;
      const right = (await audio.boundingBox())!;
      expect(left.y).toBeCloseTo(right.y, 0);
      expect(left.height).toBe(44);
      expect(right.height).toBe(44);
      expect(left.x + left.width).toBeLessThanOrEqual(right.x);
      expect(right.x + right.width).toBeLessThanOrEqual(width);
      expect(
        await page
          .locator(".capture-actions")
          .evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
    }
  });
}

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
  await page.getByRole("button", { name: "Voice input" }).click();
  await expect(
    page.getByText(/Speech recognition is unavailable here/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Hold to speak" })).toHaveCount(
    0,
  );
  await page
    .getByLabel("Natural language input")
    .fill("Dentist tomorrow at 9am");
  await expect(
    page.getByRole("button", { name: "Preview draft" }),
  ).toBeEnabled();
});

test("sliding up cancels, sliding back restores release-to-finish", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "Voice input" }).click();
  await expect(
    page.getByRole("button", { name: /Start listening|Stop listening/ }),
  ).toHaveCount(0);
  const point = await holdSpeech(page);
  const hold = page.getByRole("button", { name: "Hold to speak", exact: true });
  const position = await hold.boundingBox();
  await say(page, "Discard this reminder");
  await page.mouse.move(point.x, point.y - 90);
  await expect(hold).toHaveText("Release to cancel");
  await page.mouse.up();
  await expect(page.getByLabel("Natural language input")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Preview draft" }),
  ).toBeDisabled();
  expect((await stats(page)).aborts).toBe(1);

  await page.getByRole("button", { name: "Voice input" }).click();
  const next = await holdSpeech(page);
  await say(page, "Keep this reminder");
  await page.mouse.move(next.x, next.y - 90);
  await page.mouse.move(next.x, next.y);
  await expect(hold).toHaveText("Release to finish");
  expect(await hold.boundingBox()).toEqual(position);
  await page.mouse.up();
  await expect(page.getByLabel("Natural language input")).toHaveValue(
    "Keep this reminder",
  );
  await expect(
    page.getByRole("button", { name: "Preview draft" }),
  ).toBeEnabled();
});

test("release during microphone startup cancels and ignores delayed callbacks", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    (window as unknown as { speechTest: SpeechTest }).speechTest.deferStart =
      true;
  });
  await page.getByRole("button", { name: "Voice input" }).click();
  await holdSpeech(page);
  await expect(page.getByRole("status")).toContainText(
    "Starting microphone...",
  );
  await page.mouse.up();
  await page.evaluate(() =>
    (window as unknown as { speechTest: SpeechTest }).speechTest.begin(),
  );
  await say(page, "Late transcript must be discarded");
  await expect(page.getByLabel("Natural language input")).toHaveValue("");
  await expect(page.getByLabel("Natural language input")).toBeEditable();
  expect((await stats(page)).aborts).toBe(1);
});

for (const key of ["Space", "Enter"]) {
  test(`keyboard ${key} holds and releases without restarting speech`, async ({
    page,
  }) => {
    await setup(page);
    await page.getByRole("button", { name: "Voice input" }).click();
    const hold = page.getByRole("button", {
      name: "Hold to speak",
      exact: true,
    });
    await hold.focus();
    await page.keyboard.down(key);
    await say(page, "Keyboard reminder");
    await page.keyboard.up(key);
    await expect(page.getByLabel("Natural language input")).toHaveValue(
      "Keyboard reminder",
    );
    await expect(page.getByLabel("Natural language input")).toBeEditable();
    expect((await stats(page)).starts).toBe(1);
  });
}

test("assistive activation uses the same button to finish", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "Voice input" }).click();
  const hold = page.getByRole("button", { name: "Hold to speak", exact: true });
  await hold.dispatchEvent("click", { detail: 0 });
  await expect(hold).toHaveText("Tap to finish");
  await say(page, "Accessible reminder");
  await hold.dispatchEvent("click", { detail: 0 });
  await expect(page.getByLabel("Natural language input")).toHaveValue(
    "Accessible reminder",
  );
  expect((await stats(page)).starts).toBe(1);
});

test("actual touch hold and cancellation release recognition", async ({
  page,
}) => {
  await setup(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await page.getByRole("button", { name: "Voice input" }).click();
  const hold = page.getByRole("button", { name: "Hold to speak", exact: true });
  await hold.scrollIntoViewIfNeeded();
  const box = (await hold.boundingBox())!;
  const touchPoints = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints,
  });
  await say(page, "Touch reminder");
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(page.getByLabel("Natural language input")).toHaveValue(
    "Touch reminder",
  );

  await page.getByRole("button", { name: "Voice input" }).click();
  await hold.scrollIntoViewIfNeeded();
  const next = (await hold.boundingBox())!;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: next.x + next.width / 2, y: next.y + next.height / 2 }],
  });
  await say(page, "Cancelled touch");
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
  await expect(page.getByLabel("Natural language input")).toHaveValue("");
  await say(page, "Late touch result");
  await expect(page.getByLabel("Natural language input")).toHaveValue("");
  expect((await stats(page)).aborts).toBe(2);
  await cdp.detach();
});

test("the 60 second limit finishes even while the control is held", async ({
  page,
}) => {
  await page.clock.install();
  await setup(page);
  await page.getByRole("button", { name: "Voice input" }).click();
  await holdSpeech(page);
  await say(page, "Long reminder");
  await page.clock.runFor(60_000);
  await page.mouse.up();
  await expect(page.getByLabel("Natural language input")).toHaveValue(
    "Long reminder",
  );
  await expect(page.getByLabel("Natural language input")).toBeEditable();
  expect((await stats(page)).aborts).toBe(1);
});

test("losing focus cancels a held recording", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Voice input" }).click();
  await holdSpeech(page);
  await say(page, "Private interrupted reminder");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await say(page, "Late interrupted reminder");
  await expect(page.getByLabel("Natural language input")).toHaveValue("");
  await expect(page.getByLabel("Natural language input")).toBeEditable();
  expect((await stats(page)).aborts).toBe(1);
});
