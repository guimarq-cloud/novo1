// Baixa o modelo de transcrição (Whisper) para dentro do servidor, em
// public/models/, para que os navegadores o carreguem do próprio app —
// sem depender do Hugging Face a cada aparelho novo.
//
// Uso no servidor:  node scripts/fetch-whisper.mjs [modelo] [dtype]
// Padrão:           onnx-community/whisper-base  q8

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.argv[2] ?? "onnx-community/whisper-base";
const DTYPE = process.argv[3] ?? "q8";
const HF = "https://huggingface.co";

// Arquivos de configuração/tokenizador exigidos pelo transformers.js.
const CONFIG_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
];

// Sufixo dos pesos conforme o dtype (fp32 não tem sufixo).
const SUFFIX = { fp32: "", fp16: "_fp16", q8: "_quantized", int8: "_int8", q4: "_q4", uint8: "_uint8" };

async function listRepoFiles() {
  const res = await fetch(`${HF}/api/models/${MODEL}`);
  if (!res.ok) throw new Error(`Não foi possível consultar o repositório do modelo (HTTP ${res.status}).`);
  const info = await res.json();
  return (info.siblings ?? []).map((s) => s.rfilename);
}

async function download(file, destDir) {
  const dest = path.join(destDir, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  já existe: ${file}`);
    return;
  }
  const res = await fetch(`${HF}/${MODEL}/resolve/main/${file}`);
  if (!res.ok) throw new Error(`Falha ao baixar ${file} (HTTP ${res.status}).`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  console.log(`  baixado: ${file} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}

const destDir = path.join(root, "public", "models", MODEL);
const available = await listRepoFiles();

const suffix = SUFFIX[DTYPE];
if (suffix === undefined) throw new Error(`dtype desconhecido: ${DTYPE}`);

const weights = ["encoder_model", "decoder_model_merged"].map((base) => {
  const wanted = `onnx/${base}${suffix}.onnx`;
  if (available.includes(wanted)) return wanted;
  const plain = `onnx/${base}.onnx`;
  if (available.includes(plain)) {
    console.warn(`  aviso: ${wanted} não existe no repositório; usando ${plain}`);
    return plain;
  }
  throw new Error(`O repositório não contém ${wanted} nem ${plain}.`);
});

console.log(`Baixando ${MODEL} (${DTYPE}) para public/models/…`);
for (const file of CONFIG_FILES.filter((f) => available.includes(f))) {
  await download(file, destDir);
}
for (const file of weights) await download(file, destDir);

// Manifesto: diz ao navegador qual modelo/dtype está hospedado aqui.
const usedSuffix = weights[0].includes("_") ? weights[0].split("encoder_model")[1].replace(".onnx", "") : "";
const effectiveDtype = Object.keys(SUFFIX).find((k) => SUFFIX[k] === usedSuffix) ?? "fp32";
fs.writeFileSync(
  path.join(root, "public", "models", "manifest.json"),
  JSON.stringify({ model: MODEL, dtype: effectiveDtype }, null, 2) + "\n"
);
console.log(`\nPronto. Modelo hospedado no servidor (dtype: ${effectiveDtype}).`);
