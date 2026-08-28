import "dotenv/config";
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

const client = new Anthropic();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));

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
 * Estrutura a anamnese a partir da conversa (transcrição + eventuais
 * respostas às dúvidas). Responde via Server-Sent Events com o texto em
 * streaming.
 */
app.post("/api/anamnese", async (req, res) => {
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
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
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
