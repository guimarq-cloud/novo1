import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { generate as generateCert } from "selfsigned";
import { SYSTEM_PROMPT } from "./prompt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
const PORT = Number(process.env.PORT ?? 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 3443);

// Provedor do modelo de linguagem:
// - "anthropic" (padrão): API do Claude — melhor qualidade; o texto da
//   transcrição é processado nos servidores da Anthropic (exterior).
// - "ollama": modelo aberto rodando no PRÓPRIO servidor — nenhum dado
//   sai da máquina; use quando a residência nacional dos dados for
//   obrigatória (ver DEPLOY-BRASIL.md).
const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.1:8b";

const client = new Anthropic();

const app = express();
// Necessário atrás de proxies de hospedagem (Render, Fly etc.) para que
// req.secure reflita o HTTPS terminado na borda.
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));

// ---------- Autenticação por senha (para hospedagem na internet) ----------
// Sem APP_PASSWORD definida (uso local/desktop), nenhuma senha é exigida.
// Com APP_PASSWORD, /api/anamnese passa a exigir o cookie de sessão emitido
// por /api/login — protegendo a chave da API contra uso por estranhos.

const APP_PASSWORD = process.env.APP_PASSWORD ?? "";
const authRequired = APP_PASSWORD.length > 0;
const AUTH_COOKIE = "anamnese_auth";
const AUTH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const authKey = crypto
  .createHash("sha256")
  .update(`anamnese-auth-key:${APP_PASSWORD}`)
  .digest();

function signToken(expiresAt: number): string {
  const payload = String(expiresAt);
  const mac = crypto.createHmac("sha256", authKey).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return false;
  const expected = crypto.createHmac("sha256", authKey).update(payload).digest("base64url");
  const given = Buffer.from(mac);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return false;
  return Number(payload) > Date.now();
}

function getCookie(req: express.Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function isAuthenticated(req: express.Request): boolean {
  return !authRequired || verifyToken(getCookie(req, AUTH_COOKIE));
}

app.get("/api/auth-status", (req, res) => {
  res.json({ required: authRequired, authenticated: isAuthenticated(req) });
});

app.post("/api/login", (req, res) => {
  if (!authRequired) {
    res.json({ ok: true });
    return;
  }
  const body = req.body as { password?: unknown };
  const given = crypto
    .createHash("sha256")
    .update(String(typeof body.password === "string" ? body.password : ""))
    .digest();
  const wanted = crypto.createHash("sha256").update(APP_PASSWORD).digest();
  if (!crypto.timingSafeEqual(given, wanted)) {
    res.status(401).json({ error: "Senha incorreta." });
    return;
  }
  const expiresAt = Date.now() + AUTH_TTL_MS;
  const secure = req.secure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${signToken(expiresAt)}; Path=/; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; HttpOnly; SameSite=Lax${secure}`
  );
  res.json({ ok: true });
});

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

function isValidTurn(t: unknown): t is ChatTurn {
  if (typeof t !== "object" || t === null) return false;
  const turn = t as Record<string, unknown>;
  return (
    (turn.role === "user" || turn.role === "assistant") &&
    typeof turn.content === "string" &&
    turn.content.trim().length > 0
  );
}

/**
 * Modo 100% nacional: gera a anamnese num modelo aberto servido pelo
 * Ollama na própria máquina — a transcrição não sai do servidor.
 */
async function streamOllama(
  turns: ChatTurn[],
  send: (payload: Record<string, unknown>) => void
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: true,
        think: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...turns.map((t) => ({ role: t.role, content: t.content })),
        ],
      }),
    });
  } catch {
    throw new Error(
      `Não foi possível conectar ao Ollama em ${OLLAMA_URL}. Verifique se o serviço está no ar (docker compose --profile nacional up -d).`
    );
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Ollama respondeu ${response.status} para o modelo "${OLLAMA_MODEL}". ` +
        `Se o modelo ainda não foi baixado, rode: ollama pull ${OLLAMA_MODEL}. ${detail.slice(0, 200)}`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line) as {
        message?: { content?: string };
        done?: boolean;
        error?: string;
      };
      if (chunk.error) throw new Error(`Erro do Ollama: ${chunk.error}`);
      const text = chunk.message?.content;
      if (typeof text === "string" && text.length > 0) send({ type: "delta", text });
      if (chunk.done) return;
    }
  }
}

/**
 * Estrutura a anamnese a partir da conversa (transcrição + eventuais
 * respostas às dúvidas). Responde via Server-Sent Events com o texto em
 * streaming.
 */
app.post("/api/anamnese", async (req, res) => {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "Não autenticado. Informe a senha de acesso." });
    return;
  }
  const body = req.body as { messages?: unknown };
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const turns = rawMessages.filter(isValidTurn);

  if (turns.length === 0 || turns[0].role !== "user") {
    res.status(400).json({
      error: "Envie 'messages' com ao menos uma mensagem de usuário contendo a transcrição.",
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (payload: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  if (LLM_PROVIDER === "ollama") {
    try {
      await streamOllama(turns, send);
      send({ type: "done" });
    } catch (error) {
      console.error("Erro em /api/anamnese (ollama):", error);
      send({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Erro inesperado ao gerar a anamnese no modelo local.",
      });
    } finally {
      res.end();
    }
    return;
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = turns.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      // Fallback de recusa habilitado por padrão: se o modelo principal
      // recusar por política, a API refaz a chamada num modelo de fallback.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    });

    stream.on("text", (delta) => send({ type: "delta", text: delta }));

    const finalMessage = await stream.finalMessage();

    if (finalMessage.stop_reason === "refusal") {
      const explanation =
        finalMessage.stop_details?.type === "refusal"
          ? finalMessage.stop_details.explanation
          : undefined;
      send({
        type: "error",
        message:
          "O modelo recusou processar esta transcrição." +
          (explanation ? ` Motivo: ${explanation}` : ""),
      });
    } else if (finalMessage.stop_reason === "max_tokens") {
      send({
        type: "error",
        message: "A resposta excedeu o limite de tokens e foi truncada. Tente uma transcrição menor.",
      });
    } else {
      send({ type: "done" });
    }
  } catch (error) {
    let message = "Erro inesperado ao gerar a anamnese.";
    if (error instanceof Anthropic.AuthenticationError) {
      message =
        "Chave de API inválida ou ausente. Configure ANTHROPIC_API_KEY no arquivo .env do servidor.";
    } else if (error instanceof Anthropic.RateLimitError) {
      message = "Limite de requisições atingido. Aguarde alguns instantes e tente novamente.";
    } else if (error instanceof Anthropic.BadRequestError) {
      message = `Requisição inválida: ${error.message}`;
    } else if (error instanceof Anthropic.APIError) {
      message = `Erro da API (${error.status}): ${error.message}`;
    } else if (error instanceof Anthropic.AnthropicError) {
      // Erros do cliente antes da chamada HTTP (ex.: credenciais não resolvidas).
      message =
        "Não foi possível autenticar na API da Anthropic. Configure ANTHROPIC_API_KEY no arquivo .env do servidor (veja .env.example).";
    }
    console.error("Erro em /api/anamnese:", error);
    send({ type: "error", message });
  } finally {
    res.end();
  }
});

/** Inicia o servidor HTTP. Porta 0 escolhe uma porta livre (usado pelo app desktop). */
export function startServer(port: number = PORT) {
  return app.listen(port, () => {
    if (
      LLM_PROVIDER !== "ollama" &&
      !process.env.ANTHROPIC_API_KEY &&
      !process.env.ANTHROPIC_AUTH_TOKEN
    ) {
      console.warn(
        "Aviso: ANTHROPIC_API_KEY não definida. Configure-a em .env (veja .env.example) ou autentique-se com `ant auth login`."
      );
    }
  });
}

export { app };

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => Boolean(i))
    .filter((i) => i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

/**
 * Certificado autoassinado para acesso pelo celular na mesma rede
 * (navegadores móveis exigem HTTPS para liberar o microfone). Gerado uma
 * vez e persistido em .certs/.
 */
async function ensureCert(): Promise<{ key: string; cert: string }> {
  const certDir = path.resolve(here, "..", ".certs");
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath, "utf8"), cert: fs.readFileSync(certPath, "utf8") };
  }
  const altNames = [
    { type: 2 as const, value: "localhost" },
    ...lanAddresses().map((ip) => ({ type: 7 as const, ip })),
  ];
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);
  const pems = await generateCert([{ name: "commonName", value: "anamnese.local" }], {
    notAfterDate,
    keySize: 2048,
    extensions: [{ name: "subjectAltName", altNames }],
  });
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

/** Servidor HTTPS para uso pelo celular (PWA) na mesma rede Wi-Fi. */
export async function startHttpsServer(port: number = HTTPS_PORT) {
  const { key, cert } = await ensureCert();
  return https.createServer({ key, cert }, app).listen(port);
}

// Escuta a porta apenas quando executado diretamente (node dist/server.js /
// tsx src/server.ts); o app desktop importa startServer e escolhe a porta.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startServer().on("listening", () => {
    console.log(`Especialista em Documentação Médica rodando em http://localhost:${PORT}`);
  });
  if (!process.env.NO_HTTPS) {
    startHttpsServer()
      .then(() => {
        console.log("\nNo celular (mesma rede Wi-Fi), acesse e aceite o aviso de certificado:");
        for (const ip of lanAddresses()) {
          console.log(`  https://${ip}:${HTTPS_PORT}`);
        }
        console.log(
          'Depois use "Adicionar à Tela de Início" para instalar o app com ícone.\n'
        );
      })
      .catch((err) => {
        console.warn("HTTPS não iniciado (defina NO_HTTPS=1 para silenciar):", err.message);
      });
  }
}
