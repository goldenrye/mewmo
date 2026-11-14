import { expect, test, type Page } from "@playwright/test";

// UI-only stand-in for the system prompt. Keychain and a real scan require an iPhone.
async function mockPrompt(
  page: Page,
  cancelled: boolean,
  timeout = false,
  recovery: "none" | "transient" | "expired" | "missing" | "invalid" = "none",
) {
  await page.route("**/src/biometrics.ts*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        import { api } from "/src/api.ts";
        export class BiometricPasswordRequiredError extends Error {
          constructor(message, reason = "rejected") { super(message); this.reason = reason; }
        }
        export class BiometricConnectionError extends Error {}
        let failedVerification = false;
        let attempts = 0;
        let statusCalls = 0;
        export const supportsBiometrics = () => true;
        export const biometricStatus = async () => {
          document.documentElement.dataset.biometricStatusCalls = String(++statusCalls);
          if (failedVerification && ${recovery === "transient"})
            return { available: false, enabled: false, label: "Face ID" };
          if (failedVerification) return new Promise(() => {});
          return { available: true, enabled: true, label: "Face ID" };
        };
        export const clearBiometrics = async () => {};
        export const enableBiometrics = async () => {};
        export async function signInWithBiometrics(onProgress) {
          document.documentElement.dataset.biometricAttempts = String(++attempts);
          if (${cancelled}) throw new Error("Sign-in cancelled. Try again or use your password.");
          if (${["expired", "missing", "invalid"].includes(recovery)}) {
            throw new BiometricPasswordRequiredError(${JSON.stringify(
              recovery === "expired"
                ? "The server rejected your saved session. It may be expired or revoked. Sign in with your password."
                : recovery === "missing"
                  ? "No saved sign-in was found on this iPhone. Sign in with your password."
                  : "The saved sign-in on this iPhone cannot be read or is invalid. Sign in with your password.",
            )}, ${JSON.stringify(recovery === "expired" ? "rejected" : recovery)});
          }
          if (${timeout} && attempts === 1) {
            onProgress?.("verifying");
            await new Promise(resolve => setTimeout(resolve, 1000));
            failedVerification = true;
            throw new BiometricConnectionError("Session verification timed out. Check your connection, then try again or use your password.");
          }
          if (${recovery === "transient"} && attempts === 2)
            throw new BiometricConnectionError("Server temporarily unavailable");
          return api("/auth/login", {
            method: "POST",
            body: JSON.stringify({ username: "admin", password: "mewmo-local-test" }),
          });
        }
      `,
    }),
  );
  await page.goto("/");
}

test("mocked Face ID button signs in without filling the password form", async ({
  page,
}) => {
  await mockPrompt(page, false);
  await page
    .getByRole("button", { name: "Sign in with Face ID", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
});

test("cancelling the mocked Face ID prompt leaves password fallback usable", async ({
  page,
}) => {
  await mockPrompt(page, true);
  await page
    .getByRole("button", { name: "Sign in with Face ID", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Sign-in cancelled");
  await expect(page.getByRole("alert").locator("strong")).toHaveText(
    "Biometric sign-in interrupted",
  );
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page
    .getByLabel("Your password", { exact: true })
    .fill("mewmo-local-test");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
});

test("real browser does not offer unsupported Face ID sign-in", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to Mewmo" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with Face ID" }),
  ).toHaveCount(0);
});

for (const language of ["en", "zh-CN"]) {
  test(`${language} verification feedback and password fallback survive a stalled status refresh`, async ({
    page,
  }) => {
    const zh = language === "zh-CN";
    await page.addInitScript(
      (language) => localStorage.setItem("mewmo:language", language),
      language,
    );
    await page.clock.install();
    await mockPrompt(page, false, true);
    const face = page.getByRole("button", {
      name: zh ? "使用面容 ID登录" : "Sign in with Face ID",
      exact: true,
    });
    await face.click();
    await expect(page.getByRole("status")).toHaveText(
      zh
        ? "正在向服务器验证登录状态..."
        : "Checking your session with the server...",
    );
    await expect(face).toBeDisabled();
    await expect(
      page.getByRole("heading", {
        name: zh ? "首页" : "Overview",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.clock.fastForward(1000);
    await expect(page.getByRole("alert")).toContainText(
      zh ? "登录验证超时" : "Session verification timed out",
    );
    await expect(page.getByRole("alert").locator("strong")).toHaveText(
      zh ? "暂时无法完成服务器验证" : "Server verification unavailable",
    );
    await expect(
      page.getByRole("button", {
        name: zh ? "重试面容 ID" : "Retry Face ID",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(page.getByRole("status")).toHaveCount(0);
    await page
      .getByLabel(zh ? "用户名" : "Username", { exact: true })
      .fill("admin");
    await page
      .getByLabel(zh ? "密码" : "Your password", { exact: true })
      .fill("mewmo-local-test");
    await page
      .getByRole("button", { name: zh ? "登录" : "Sign in", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: zh ? "首页" : "Overview",
        exact: true,
      }),
    ).toBeVisible();
  });

  test(`${language} manual Face ID retry survives repeated failures without forcing passwords`, async ({
    page,
  }) => {
    const zh = language === "zh-CN";
    await page.addInitScript(
      (value) => localStorage.setItem("mewmo:language", value),
      language,
    );
    await page.clock.install();
    await mockPrompt(page, false, true, "transient");
    const initialFace = page.getByRole("button", {
      name: zh ? "使用面容 ID登录" : "Sign in with Face ID",
      exact: true,
    });
    await expect(initialFace).toBeEnabled();
    const initialStatusCalls = await page
      .locator("html")
      .getAttribute("data-biometric-status-calls");
    expect(initialStatusCalls).not.toBeNull();
    await initialFace.click();
    await page.clock.fastForward(1000);
    const retry = page.getByRole("button", {
      name: zh ? "重试面容 ID" : "Retry Face ID",
      exact: true,
    });
    await expect(retry).toBeEnabled();
    await expect(
      page.getByText(
        zh
          ? "已保留你的登录凭据。可随时重试，或自行选择下方的密码登录。"
          : "Your saved sign-in is kept. Retry when ready, or choose password sign-in below.",
      ),
    ).toBeVisible();
    await page.clock.fastForward(30_000);
    await expect(page.locator("html")).toHaveAttribute(
      "data-biometric-attempts",
      "1",
    );
    // A transient status check must not hide the existing retry control.
    await expect(page.locator("html")).toHaveAttribute(
      "data-biometric-status-calls",
      initialStatusCalls!,
    );
    await retry.click();
    await expect(page.getByRole("alert")).toContainText(
      "Server temporarily unavailable",
    );
    await expect(page.getByRole("alert").locator("strong")).toHaveText(
      zh ? "暂时无法完成服务器验证" : "Server verification unavailable",
    );
    await expect(retry).toBeEnabled();
    await expect(page.locator("html")).toHaveAttribute(
      "data-biometric-attempts",
      "2",
    );
    await expect(
      page.getByLabel(zh ? "用户名" : "Username", { exact: true }),
    ).toHaveValue("");
    await expect(
      page.getByLabel(zh ? "密码" : "Your password", { exact: true }),
    ).toHaveValue("");
    await retry.click();
    await expect(
      page.getByRole("heading", {
        name: zh ? "首页" : "Overview",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-biometric-attempts",
      "3",
    );
  });

  for (const reason of ["expired", "missing", "invalid"] as const) {
    test(`${language} requires passwords only when saved credentials are ${reason}`, async ({
      page,
    }) => {
      const zh = language === "zh-CN";
      await page.addInitScript(
        (value) => localStorage.setItem("mewmo:language", value),
        language,
      );
      await page.setViewportSize({ width: 320, height: 740 });
      await mockPrompt(page, false, false, reason);
      await page
        .getByRole("button", {
          name: zh ? "使用面容 ID登录" : "Sign in with Face ID",
          exact: true,
        })
        .click();
      const alert = page.getByRole("alert");
      const titles = {
        expired: zh ? "已保存的会话被服务器拒绝" : "Saved session rejected",
        missing: zh ? "未找到已保存的登录凭据" : "Saved sign-in missing",
        invalid: zh ? "已保存的登录凭据无效" : "Saved sign-in invalid",
      };
      await expect(alert).toBeVisible();
      await expect(alert.locator("strong")).toHaveText(titles[reason]);
      await expect(alert).toContainText(
        zh
          ? "使用密码登录后，请在设置中重新启用面容 ID。"
          : "After password sign-in, enable Face ID again in Settings.",
      );
      if (reason === "expired")
        await expect(alert).toContainText(
          zh ? "可能已过期或被撤销" : "may be expired or revoked",
        );
      await expect(alert).not.toContainText(
        zh ? "暂时无法完成服务器验证" : "Server verification unavailable",
      );
      const alertBox = (await alert.boundingBox())!;
      const usernameBox = (await page
        .getByLabel(zh ? "用户名" : "Username", { exact: true })
        .boundingBox())!;
      expect(alertBox.y + alertBox.height).toBeLessThan(usernameBox.y);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(320);
      await expect(page.locator(".login-form .secondary")).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: zh ? "登录" : "Sign in",
          exact: true,
        }),
      ).toBeEnabled();
      await expect(
        page.getByRole("heading", {
          name: zh ? "首页" : "Overview",
          exact: true,
        }),
      ).toHaveCount(0);
    });
  }

  test(`${language} login keeps language, Face ID, and fields in one column`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((value) => {
      localStorage.setItem("mewmo:language", value);
    }, language);
    await mockPrompt(page, true);

    for (const width of [320, 393, 768, 1280]) {
      await page.setViewportSize({ width, height: 852 });
      const selector = page.locator(".login-form .language-selector");
      const form = page.locator(".login-form form");
      const face = form.locator(".secondary");
      await expect(face).toBeVisible();
      const selectorBox = (await selector.boundingBox())!;
      const formBox = (await form.boundingBox())!;
      const faceBox = (await face.boundingBox())!;
      const brandBox = (await page.locator(".login-story").boundingBox())!;

      expect(selectorBox.y).toBeGreaterThanOrEqual(
        brandBox.y + brandBox.height,
      );
      expect(selectorBox.y - brandBox.y - brandBox.height).toBeLessThan(40);
      expect(selectorBox.y + selectorBox.height).toBeLessThanOrEqual(formBox.y);
      expect(Math.abs(selectorBox.x - formBox.x)).toBeLessThan(1);
      expect(Math.abs(selectorBox.width - formBox.width)).toBeLessThan(1);
      expect(Math.abs(faceBox.width - formBox.width)).toBeLessThan(1);
      expect(formBox.width).toBeGreaterThanOrEqual(Math.min(width - 48, 420));
      expect(faceBox.height).toBeLessThanOrEqual(64);
      expect(
        await selector
          .locator("span")
          .evaluate((node) => getComputedStyle(node).whiteSpace),
      ).toBe("nowrap");
      for (const input of await form.locator("input").all()) {
        const box = (await input.boundingBox())!;
        expect(Math.abs(box.x - formBox.x)).toBeLessThan(1);
        expect(Math.abs(box.width - formBox.width)).toBeLessThan(1);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);

      if (width === 393) {
        await page.screenshot({
          path: testInfo.outputPath(`login-${language}.png`),
          fullPage: true,
        });
      }
    }

    await page.setViewportSize({ width: 320, height: 740 });
    await page.locator(".auth-toggle").click();
    await expect(page.locator(".login-form input")).toHaveCount(5);
    const selectorBox = (await page
      .locator(".login-form .language-selector")
      .boundingBox())!;
    const formBox = (await page.locator(".login-form form").boundingBox())!;
    expect(selectorBox.y + selectorBox.height).toBeLessThanOrEqual(formBox.y);
    expect(formBox.width).toBeGreaterThanOrEqual(272);
    await page.locator(".login-form input").last().fill("long-test-password");
    await page.locator(".auth-toggle").scrollIntoViewIfNeeded();
    await expect(page.locator(".auth-toggle")).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
  });
}
