import { expect, test, type Page } from "@playwright/test";
import type { ModelSettings } from "../src/types";

const empty: ModelSettings = {
  available: true,
  provider: "openai",
  model: "",
  has_key: false,
  enabled: false,
  allow_images: false,
};
const secret = "fake-test-api-key-not-a-real-secret";

async function login(page: Page) {
  await page.addInitScript(() => localStorage.setItem("mewmo:language", "en"));
  const response = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "mewmo-local-test" },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/");
}
async function navigate(page: Page, name: string) {
  await page
    .getByRole("button", { name, exact: true })
    .filter({ visible: true })
    .click();
}
async function openSettings(page: Page) {
  await navigate(page, "Settings");
  await page.getByText("Configure model", { exact: true }).click();
  return page.locator(".ai-settings");
}
async function mockSettings(page: Page, initial = empty, testFails = false) {
  let saved = { ...initial };
  const writes: Record<string, unknown>[] = [];
  await page.route(/\/api\/model-settings(?:\/test)?$/, async (route) => {
    const request = route.request();
    if (request.url().endsWith("/test")) {
      await route.fulfill({
        status: testFails ? 400 : 200,
        json: testFails
          ? {
              detail:
                "Could not connect to the model. Check the provider, model ID, API key, and available credit.",
            }
          : { ok: true },
      });
      return;
    }
    if (request.method() === "PUT") {
      const body = request.postDataJSON();
      writes.push(body);
      saved = {
        available: true,
        provider: body.provider,
        model: body.model,
        has_key: true,
        enabled: body.enabled,
        allow_images: body.allow_images,
      };
    }
    if (request.method() === "DELETE") {
      saved = { ...empty };
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ json: saved });
  });
  return writes;
}

test("configure, test, disable, and remove a private model without displaying its key", async ({
  page,
}) => {
  const writes = await mockSettings(page);
  await login(page);
  const panel = await openSettings(page);
  await expect(panel.getByText("Local parsing only.")).toBeVisible();
  await panel.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  await panel.getByLabel("Model ID").fill("claude-example-model");
  await panel.getByLabel("API key", { exact: true }).fill(secret);
  await panel.getByLabel("Enable AI assistance").check();
  await panel.getByLabel("Allow optional image analysis").check();
  await panel.getByRole("button", { name: "Save AI settings" }).click();
  await expect(panel.getByText("AI settings saved.")).toBeVisible();
  expect(writes[0]).toMatchObject({
    provider: "anthropic",
    api_key: secret,
    enabled: true,
    allow_images: true,
  });
  await expect(panel.getByLabel("API key", { exact: true })).toHaveValue("");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    secret,
  );
  await panel.getByRole("button", { name: "Test saved model" }).click();
  await expect(panel.getByText("Connection successful.")).toBeVisible();
  await panel.getByLabel("Enable AI assistance").uncheck();
  await panel.getByRole("button", { name: "Save AI settings" }).click();
  await expect(panel.getByText("Local parsing only.")).toBeVisible();
  expect(writes[1].api_key).toBeNull();
  await panel
    .getByRole("button", { name: "Remove model", exact: true })
    .click();
  await panel.getByRole("button", { name: "Confirm removal" }).click();
  await expect(
    panel.getByText("Model removed. Local parsing is still available."),
  ).toBeVisible();
  await expect(panel.getByLabel("Model ID")).toHaveValue("");
});

test("provider changes clear the key and require fresh consent; failures remain usable", async ({
  page,
}) => {
  await mockSettings(
    page,
    { ...empty, has_key: true, model: "saved-model", enabled: true },
    true,
  );
  await login(page);
  const panel = await openSettings(page);
  await panel.getByRole("button", { name: "Test saved model" }).click();
  await expect(panel.getByRole("alert")).toContainText("Could not connect");
  await panel.getByLabel("API key", { exact: true }).fill(secret);
  await panel.getByLabel("Provider", { exact: true }).selectOption("gemini");
  await expect(panel.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(panel.getByLabel("Enable AI assistance")).not.toBeChecked();
  await expect(
    panel.getByLabel("Allow optional image analysis"),
  ).not.toBeChecked();
  await expect(
    panel.getByRole("button", { name: "Test saved model" }),
  ).toBeDisabled();
  await panel.getByLabel("Model ID").fill("gemini-example-model");
  await panel.getByRole("button", { name: "Save AI settings" }).click();
  expect(
    await panel
      .getByLabel("API key", { exact: true })
      .evaluate((node: HTMLInputElement) => node.validity.valueMissing),
  ).toBeTruthy();
});

test("Chinese AI settings fit narrow screens and retain form values when switching language", async ({
  page,
}) => {
  await mockSettings(page);
  await login(page);
  const panel = await openSettings(page);
  await panel.getByLabel("Model ID").fill("example-model");
  await page.getByLabel("Language").selectOption("zh-CN");
  await expect(panel.getByRole("heading", { name: "AI 辅助" })).toBeVisible();
  await expect(panel.getByLabel("模型 ID")).toHaveValue("example-model");
  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    const form = panel.locator("fieldset");
    const box = (await form.boundingBox())!;
    for (const input of await form
      .locator('input:not([type="checkbox"]), select')
      .all()) {
      const control = (await input.boundingBox())!;
      expect(control.width).toBeLessThanOrEqual(box.width + 1);
    }
  }
  await page
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en");
  await expect(panel.getByLabel("Model ID")).toHaveValue("example-model");
});

test("image analysis is opt-in for each import and resets after use", async ({
  page,
}) => {
  await mockSettings(page, {
    ...empty,
    has_key: true,
    model: "vision-model",
    enabled: true,
    allow_images: true,
  });
  const requests: URL[] = [];
  await page.route("**/api/drafts/file?**", async (route) => {
    requests.push(new URL(route.request().url()));
    await route.fulfill({
      status: 422,
      json: { detail: "Test import did not save anything." },
    });
  });
  await login(page);
  const consent = page.getByLabel(
    "Send bill images to my AI provider for this import",
  );
  await expect(consent).not.toBeChecked();
  const file = {
    name: "test.png",
    mimeType: "image/png",
    buffer: Buffer.from("test-image"),
  };
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole("alert")).toContainText("Test import");
  expect(requests[0].searchParams.has("use_image_ai")).toBeFalsy();
  await consent.check();
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect.poll(() => requests.length).toBe(2);
  await expect(consent).not.toBeChecked();
  expect(requests[1].searchParams.get("use_image_ai")).toBe("true");
  expect(requests[1].searchParams.get("image_provider")).toBe("openai");
  expect(requests[1].toString()).not.toContain(secret);
});

test("missing server encryption explains why saving is disabled", async ({
  page,
}) => {
  await mockSettings(page, { ...empty, available: false });
  await login(page);
  const panel = await openSettings(page);
  await expect(
    panel.getByText(
      "AI settings are unavailable. Ask the server administrator to configure encryption.",
    ),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Save AI settings" }),
  ).toBeDisabled();
  await navigate(page, "Overview");
  await expect(page.getByLabel("Natural language input")).toBeEnabled();
});

test("real settings API persists for a member without making a provider call", async ({
  page,
}) => {
  await login(page);
  const invite = await page.request.post("/api/admin/invitations");
  expect(invite.ok()).toBeTruthy();
  const inviteURL = new URL((await invite.json()).url);
  const token = new URLSearchParams(inviteURL.hash.slice(1)).get("invite");
  const signup = await page.request.post("/api/auth/register", {
    data: {
      username: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      display_name: "AI test",
      password: "browser-ai-test-password",
      invite_token: token,
    },
  });
  expect(signup.ok()).toBeTruthy();
  await page.reload();
  const panel = await openSettings(page);
  await panel.getByLabel("Provider", { exact: true }).selectOption("gemini");
  await panel.getByLabel("Model ID").fill("example-model");
  await panel.getByLabel("API key", { exact: true }).fill(secret);
  await panel.getByRole("button", { name: "Save AI settings" }).click();
  await expect(panel.getByText("AI settings saved.")).toBeVisible();
  await page.reload();
  const restored = await openSettings(page);
  await expect(restored.getByLabel("Provider", { exact: true })).toHaveValue(
    "gemini",
  );
  await expect(restored.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(restored.getByLabel("Enable AI assistance")).not.toBeChecked();
  const settings = await page.request.get("/api/model-settings");
  expect(await settings.text()).not.toContain(secret);
});
