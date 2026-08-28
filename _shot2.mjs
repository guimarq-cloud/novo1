import { chromium } from "playwright-core";

const outDir = "/tmp/claude-0/-home-user-novo1/d0ac0139-3ade-5a4e-a0ab-26664397db14/scratchpad";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const context = await browser.newContext({ permissions: ["microphone"] });
const page = await context.newPage({ viewport: { width: 1180, height: 900 } });
await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });

await page.click("#btn-record");
await page.waitForTimeout(2500);
await page.click("#btn-record");
await page.waitForSelector("#local-transcribe:not(.hidden)", { timeout: 5000 });
await page.screenshot({ path: `${outDir}/ui-4-desktop.png`, fullPage: false, clip: { x: 0, y: 150, width: 1180, height: 520 } });
await browser.close();
console.log("ok");
