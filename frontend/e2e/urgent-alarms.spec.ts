import { expect, test, type Page } from "@playwright/test";

test.use({ timezoneId: "Asia/Shanghai" });

async function login(page: Page, language = "en") {
  await page.clock.setFixedTime(new Date("2099-11-09T13:33:00+08:00"));
  await page.addInitScript(
    (language) => localStorage.setItem("mewmo:language", language),
    language,
  );
  await page.goto("/");
  await page
    .getByLabel(language === "en" ? "Username" : "用户名", { exact: true })
    .fill("admin");
  await page
    .getByLabel(language === "en" ? "Your password" : "密码")
    .fill("mewmo-local-test");
  await page
    .getByRole("button", {
      name: language === "en" ? "Sign in" : "登录",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: language === "en" ? "Overview" : "首页",
    }),
  ).toBeVisible();
}
async function draft(page: Page, language = "en") {
  await page
    .getByLabel(
      language === "en" ? "Natural language input" : "用自然语言添加事项",
    )
    .fill("Turn off gas in 5 minutes");
  await page
    .getByRole("button", {
      name: language === "en" ? "Preview draft" : "预览草稿",
    })
    .click();
  return page.getByRole("dialog");
}

// UI contract fake only. Real native bridge behavior is type-checked separately;
// actual sound, system authorization, and lock-screen presentation require an iPhone.
async function nativeUI(page: Page, mode = "success") {
  await page.addInitScript(
    (mode) => Object.assign(window, { alarmMode: mode, alarmCalls: [] }),
    mode,
  );
  await page.route(/\/src\/alarms\.ts(?:\?.*)?$/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
      let state = {available:true,authorization:"notDetermined",enabled:false,states:{}};
      const listeners = new Set();
      const emit = () => { state = {...state}; listeners.forEach(fn=>fn()); return state; };
      export const alarmSnapshot = () => state;
      export const alarmEpoch = () => 1;
      export const alarmRevision = () => 1;
      export const subscribeAlarms = fn => {listeners.add(fn);return ()=>listeners.delete(fn);};
      export const bindAlarmAccount = async () => emit();
      export const disableAlarms = async () => { state.enabled=false;state.states={};return emit(); };
      export const authorizeAlarms = async () => {
        window.alarmCalls.push({kind:"authorize"});
        if(window.alarmMode==="denied") throw Error("Allow alarms in iPhone Settings, or turn off Urgent alarm.");
        state.enabled=true;state.authorization="authorized";return emit();
      };
      export const syncAlarms = async (items,options={}) => {
        window.alarmCalls.push({kind:"sync",items,options});
        for(const item of items) {
          state.states[item.id] = item.urgent && item.status==="open"
            ? window.alarmMode==="failed" ? "failed" : "scheduled" : "cancelled";
        }
        return emit();
      };
      export const alarmMessage = item => state.states[item.id]==="failed"
        ? "Could not schedule the alarm. Ordinary notifications are unchanged."
        : item.status!=="open" ? "No urgent alarm needed for this item." : "Alarm scheduled on this iPhone.";
    `,
    }),
  );
}

for (const language of ["en", "zh-CN"]) {
  test(`urgent defaults off; web fallback is explicit (${language})`, async ({
    page,
  }) => {
    await login(page, language);
    const before = await page.request.get("/api/items").then((r) => r.json());
    let dialog = await draft(page, language);
    const urgent = language === "en" ? "Urgent alarm" : "紧急闹钟";
    await expect(
      dialog.getByRole("checkbox", { name: urgent, exact: true }),
    ).not.toBeChecked();
    await dialog.getByRole("checkbox", { name: urgent, exact: true }).check();
    await expect(
      dialog.getByText(language === "en" ? /Requires iOS 26/ : /需要 iOS 26/),
    ).toBeVisible();
    expect(
      await page.request.get("/api/items").then((r) => r.json()),
    ).toHaveLength(before.length);
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/items") && r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", {
        name: language === "en" ? "Confirm & save" : "确认并保存",
      })
      .click();
    const item = await (await response).json();
    expect(item.urgent).toBe(true);
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("status")).toContainText(
      language === "en" ? "ordinary notifications only" : "仅使用普通通知",
    );
    await expect(
      dialog.getByRole("button", {
        name: language === "en" ? "Schedule alarm" : "设置闹钟",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 844 });
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await dialog
      .getByRole("button", {
        name: language === "en" ? "Edit item" : "编辑事项",
      })
      .click();
    await expect(
      page.getByRole("checkbox", { name: urgent, exact: true }),
    ).toBeChecked();
    await page.getByRole("checkbox", { name: urgent, exact: true }).uncheck();
    await page
      .getByRole("button", {
        name: language === "en" ? "Save changes" : "保存修改",
      })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(
      (await page.request.get(`/api/items/${item.id}`).then((r) => r.json()))
        .urgent,
    ).toBe(false);
    await page.request.delete(`/api/items/${item.id}`);
  });

  test(`native alarm status and completion are distinct from push (${language})`, async ({
    page,
  }) => {
    await nativeUI(page);
    await login(page, language);
    const dialog = await draft(page, language);
    await dialog
      .getByRole("checkbox", {
        name: language === "en" ? "Urgent alarm" : "紧急闹钟",
        exact: true,
      })
      .check();
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/items") && r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", {
        name: language === "en" ? "Confirm & save" : "确认并保存",
      })
      .click();
    const item = await (await response).json();
    await expect(page.getByRole("dialog").getByRole("status")).toHaveText(
      language === "en"
        ? "Alarm scheduled on this iPhone."
        : "已在此 iPhone 上设置闹钟。",
    );
    const rows = await page.request
      .get(`/api/items/${item.id}/reminders`)
      .then((r) => r.json());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    await page
      .getByRole("button", {
        name: language === "en" ? "Mark complete" : "标记为已完成",
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(
      await page.evaluate(
        (id) =>
          (window as any).alarmCalls.some(
            (call: any) =>
              call.kind === "sync" &&
              call.items.some(
                (item: any) => item.id === id && item.status === "completed",
              ),
          ),
        item.id,
      ),
    ).toBe(true);
    expect(
      (
        await page.request
          .get(`/api/items/${item.id}/reminders`)
          .then((r) => r.json())
      )[0].status,
    ).toBe("cancelled");
    await page.request.delete(`/api/items/${item.id}`);
  });
}

test("denied native permission leaves the draft unsaved", async ({ page }) => {
  await nativeUI(page, "denied");
  await login(page);
  const before = await page.request.get("/api/items").then((r) => r.json());
  const dialog = await draft(page);
  await dialog
    .getByRole("checkbox", { name: "Urgent alarm", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Confirm & save" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Allow alarms in iPhone Settings",
  );
  expect(
    await page.request.get("/api/items").then((r) => r.json()),
  ).toHaveLength(before.length);
  await expect(
    dialog.getByRole("checkbox", { name: "Urgent alarm", exact: true }),
  ).toBeChecked();
});

test("failed scheduling does not duplicate saved items; retry loads the latest time", async ({
  page,
}) => {
  await nativeUI(page, "failed");
  await login(page);
  const before = await page.request.get("/api/items").then((r) => r.json());
  const dialog = await draft(page);
  await dialog
    .getByRole("checkbox", { name: "Urgent alarm", exact: true })
    .check();
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/items") && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Confirm & save" }).click();
  const item = await (await response).json();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Could not schedule",
  );
  expect(
    await page.request.get("/api/items").then((r) => r.json()),
  ).toHaveLength(before.length + 1);
  await page.request.put(`/api/items/${item.id}`, {
    data: {
      ...item,
      confirmed: true,
      local_date: "2099-11-09",
      due_time: "14:00",
    },
  });
  await page.evaluate(() => {
    (window as any).alarmMode = "success";
  });
  await page
    .getByRole("button", { name: "Schedule alarm", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText(
    "Alarm scheduled on this iPhone.",
  );
  await expect(page.getByRole("dialog").locator(".date-preview")).toContainText(
    "14:00",
  );
  const calls = await page.evaluate(() => (window as any).alarmCalls);
  expect(
    calls
      .filter((call: any) => call.kind === "sync" && call.options.force)
      .at(-1).items[0].due_time,
  ).toBe("14:00");
  expect(
    await page.request.get("/api/items").then((r) => r.json()),
  ).toHaveLength(before.length + 1);
  await page.request.delete(`/api/items/${item.id}`);
});
