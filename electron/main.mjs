// Processo principal do app desktop (Electron).
// Sobe o servidor Express embutido numa porta livre e abre a janela.

import { app, BrowserWindow, session, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

app.setName("Anamnese Médica");

// A chave da API pode ficar em um .env dentro dos dados do usuário
// (~/Library/Application Support/Anamnese Médica/.env no macOS) ou, em
// desenvolvimento, na raiz do projeto — o dotenv do servidor cuida do segundo.
function loadUserEnv() {
  const userEnvPath = path.join(app.getPath("userData"), ".env");
  if (!fs.existsSync(userEnvPath)) return userEnvPath;
  for (const line of fs.readFileSync(userEnvPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  return userEnvPath;
}

app.whenReady().then(async () => {
  const userEnvPath = loadUserEnv();

  const serverModule = pathToFileURL(
    path.join(app.getAppPath(), "dist", "server.js")
  ).href;
  const { startServer } = await import(serverModule);

  const server = startServer(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();

  // Concede microfone e clipboard sem diálogo do Chromium (o macOS ainda
  // pede a permissão de microfone do sistema na primeira vez).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(["media", "clipboard-sanitized-write"].includes(permission));
  });

  const win = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 720,
    minHeight: 600,
    title: "Anamnese Médica",
    backgroundColor: "#f4f7f9",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    dialog.showMessageBox(win, {
      type: "warning",
      title: "Chave da API não configurada",
      message: "A chave da API da Anthropic não foi encontrada.",
      detail:
        `Crie o arquivo abaixo com a linha ANTHROPIC_API_KEY=sk-ant-... e reabra o aplicativo:\n\n${userEnvPath}\n\n` +
        "Sem a chave é possível gravar e transcrever, mas não gerar a anamnese.",
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      new BrowserWindow({ width: 1120, height: 860 }).loadURL(
        `http://127.0.0.1:${port}/`
      );
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
