import { expect, test, type Page } from "@playwright/test";

// UI-only stand-in for the system prompt. Keychain and a real scan require an iPhone.
async function mockPrompt(page: Page, cancelled: boolean) {
  await page.route("**/src/biometrics.ts*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        import { api } from "/src/api.ts";
        export const supportsBiometrics = () => true;
        export const biometricStatus = async () => ({ available: true, enabled: true, label: "Face ID" });
        export const clearBiometrics = async () => {};
        export const enableBiometrics = async () => {};
        export async function signInWithBiometrics() {
          if (${cancelled}) throw new Error("Sign-in cancelled. Try again or use your password.");
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
