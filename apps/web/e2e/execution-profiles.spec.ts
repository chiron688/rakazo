import { expect, test } from "@playwright/test";
import type { ExecutionProfile } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

// Offline fixture: real shared web/Electron settings controls, mocked metadata only.
const profile: ExecutionProfile = {
  id: "profile-review",
  seriesId: "series-review",
  revision: 1,
  spaceId: "space-fixture",
  name: "Review",
  harness: "claude",
  runtimeVersion: "0.3.300",
  provider: "anthropic",
  credentialId: "project-account",
  protocol: "anthropic",
  endpoint: "https://api.example.test",
  modelId: "test-model",
  inputModalities: ["image"],
  computerId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};
for (const viewport of [
  { name: "desktop", width: 1100, height: 1000 },
  { name: "narrow-web", width: 390, height: 844 },
]) {
  test(`execution profile create, reuse and account failure (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    let created = false;
    let revoked = false;
    await page.route("**/rpc/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("executionProfiles/list"))
        return route.fulfill({ json: { json: created ? [profile] : [] } });
      if (path.endsWith("models/credentials"))
        return route.fulfill({
          json: {
            json: [
              {
                id: "team-account",
                provider: "anthropic",
                label: "Team account",
                hasKey: true,
                isDefault: true,
                authKind: "api_key",
              },
              ...(!revoked
                ? [
                    {
                      id: "project-account",
                      provider: "anthropic",
                      label: "Project account",
                      hasKey: true,
                      isDefault: false,
                      authKind: "api_key",
                    },
                  ]
                : []),
            ],
          },
        });
      if (path.endsWith("executionProfiles/create")) {
        expect(route.request().postDataJSON().json).toMatchObject({
          credentialId: "project-account",
          harness: "claude",
          protocol: "anthropic",
          computerId: null,
          inputModalities: ["image"],
        });
        created = true;
        return route.fulfill({ json: { json: profile } });
      }
      throw new Error(`Unexpected RPC ${path}`);
    });
    await page.goto("/e2e/fixtures/execution-profiles.html");
    await expect(page.getByLabel("Execution profile", { exact: true })).not.toBeVisible();
    await page.getByText("Advanced", { exact: true }).click();
    await expect(page.getByLabel("Execution profile", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "New profile", exact: true }).click();
    const form = page.getByTestId("execution-profile-create");
    await expect(form.getByLabel("Harness", { exact: true }).locator("option:checked")).toHaveText(
      "Claude Agent",
    );
    await form.getByLabel("Profile name", { exact: true }).fill("Review");
    await expect(form.getByLabel("Runtime version", { exact: true })).toHaveValue("0.3.300");
    await form.getByLabel("Provider", { exact: true }).selectOption("anthropic");
    await expect(form.getByLabel("Account", { exact: true })).toHaveValue("");
    await form.getByLabel("Account", { exact: true }).selectOption("project-account");
    await form.getByLabel("Model", { exact: true }).fill("test-model");
    await form.getByLabel("Endpoint", { exact: true }).fill("https://api.example.test");
    await form.getByRole("switch", { name: "Model accepts images", exact: true }).check();
    await captureScreenshot(page, testInfo, `execution-profile-create-${viewport.name}`);
    await form.getByRole("button", { name: "Create profile", exact: true }).click();
    await expect(page.getByLabel("Execution profile", { exact: true })).toHaveValue(profile.id);
    await expect(page.getByTestId("execution-profile-effective")).toContainText("Project account");
    await expect(page.getByTestId("execution-profile-effective")).not.toContainText("Team account");
    await expect(page.getByTestId("execution-profile-effective")).toContainText("Claude Agent");
    await expect(page.getByTestId("execution-profile-effective")).toContainText(
      "Unavailable: uploaded audio",
    );
    await expect(page.getByTestId("execution-profile-effective")).not.toContainText(
      "delegated agents",
    );
    await captureScreenshot(page, testInfo, `execution-profile-selected-${viewport.name}`);
    revoked = true;
    await page.reload();
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByLabel("Execution profile", { exact: true }).selectOption(profile.id);
    await expect(page.getByRole("alert")).toContainText("account is unavailable");
    await captureScreenshot(page, testInfo, `execution-profile-unavailable-${viewport.name}`);
    await page.getByLabel("Execution profile", { exact: true }).selectOption("");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByTestId("execution-profile-effective")).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
  });
}
