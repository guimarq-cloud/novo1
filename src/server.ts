import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
const PORT = Number(process.env.PORT ?? 3000);

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

app.listen(PORT, () => {
  console.log(`Especialista em Documentação Médica rodando em http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn(
      "Aviso: ANTHROPIC_API_KEY não definida. Configure-a em .env (veja .env.example) ou autentique-se com `ant auth login`."
    );
  }
});
