import { expect, test, type Page } from "@playwright/test";

async function chineseLogin(page: Page) {
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("mewmo-local-test");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "首页", exact: true }),
  ).toBeVisible();
}
async function navigate(page: Page, name: string) {
  await page
    .getByRole("button", { name, exact: true })
    .filter({ visible: true })
    .click();
}

test("Chinese required-field hints clear after input and language changes", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const username = page.getByLabel("用户名", { exact: true });
  expect(
    await username.evaluate((node: HTMLInputElement) => node.validationMessage),
  ).toBe("此项为必填项");
  await username.fill("admin");
  expect(
    await username.evaluate(
      (node: HTMLInputElement) => node.validity.customError,
    ),
  ).toBe(false);
  await page
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en");
  const password = page.getByLabel("Your password", { exact: true });
  expect(
    await password.evaluate(
      (node: HTMLInputElement) => node.validity.customError,
    ),
  ).toBe(false);
});

test("Chinese device language covers login errors and all main pages", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "languages", { get: () => ["zh-CN"] }),
  );
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("incorrect-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("用户名或密码不正确");
  await page.getByLabel("密码", { exact: true }).fill("mewmo-local-test");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  for (const name of ["首页", "日历", "历史记录", "通知", "设置"]) {
    await navigate(page, name);
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(page.getByRole("heading", { name: "我的账户" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "隐私与偏好" }).click();
  await expect(page.getByText("键盘听写", { exact: true })).toBeVisible();
});

test("language switching retains login inputs and persists across reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page
    .getByLabel("Your password", { exact: true })
    .fill("mewmo-local-test");
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(page.getByLabel("用户名", { exact: true })).toHaveValue("admin");
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue(
    "mewmo-local-test",
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "欢迎使用 Mewmo" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "已有邀请？注册 Mewmo" }).click();
  await expect(page.getByLabel("邀请链接或邀请码")).toBeVisible();
  await expect(page.getByLabel("确认密码")).toBeVisible();
  await page
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en");
  await expect(
    page.getByRole("heading", { name: "Create your private account" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
});

test("Chinese capture keeps the confirmation boundary and full local date", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-06T12:00:00"));
  await chineseLogin(page);
  const before = await page.request
    .get("/api/items")
    .then((response) => response.json());
  await page.getByLabel("用自然语言添加事项").fill("后天9点有医生预约");
  await page.getByRole("button", { name: "预览草稿" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("标题", { exact: true })).toHaveValue(
    "医生预约",
  );
  await expect(dialog.locator(".date-preview strong")).toContainText(
    "2026年11月8日",
  );
  await expect(dialog.locator(".date-preview strong")).toContainText("星期日");
  await expect(dialog.locator(".date-preview strong")).toContainText("09:00");
  expect(
    await page.request.get("/api/items").then((response) => response.json()),
  ).toEqual(before);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/items") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "确认并保存" }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const item = await response.json();
  try {
    expect(item.title).toBe("医生预约");
    expect(item.due_date).toBe("2026-11-08");
    expect(item.due_time).toBe("09:00");
    await expect(page.getByText("事项已保存。", { exact: true })).toBeVisible();
  } finally {
    await page.request.delete(`/api/items/${item.id}`);
  }
});

test("language changes in another tab preserve an open unsaved draft", async ({
  page,
  context,
}) => {
  await chineseLogin(page);
  await page.getByRole("button", { name: "添加事项", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("标题", { exact: true }).fill("Settings 我的账单");
  await dialog.getByLabel("收款方", { exact: true }).fill("Example 水电公司");
  await expect(dialog.getByLabel("币种", { exact: true })).toHaveValue("USD");
  const other = await context.newPage();
  await other.goto("/");
  await navigate(other, "设置");
  await other
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en");
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue(
    "Settings 我的账单",
  );
  await expect(dialog.getByLabel("Payee", { exact: true })).toHaveValue(
    "Example 水电公司",
  );
  await expect(dialog.getByLabel("Currency", { exact: true })).toHaveValue(
    "USD",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await other.close();
});

test("Chinese bill warnings remain visible and paid bills go to history", async ({
  page,
}) => {
  await chineseLogin(page);
  await page.getByLabel("用自然语言添加事项").fill("这个月水电 120 刀，已付");
  await page.getByRole("button", { name: "预览草稿" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("请确认币种；已将 刀 识别为 USD。"),
  ).toBeVisible();
  await expect(dialog.getByLabel("已经支付")).toBeChecked();
  await dialog.getByLabel("到期日期").fill("2099-11-08");
  const duplicate = dialog.getByLabel("我已核对重复提示，仍要保存此账单。");
  if (await duplicate.isVisible()) await duplicate.check();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/items") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "确认并保存" }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const item = await response.json();
  try {
    expect(item.status).toBe("paid");
    expect(item.currency).toBe("USD");
    await navigate(page, "历史记录");
    await page
      .getByRole("button")
      .filter({ hasText: item.title })
      .first()
      .click();
    await expect(page.getByRole("dialog").locator(".eyebrow")).toContainText(
      "账单 · 已支付",
    );
    await expect(
      page.getByRole("button", { name: "恢复为未完成" }),
    ).toBeVisible();
  } finally {
    await page.request.delete(`/api/items/${item.id}`);
  }
});
