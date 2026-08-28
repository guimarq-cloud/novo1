// Copia o transformers.js e o runtime ONNX (wasm) para public/vendor/,
// para que a transcrição local funcione sem depender de CDN.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "public", "vendor");

const transformersSrc = path.join(root, "node_modules", "@huggingface", "transformers", "dist");
const ortSrc = path.join(root, "node_modules", "onnxruntime-web", "dist");

fs.mkdirSync(path.join(vendor, "transformers"), { recursive: true });
fs.mkdirSync(path.join(vendor, "ort"), { recursive: true });

fs.copyFileSync(
  path.join(transformersSrc, "transformers.min.js"),
  path.join(vendor, "transformers", "transformers.min.js")
);

for (const file of fs.readdirSync(ortSrc)) {
  if (file.startsWith("ort-wasm-simd-threaded.")) {
    fs.copyFileSync(path.join(ortSrc, file), path.join(vendor, "ort", file));
  }
}

console.log("vendor copiado para public/vendor/");
