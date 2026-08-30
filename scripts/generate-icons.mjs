/**
 * Gera todos os ícones do app (celular, macOS, Windows e navegador) a partir
 * de build/icon.svg e build/icon-maskable.svg.
 *
 * Os PNGs e o .ico já estão versionados no repositório — rode este script
 * apenas se quiser alterar o desenho. Requer o Chromium do Playwright:
 *     npm i --no-save playwright-core
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = path.join(root, "public", "icons");
fs.mkdirSync(iconsDir, { recursive: true });

// Tamanhos por finalidade:
// 16/24/32/48/64/128/256 -> favicon e ícone do Windows
// 96/144/192/256/384/512 -> Android e PWA
// 152/167/180           -> iPad e iPhone
// 1024                  -> macOS (electron-builder gera o .icns)
const SIZES = [16, 24, 32, 48, 64, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512, 1024];

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});

async function render(svgPath, size, destPath) {
  const svg = fs.readFileSync(svgPath, "utf8");
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  );
  await page.waitForTimeout(120);
  await page.screenshot({ path: destPath, omitBackground: true });
  await page.close();
}

const svgPadrao = path.join(root, "build", "icon.svg");
const svgMaskable = path.join(root, "build", "icon-maskable.svg");

for (const size of SIZES) {
  await render(svgPadrao, size, path.join(iconsDir, `icon-${size}.png`));
  console.log(`  icon-${size}.png`);
}
// Ícone adaptativo do Android (o sistema recorta em círculo/squircle).
for (const size of [192, 512]) {
  await render(svgMaskable, size, path.join(iconsDir, `maskable-${size}.png`));
  console.log(`  maskable-${size}.png`);
}
// Ícone principal do app de desktop (electron-builder gera .icns e .ico daqui).
await render(svgPadrao, 1024, path.join(root, "build", "icon.png"));
// Favicon usado pela aba do navegador.
fs.copyFileSync(path.join(iconsDir, "icon-32.png"), path.join(root, "public", "icon.png"));

await browser.close();

// favicon.ico multi-resolução (Windows e navegadores antigos): o formato ICO
// aceita PNGs embutidos, então basta montar o cabeçalho.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const imagens = icoSizes.map((s) => fs.readFileSync(path.join(iconsDir, `icon-${s}.png`)));
const cabecalho = Buffer.alloc(6 + 16 * imagens.length);
cabecalho.writeUInt16LE(0, 0);
cabecalho.writeUInt16LE(1, 2); // tipo 1 = ícone
cabecalho.writeUInt16LE(imagens.length, 4);
let offset = cabecalho.length;
imagens.forEach((img, i) => {
  const base = 6 + i * 16;
  const s = icoSizes[i];
  cabecalho.writeUInt8(s >= 256 ? 0 : s, base);
  cabecalho.writeUInt8(s >= 256 ? 0 : s, base + 1);
  cabecalho.writeUInt8(0, base + 2);
  cabecalho.writeUInt8(0, base + 3);
  cabecalho.writeUInt16LE(1, base + 4);
  cabecalho.writeUInt16LE(32, base + 6);
  cabecalho.writeUInt32LE(img.length, base + 8);
  cabecalho.writeUInt32LE(offset, base + 12);
  offset += img.length;
});
const ico = Buffer.concat([cabecalho, ...imagens]);
fs.writeFileSync(path.join(root, "public", "favicon.ico"), ico);
fs.writeFileSync(path.join(root, "build", "icon.ico"), ico);
console.log("  favicon.ico / build/icon.ico");
console.log("Ícones gerados.");
