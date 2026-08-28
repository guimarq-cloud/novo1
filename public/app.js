// Especialista em Documentação Médica — front-end
// Gravação de áudio (MediaRecorder) + transcrição ao vivo (Web Speech API)
// + geração da anamnese via backend (streaming SSE).

const btnRecord = document.getElementById("btn-record");
const recordStatus = document.getElementById("record-status");
const recordTimer = document.getElementById("record-timer");
const speechUnsupported = document.getElementById("speech-unsupported");
const audioPlayback = document.getElementById("audio-playback");
const audioPlayer = document.getElementById("audio-player");
const audioDownload = document.getElementById("audio-download");
const interimEl = document.getElementById("interim");
const transcriptEl = document.getElementById("transcript");
const btnGenerate = document.getElementById("btn-generate");
const btnReset = document.getElementById("btn-reset");
const errorEl = document.getElementById("error");
const resultWrap = document.getElementById("result-wrap");
const resultEl = document.getElementById("result");
const btnCopy = document.getElementById("btn-copy");
const followupEl = document.getElementById("followup");
const followupText = document.getElementById("followup-text");
const btnFollowup = document.getElementById("btn-followup");
const localTranscribe = document.getElementById("local-transcribe");
const btnTranscribe = document.getElementById("btn-transcribe");
const transcribeStatus = document.getElementById("transcribe-status");

// ---------- Gravação e transcrição ----------

// No Electron o construtor SpeechRecognition existe, mas o serviço de fala do
// Chrome não está disponível — usa-se a transcrição local (Whisper) no lugar.
const isElectron = navigator.userAgent.includes("Electron");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const liveSpeechAvailable = Boolean(SpeechRecognition) && !isElectron;
if (!liveSpeechAvailable) speechUnsupported.classList.remove("hidden");

let recognition = null;
let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let lastAudioBlob = null;
let recording = false;
let timerInterval = null;
let startedAt = 0;

function setTimer() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  recordTimer.textContent = `${mm}:${ss}`;
}

function appendTranscript(text) {
  const current = transcriptEl.value;
  transcriptEl.value = current + (current && !current.endsWith("\n") ? " " : "") + text.trim();
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function startRecognition() {
  if (!liveSpeechAvailable) return;
  recognition = new SpeechRecognition();
  recognition.lang = "pt-BR";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        appendTranscript(res[0].transcript);
      } else {
        interim += res[0].transcript;
      }
    }
    interimEl.textContent = interim;
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed") {
      recordStatus.textContent = "Permissão de microfone negada.";
      stopRecording();
    } else if (event.error === "network" || event.error === "service-not-allowed") {
      // Serviço de fala indisponível: segue gravando; transcrição local ao final.
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        /* ignorar */
      }
      recognition = null;
      speechUnsupported.classList.remove("hidden");
      recordStatus.textContent = "Gravando (transcreva localmente ao final)…";
    }
    // "no-speech"/"aborted" são recuperados pelo onend.
  };

  // O Chrome encerra o reconhecimento após silêncio; religa enquanto gravando.
  recognition.onend = () => {
    if (recording) {
      try {
        recognition.start();
      } catch {
        /* já reiniciado */
      }
    }
  };

  recognition.start();
}

async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    recordStatus.textContent = "Não foi possível acessar o microfone.";
    return;
  }

  audioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    lastAudioBlob = blob;
    const url = URL.createObjectURL(blob);
    audioPlayer.src = url;
    audioDownload.href = url;
    audioPlayback.classList.remove("hidden");
    localTranscribe.classList.remove("hidden");
  };
  mediaRecorder.start();

  recording = true;
  startedAt = Date.now();
  timerInterval = setInterval(setTimer, 500);
  setTimer();

  btnRecord.textContent = "⏹️ Parar gravação";
  btnRecord.classList.add("recording");
  recordStatus.textContent = liveSpeechAvailable
    ? "Gravando e transcrevendo…"
    : "Gravando (transcreva localmente ao final)…";

  startRecognition();
}

function stopRecording() {
  recording = false;
  if (recognition) {
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {
      /* ignorar */
    }
    recognition = null;
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  clearInterval(timerInterval);
  interimEl.textContent = "";
  btnRecord.textContent = "🎙️ Iniciar gravação";
  btnRecord.classList.remove("recording");
  recordStatus.textContent = "Gravação encerrada. Revise a transcrição abaixo.";
}

btnRecord.addEventListener("click", () => {
  if (recording) stopRecording();
  else startRecording();
});

// ---------- Transcrição local (Whisper) ----------
// Processa o áudio gravado no próprio dispositivo via transformers.js.
// Usada no app desktop (sem serviço de fala do Chrome) e como alternativa
// em qualquer navegador. O modelo (~80 MB) é baixado na primeira vez e
// fica em cache; o áudio nunca sai do computador.

const WHISPER_MODEL = "onnx-community/whisper-base";
let transcriberPromise = null;

function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await import(
        "/vendor/transformers/transformers.min.js"
      );
      // Runtime ONNX servido pelo próprio app (sem CDN); os pesos do modelo
      // vêm do Hugging Face na primeira vez e ficam em cache no dispositivo.
      env.backends.onnx.wasm.wasmPaths = "/vendor/ort/";
      return pipeline("automatic-speech-recognition", WHISPER_MODEL, {
        progress_callback: (info) => {
          if (info.status === "progress" && info.total) {
            const pct = Math.round((info.loaded / info.total) * 100);
            transcribeStatus.textContent = `Baixando modelo de transcrição… ${pct}% (só na primeira vez)`;
          }
        },
      });
    })();
    transcriberPromise.catch(() => {
      transcriberPromise = null;
    });
  }
  return transcriberPromise;
}

async function blobToMono16k(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const probe = new AudioContext();
  const decoded = await probe.decodeAudioData(arrayBuffer);
  probe.close();
  const targetRate = 16000;
  const offline = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * targetRate),
    targetRate
  );
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

btnTranscribe.addEventListener("click", async () => {
  if (!lastAudioBlob) return;
  btnTranscribe.disabled = true;
  transcribeStatus.textContent = "Preparando transcrição…";
  try {
    const transcriber = await getTranscriber();
    transcribeStatus.textContent = "Convertendo o áudio…";
    const audio = await blobToMono16k(lastAudioBlob);
    transcribeStatus.textContent = "Transcrevendo… (pode levar alguns minutos)";
    const output = await transcriber(audio, {
      language: "portuguese",
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = (output.text || "").trim();
    if (text) {
      appendTranscript(text);
      transcribeStatus.textContent = "Transcrição concluída. Revise o texto no passo 2.";
    } else {
      transcribeStatus.textContent = "Nenhuma fala reconhecida no áudio.";
    }
  } catch (err) {
    console.error(err);
    transcribeStatus.textContent =
      "Falha na transcrição local (na primeira vez é preciso internet para baixar o modelo).";
  } finally {
    btnTranscribe.disabled = false;
  }
});

// ---------- Geração da anamnese ----------

// Histórico da conversa com o especialista (transcrição + respostas às dúvidas).
let conversation = [];

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function renderResult(text) {
  // Converte apenas **negrito** e quebras de linha; escapa o restante.
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  resultEl.innerHTML = escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function hasPendingQuestions(text) {
  return /DÚVIDAS ANTES DE FINALIZAR|\[PENDENTE/i.test(text);
}

async function requestAnamnese() {
  errorEl.classList.add("hidden");
  followupEl.classList.add("hidden");
  resultWrap.classList.remove("hidden");
  resultEl.textContent = "";
  btnGenerate.disabled = true;
  btnFollowup.disabled = true;

  let fullText = "";
  try {
    const response = await fetch("/api/anamnese", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: conversation }),
    });

    if (response.status === 401) {
      showLogin();
      throw new Error("Sessão expirada ou não autenticada. Informe a senha de acesso.");
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Erro ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop();
      for (const evt of events) {
        const line = evt.trim();
        if (!line.startsWith("data: ")) continue;
        const payload = JSON.parse(line.slice(6));
        if (payload.type === "delta") {
          fullText += payload.text;
          renderResult(fullText);
        } else if (payload.type === "error") {
          throw new Error(payload.message);
        }
      }
    }

    if (!fullText.trim()) throw new Error("A resposta chegou vazia. Tente novamente.");

    conversation.push({ role: "assistant", content: fullText });
    if (hasPendingQuestions(fullText)) {
      followupEl.classList.remove("hidden");
      followupText.value = "";
    }
    btnReset.classList.remove("hidden");
  } catch (err) {
    showError(err.message || "Erro ao gerar a anamnese.");
    if (fullText) {
      // Mantém o parcial visível, mas não o registra como turno concluído.
      renderResult(fullText);
    } else {
      resultWrap.classList.add("hidden");
    }
    // Remove o último turno de usuário para permitir reenvio limpo.
    if (conversation.length && conversation[conversation.length - 1].role === "user") {
      conversation.pop();
    }
  } finally {
    btnGenerate.disabled = false;
    btnFollowup.disabled = false;
  }
}

btnGenerate.addEventListener("click", () => {
  const transcript = transcriptEl.value.trim();
  if (!transcript) {
    showError("Grave a consulta ou cole uma transcrição antes de gerar a anamnese.");
    return;
  }
  if (recording) stopRecording();
  conversation = [
    {
      role: "user",
      content: `Transcrição bruta da consulta:\n\n${transcript}`,
    },
  ];
  requestAnamnese();
});

btnFollowup.addEventListener("click", () => {
  const answers = followupText.value.trim();
  if (!answers) {
    showError("Escreva as respostas às dúvidas antes de enviar.");
    return;
  }
  conversation.push({
    role: "user",
    content: `Respostas às dúvidas levantadas:\n\n${answers}\n\nAgora entregue a versão final da anamnese.`,
  });
  requestAnamnese();
});

btnCopy.addEventListener("click", async () => {
  const last = conversation.filter((m) => m.role === "assistant").pop();
  const text = last ? last.content : resultEl.innerText;
  try {
    await navigator.clipboard.writeText(text);
    btnCopy.textContent = "✅ Copiado!";
  } catch {
    btnCopy.textContent = "Falha ao copiar";
  }
  setTimeout(() => (btnCopy.textContent = "📄 Copiar anamnese"), 2000);
});

// ---------- Autenticação (hospedagem com senha) ----------

const loginCard = document.getElementById("login-card");
const loginPassword = document.getElementById("login-password");
const btnLogin = document.getElementById("btn-login");
const loginError = document.getElementById("login-error");

function showLogin() {
  loginCard.classList.remove("hidden");
  loginCard.scrollIntoView({ behavior: "smooth", block: "start" });
  loginPassword.focus();
}

async function checkAuth() {
  try {
    const res = await fetch("/api/auth-status");
    const status = await res.json();
    if (status.required && !status.authenticated) showLogin();
  } catch {
    /* servidor local sem senha ou offline: segue sem login */
  }
}
checkAuth();

async function doLogin() {
  loginError.classList.add("hidden");
  btnLogin.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: loginPassword.value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Falha no login.");
    }
    loginCard.classList.add("hidden");
    loginPassword.value = "";
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove("hidden");
  } finally {
    btnLogin.disabled = false;
  }
}

btnLogin.addEventListener("click", doLogin);
loginPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});

// ---------- PWA ----------

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* cache offline é opcional; o app funciona sem ele */
  });
}

btnReset.addEventListener("click", () => {
  conversation = [];
  transcriptEl.value = "";
  resultEl.textContent = "";
  resultWrap.classList.add("hidden");
  followupEl.classList.add("hidden");
  errorEl.classList.add("hidden");
  btnReset.classList.add("hidden");
  audioPlayback.classList.add("hidden");
  localTranscribe.classList.add("hidden");
  transcribeStatus.textContent = "";
  lastAudioBlob = null;
  recordStatus.textContent = "";
  recordTimer.textContent = "";
});
