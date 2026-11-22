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
      let owner = null;
      const listeners = new Set();
      const emit = () => {
        state = {...state};
        window.nativeAlarmState = structuredClone(state);
        listeners.forEach(fn=>fn()); return state;
      };
      export const alarmSnapshot = () => state;
      export const alarmEpoch = () => 1;
      export const alarmRevision = () => 1;
      export const subscribeAlarms = fn => {listeners.add(fn);return ()=>listeners.delete(fn);};
      export const bindAlarmAccount = async (userId, server="") => {
        const next = userId ? server+"#"+userId : null;
        window.alarmCalls.push({kind:"bind",owner:next});
        if(next!==owner || next===null) {state.enabled=false;state.states={};}
        owner=next; return emit();
      };
      export const suspendAlarmAccount = () => {window.alarmCalls.push({kind:"suspend"});};
      export const disableAlarms = async () => {
        window.alarmCalls.push({kind:"disable"});
        state.enabled=false;state.states={};return emit();
      };
      export const authorizeAlarms = async () => {
        window.alarmCalls.push({kind:"authorize"});
        if(window.alarmMode==="denied") throw Error("Allow alarms in iPhone Settings, or turn off Urgent alarm.");
        state.enabled=true;state.authorization="authorized";return emit();
      };
      export const syncAlarms = async (items,options={}) => {
        window.alarmCalls.push({kind:"sync",items,options});
        if(!state.enabled) return emit();
        for(const item of items) {
          state.states[item.id] = item.urgent && item.status==="open"
            ? window.alarmMode==="failed" ? "failed" : "scheduled" : "cancelled";
        }
        return emit();
      };
      export const alarmMessage = (item, snapshot, early=false) => early && new Date(item.due_at).getTime()-3600000<=Date.now()
        ? "No one-hour alarm scheduled: that time has already passed."
        : state.states[item.id]==="failed"
        ? "Could not schedule the alarm. Ordinary notifications are unchanged."
        : item.status!=="open" ? "No urgent alarm needed for this item." : "Alarm scheduled on this iPhone.";
    `,
    }),
  );
}

for (const language of ["en", "zh-CN"]) {
  for (const switchAccount of [false, true]) {
    test(`expiry preserves alarms; ${switchAccount ? "different" : "same"} account login applies ownership (${language})`, async ({
      page,
      request,
    }) => {
      const zh = language !== "en";
      let username = "admin";
      let password = "mewmo-local-test";
      await request.post("/api/auth/login", { data: { username, password } });
      if (switchAccount) {
        const invitation = await (
          await request.post("/api/admin/invitations")
        ).json();
        username = "alarm-" + crypto.randomUUID().slice(0, 8);
        password = "alarm-test-password";
        const registered = await request.post("/api/auth/register", {
          data: {
            username,
            password,
            display_name: "Alarm guest",
            invite_token: new URL(invitation.url).hash.slice("#invite=".length),
          },
        });
        expect(registered.status()).toBe(201);
      }
      await nativeUI(page);
      await login(page, language);
      const dialog = await draft(page, language);
      await dialog
        .getByRole("checkbox", {
          name: zh ? "紧急闹钟" : "Urgent alarm",
          exact: true,
        })
        .check();
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/items") && r.request().method() === "POST",
      );
      await dialog
        .getByRole("button", { name: zh ? "确认并保存" : "Confirm & save" })
        .click();
      const item = await (await response).json();
      try {
        await expect(
          page.locator('[data-alarm="due"]').getByRole("status"),
        ).toContainText(zh ? "已在此 iPhone" : "Alarm scheduled");
        await page
          .getByRole("button", { name: zh ? "关闭详情" : "Close details" })
          .click();
        const before = await page.evaluate(
          () => (window as any).nativeAlarmState,
        );
        expect(before.enabled).toBe(true);
        expect(before.states[item.id]).toBe("scheduled");
        await page.route("**/api/items*", (route) =>
          route.fulfill({
            status: 401,
            contentType: "application/json",
            body: '{"detail":"Please sign in"}',
          }),
        );
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(
          page.getByRole("heading", {
            name: zh ? "欢迎使用 Mewmo" : "Welcome to Mewmo",
          }),
        ).toBeVisible();
        expect(
          await page.evaluate(() => (window as any).nativeAlarmState),
        ).toEqual(before);
        expect(
          await page.evaluate(() =>
            (window as any).alarmCalls.some(
              (call: any) =>
                call.kind === "disable" ||
                (call.kind === "bind" && call.owner === null),
            ),
          ),
        ).toBe(false);
        expect(
          await page.evaluate(() =>
            (window as any).alarmCalls.some(
              (call: any) => call.kind === "suspend",
            ),
          ),
        ).toBe(true);
        await page.unroute("**/api/items*");
        await page
          .getByLabel(zh ? "用户名" : "Username", { exact: true })
          .fill(username);
        await page
          .getByLabel(zh ? "密码" : "Your password", { exact: true })
          .fill(password);
        await page
          .getByRole("button", { name: zh ? "登录" : "Sign in", exact: true })
          .click();
        await expect(
          page.getByRole("heading", {
            name: zh ? "首页" : "Overview",
            exact: true,
          }),
        ).toBeVisible();
        const after = await page.evaluate(
          () => (window as any).nativeAlarmState,
        );
        expect(after.enabled).toBe(!switchAccount);
        expect(after.states[item.id]).toBe(
          switchAccount ? undefined : "scheduled",
        );
        expect(
          await page.evaluate(
            () =>
              (window as any).alarmCalls.filter(
                (call: any) => call.kind === "authorize",
              ).length,
          ),
        ).toBe(1);
        await page
          .getByRole("button", { name: zh ? "设置" : "Settings", exact: true })
          .filter({ visible: true })
          .click();
        await page
          .getByRole("button", {
            name: zh ? "退出登录" : "Sign out",
            exact: true,
          })
          .filter({ visible: true })
          .last()
          .click();
        await expect(
          page.getByRole("heading", {
            name: zh ? "欢迎使用 Mewmo" : "Welcome to Mewmo",
          }),
        ).toBeVisible();
        expect(
          await page.evaluate(() => (window as any).nativeAlarmState.enabled),
        ).toBe(false);
        expect(
          await page.evaluate(() => (window as any).nativeAlarmState.states),
        ).toEqual({});
      } finally {
        await request.post("/api/auth/login", {
          data: { username: "admin", password: "mewmo-local-test" },
        });
        await request.delete(`/api/items/${item.id}`);
      }
    });
  }
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
    await expect(
      dialog.locator('[data-alarm="due"]').getByRole("status"),
    ).toContainText(
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
    await expect(
      page
        .getByRole("dialog")
        .locator('[data-alarm="due"]')
        .getByRole("status"),
    ).toHaveText(
      language === "en"
        ? "Alarm scheduled on this iPhone."
        : "已在此 iPhone 上设置闹钟。",
    );
    const rows = await page.request
      .get(`/api/items/${item.id}/reminders`)
      .then((r) => r.json());
    expect(rows).toHaveLength(4);
    expect(
      rows.every((row: { status: string }) => row.status === "pending"),
    ).toBe(true);
    await expect(
      page.locator('[data-alarm="early"]').getByRole("status"),
    ).toContainText(
      language === "en" ? "that time has already passed" : "该时间已过",
    );
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
  await expect(
    page.getByRole("dialog").locator('[data-alarm="due"]').getByRole("status"),
  ).toContainText("Could not schedule");
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
  await expect(
    page.getByRole("dialog").locator('[data-alarm="due"]').getByRole("status"),
  ).toHaveText("Alarm scheduled on this iPhone.");
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

for (const language of ["en", "zh-CN"]) {
  test(`urgent policy is automatic and both future alarm statuses are visible (${language})`, async ({
    page,
  }) => {
    const zh = language !== "en";
    await nativeUI(page);
    await login(page, language);
    await page
      .getByLabel(zh ? "用自然语言添加事项" : "Natural language input")
      .fill("Doctor in 4 hours");
    await page
      .getByRole("button", { name: zh ? "预览草稿" : "Preview draft" })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("checkbox", {
        name: zh ? "紧急闹钟" : "Urgent alarm",
        exact: true,
      })
      .check();
    await dialog.locator(".rules summary").click();
    await expect(dialog.locator(".rules summary")).toContainText(
      zh ? "自动" : "Automatic",
    );
    await expect(dialog.locator(".urgent-policy")).toContainText(
      zh ? "超过 10 天" : "More than 10 days",
    );
    await expect(dialog.locator(".rule-row")).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 844 });
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/items") && r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: zh ? "确认并保存" : "Confirm & save" })
      .click();
    const item = await (await response).json();
    expect(item.early_alarm_id).toBeTruthy();
    expect(item.early_alarm_id).not.toBe(item.id);
    for (const phase of ["due", "early"]) {
      await expect(
        page.locator(`[data-alarm="${phase}"]`).getByRole("status"),
      ).toHaveText(
        zh ? "已在此 iPhone 上设置闹钟。" : "Alarm scheduled on this iPhone.",
      );
    }
    await page.request.delete(`/api/items/${item.id}`);
  });
}
