import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

for (const header of ["Authorization", "X-API-Key"]) {
  for (const language of ["en", "zh-CN"]) {
    test(`remote agent can create a confirmed reminder and its token can be revoked (${language}, ${header})`, async ({
      page,
    }) => {
      const zh = language === "zh-CN";
      await page.addInitScript(
        (value) => localStorage.setItem("mewmo:language", value),
        language,
      );
      await page.goto("/");
      await page
        .getByLabel(zh ? "用户名" : "Username", { exact: true })
        .fill("admin");
      await page
        .getByLabel(zh ? "密码" : "Your password", { exact: true })
        .fill("mewmo-local-test");
      await page
        .getByRole("button", { name: zh ? "登录" : "Sign in", exact: true })
        .click();
      await page
        .getByRole("button", { name: zh ? "设置" : "Settings", exact: true })
        .filter({ visible: true })
        .click();
      const section = page.locator("section").filter({
        has: page.getByRole("heading", {
          name: zh ? "智能体访问" : "Agent access",
          exact: true,
        }),
      });
      await section
        .getByText(zh ? "管理智能体访问" : "Manage agent access", {
          exact: true,
        })
        .click();
      await expect(
        section.getByLabel(zh ? "MCP 服务地址" : "MCP endpoint"),
      ).toHaveValue(/\/api\/mcp\/$/);
      await expect(section).toContainText("X-API-Key");
      const name = "Agent-" + randomUUID().slice(0, 8);
      await section.getByLabel(zh ? "智能体名称" : "Agent name").fill(name);
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/agent-tokens") &&
          r.request().method() === "POST",
      );
      await section
        .getByRole("button", {
          name: zh ? "创建智能体令牌" : "Create agent token",
          exact: true,
        })
        .click();
      const issued = await (await response).json();
      let itemId: string | undefined;
      const rpc = (method: string, params = {}) =>
        page.request.post("/api/mcp/", {
          headers: {
            [header]:
              (header === "Authorization" ? "Bearer " : "") + issued.token,
            Accept: "application/json, text/event-stream",
          },
          data: { jsonrpc: "2.0", id: 1, method, params },
        });
      try {
        const secret = section.getByLabel(
          zh ? "智能体令牌（仅显示一次）" : "Agent token (shown once)",
          { exact: true },
        );
        await expect(secret).toHaveValue(issued.token);
        expect(
          JSON.stringify(
            await page.evaluate(() => ({ ...localStorage, ...sessionStorage })),
          ),
        ).not.toContain(issued.token);
        await page.setViewportSize({ width: 320, height: 844 });
        expect(
          await section.evaluate(
            (node) => node.scrollWidth <= node.clientWidth,
          ),
        ).toBe(true);
        const tools = await rpc("tools/list");
        expect(tools.status()).toBe(200);
        expect(
          (await tools.json()).result.tools.map(
            (t: { name: string }) => t.name,
          ),
        ).toContain("create_reminder");
        const preview = await (
          await rpc("tools/call", {
            name: "preview_reminder",
            arguments: {
              reminder: {
                title: name,
                kind: "appointment",
                due_date: "2099-11-20",
                due_time: "09:00",
                timezone: "UTC",
              },
            },
          })
        ).json();
        const review = preview.result.structuredContent;
        expect(review.saved).toBe(false);
        const args = {
          reminder: review.reminder,
          preview_hash: review.preview_hash,
          confirmed: true,
          request_id: randomUUID(),
        };
        const saved = await (
          await rpc("tools/call", { name: "create_reminder", arguments: args })
        ).json();
        itemId = saved.result.structuredContent.item_id;
        expect(itemId).toBeTruthy();
        const replay = await (
          await rpc("tools/call", { name: "create_reminder", arguments: args })
        ).json();
        expect(replay.result.structuredContent.replayed).toBe(true);
        expect(replay.result.structuredContent.item_id).toBe(itemId);
        await section
          .getByText(zh ? "管理智能体访问" : "Manage agent access", {
            exact: true,
          })
          .click();
        await section
          .getByText(zh ? "管理智能体访问" : "Manage agent access", {
            exact: true,
          })
          .click();
        await expect(secret).toHaveCount(0);
        await section
          .getByRole("button", {
            name: zh ? `撤销智能体 ${name}` : `Revoke agent ${name}`,
          })
          .click();
        await expect(
          section.getByRole("button", {
            name: zh ? `撤销智能体 ${name}` : `Revoke agent ${name}`,
          }),
        ).toHaveCount(0);
        expect((await rpc("tools/list")).status()).toBe(401);
      } finally {
        await page.request.delete("/api/agent-tokens/" + issued.id);
        if (itemId) await page.request.delete("/api/items/" + itemId);
      }
    });
  }
}
