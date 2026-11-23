import { expect, test, type Page } from "@playwright/test";

const ownerEmail = process.env.VALIDATION_OWNER_EMAIL;
const ownerPassword = process.env.VALIDATION_OWNER_PASSWORD;
const operationsEmail = process.env.VALIDATION_OPERATIONS_EMAIL;
const operationsPassword = process.env.VALIDATION_OPERATIONS_PASSWORD;

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/welcome");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

async function expectPage(page: Page, path: string, heading: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

test("the owner can open inventory and staff settings", async ({ page }) => {
  test.skip(!ownerEmail || !ownerPassword, "Configure a synthetic validation owner.");
  await signIn(page, ownerEmail!, ownerPassword!);
  await expectPage(page, "/inventory", "Inventory");
  await page.getByRole("button", { name: "Warehouses", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Warehouses" })).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByText("Staff access", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create invitation" })).toBeVisible();
});

test("operations can reach purchasing and bins and staff management is blocked", async ({ page }) => {
  test.skip(!operationsEmail || !operationsPassword, "Configure a synthetic validation operations account.");
  await signIn(page, operationsEmail!, operationsPassword!);
  await expectPage(page, "/inventory/purchase-orders", "Purchase orders");
  await expectPage(page, "/inventory/bins", "Warehouse bins");
  expect((await page.request.get("/api/auth/staff")).status()).toBe(403);
});

test("a signed-in owner can open a new tab without a demo-entry flag", async ({ page, context }) => {
  test.skip(!ownerEmail || !ownerPassword, "Configure a validation owner.");
  await signIn(page, ownerEmail!, ownerPassword!);
  const freshTab = await context.newPage();
  await freshTab.addInitScript(() => {
    sessionStorage.clear();
    Object.defineProperty(window, "sessionStorage", { get() { throw new DOMException("Storage unavailable", "SecurityError"); } });
  });
  await freshTab.goto("/profile");
  const heading = freshTab.getByRole("heading", { name: "My profile", exact: true });
  const training = freshTab.getByRole("dialog", { name: "Learn Catalyst Works", exact: true });
  await expect.poll(async () => await heading.isVisible() || await training.isVisible()).toBe(true);
  if (await training.isVisible()) await training.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(heading).toBeVisible();
  await expect(freshTab.getByLabel("Sign-in email", { exact: true })).toHaveValue(ownerEmail!);
});
