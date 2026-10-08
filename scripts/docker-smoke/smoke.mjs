import { chromium } from "playwright";

const baseUrl = process.env.WHITEBOARD_URL ?? `http://127.0.0.1:${process.env.WHITEBOARD_PORT ?? "3000"}`;
const token = process.env.WHITEBOARD_TOKEN;
const screenshot = process.env.SMOKE_SCREENSHOT ?? "docker-smoke-failure.png";
if (!token) throw new Error("WHITEBOARD_TOKEN is required");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, {
      waitUntil: "load",
      timeout: 60_000,
    });
    await page.getByText("Docker web smoke review", { exact: true }).first().click();
    await page.getByText("Browser smoke test", { exact: true }).waitFor();
    await page.getByText("Queue an order", { exact: true }).waitFor();
    await page.getByText("Order lifecycle", { exact: true }).waitFor();
    await page.getByText("Persist order", { exact: true }).waitFor();
    await page.locator("svg").first().waitFor({ state: "visible" });
  } catch (error) {
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    throw error;
  }
} finally {
  await browser.close();
}
