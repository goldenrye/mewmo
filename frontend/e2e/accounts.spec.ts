import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("signing out clears the account from another open tab", async ({ page, context }) => {
  await login(page);
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("heading", { name: "A little less on your mind." })).toBeVisible();
  await signOut(page);
  await expect(other.getByRole("heading", { name: "Welcome to Mewmo" })).toBeVisible();
  await expect(other.getByRole("heading", { name: "A little less on your mind." })).toHaveCount(0);
});

async function login(
  page: Page,
  username = "admin",
  password = "mewmo-local-test",
) {
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Your password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Come on in" }).click();
  await expect(
    page.getByRole("heading", { name: "A little less on your mind." }),
  ).toBeVisible();
}

async function settings(page: Page) {
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .filter({ visible: true })
    .click();
}

async function signOut(page: Page) {
  await settings(page);
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .filter({ visible: true })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome to Mewmo" }),
  ).toBeVisible();
}

async function register(page: Page, url: string, username: string) {
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "Create your private account" }),
  ).toBeVisible();
  await page.getByLabel("Your name", { exact: true }).fill("Invited User");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page
    .getByLabel("Your password", { exact: true })
    .fill("invited-user-password");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("invited-user-password");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
}

test("admin invites a private member; single-use link cannot be reused", async ({
  page,
}) => {
  const username = "guest-" + randomUUID().slice(0, 8);
  await login(page);
  const response = await page.request.post("/api/items", {
    data: {
      confirmed: true,
      local_date: "2026-11-06",
      timezone: "UTC",
      kind: "appointment",
      title: "Administrator private appointment",
      due_date: "2099-11-20",
      due_time: "09:00",
      rules: [],
    },
  });
  const item = await response.json();
  await settings(page);
  await expect(
    page.getByRole("heading", { name: "Invite people" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create invite link", exact: true })
    .click();
  const link = page.getByLabel("Invitation link", { exact: true });
  await expect(link).toHaveValue(/#invite=/);
  const url = await link.inputValue();
  await expect(page.getByText(/expires 7 days after creation/)).toBeVisible();
  await signOut(page);
  await register(page, url, username);
  await expect(
    page.getByRole("heading", { name: "A little less on your mind." }),
  ).toBeVisible();
  await expect(
    page.getByText("Administrator private appointment", { exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get("/api/items")).status()).toBe(200);
  expect(await page.request.get("/api/items").then((r) => r.json())).toEqual(
    [],
  );
  expect((await page.request.delete(`/api/items/${item.id}`)).status()).toBe(
    404,
  );
  await settings(page);
  await expect(
    page.getByRole("heading", { name: "Your account" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Invite people" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await signOut(page);
  await register(page, url, "reuse-" + randomUUID().slice(0, 8));
  await expect(page.getByRole("alert")).toContainText("already used");
  await login(page);
  await page.request.delete(`/api/items/${item.id}`);
});

test("admin can revoke a pending invitation before it is redeemed", async ({
  page,
}) => {
  await login(page);
  await settings(page);
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/admin/invitations") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Create invite link", exact: true })
    .click();
  const invitation = await (await created).json();
  const row = page
    .locator(".invitation-row")
    .filter({ hasText: invitation.id.slice(0, 8) });
  await expect(row).toContainText("pending");
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(row).toContainText("revoked");
  await signOut(page);
  await register(page, invitation.url, "revoked-" + randomUUID().slice(0, 8));
  await expect(page.getByRole("alert")).toContainText("revoked");
});
