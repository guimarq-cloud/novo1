import { chromium } from "playwright-core";

const outDir = "/tmp/claude-0/-home-user-novo1/d0ac0139-3ade-5a4e-a0ab-26664397db14/scratchpad";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--no-sandbox",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const context = await browser.newContext({ permissions: ["microphone"] });
const page = await context.newPage();
page.on("console", (msg) => console.log("[page]", msg.type(), msg.text().slice(0, 200)));

await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });

// grava 4s com o dispositivo falso
await page.click("#btn-record");
await page.waitForTimeout(4000);
await page.click("#btn-record");
await page.waitForSelector("#local-transcribe:not(.hidden)", { timeout: 5000 });
console.log("gravação ok; iniciando transcrição local…");

const t0 = Date.now();
await page.click("#btn-transcribe");

// espera concluir (download do modelo na primeira vez)
await page.waitForFunction(
  () => {
    const s = document.getElementById("transcribe-status").textContent;
    return /concluída|Nenhuma fala|Falha/.test(s);
  },
  { timeout: 480000, polling: 1000 }
);
const status = await page.textContent("#transcribe-status");
const transcript = await page.inputValue("#transcript");
console.log(`status: ${status}`);
console.log(`tempo: ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(`transcript: ${JSON.stringify(transcript.slice(0, 200))}`);

await page.screenshot({ path: `${outDir}/ui-3-whisper.png`, fullPage: true });
await browser.close();
