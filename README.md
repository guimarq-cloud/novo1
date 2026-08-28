# 🩺 Especialista em Documentação Médica

Aplicativo web que **grava o atendimento**, **transcreve** a consulta bruta, confusa e coloquial, e **estrutura uma anamnese médica formal** — fiel ao que foi dito, sem dados inventados e sem conclusões próprias.

## Como funciona

1. **Gravação** — o navegador captura o áudio da consulta (MediaRecorder) e transcreve ao vivo em português (Web Speech API, pt-BR). O áudio fica disponível para conferência e download.
2. **Revisão** — a transcrição aparece em uma caixa editável; revise, corrija ou cole uma transcrição pronta.
3. **Estruturação** — o backend envia a transcrição ao Claude (API da Anthropic), que atua como especialista em documentação médica e devolve a anamnese em streaming, estritamente nas seções:
   - **IDENTIFICAÇÃO** (apenas idade/sexo)
   - **QUEIXA PRINCIPAL (QP)**
   - **HISTÓRIA DA DOENÇA ATUAL (HDA)** — cronológica
   - **HISTÓRICO PESSOAL/FAMILIAR**
   - **PLANO/CONDUTA**
4. **Dúvidas** — se a transcrição tiver contradições ou ambiguidades, o especialista **pergunta antes de finalizar** (perguntas numeradas + rascunho com pontos `[PENDENTE]`); as respostas geram a versão final.

### Regras de documentação aplicadas

- Terminologia médica formal ("pressão alta" → hipertensão arterial sistêmica; "falta de ar" → dispneia).
- Nunca inventa dados: dose não dita vira "(dose não informada)"; seção sem dados vira "Não relatado."
- Remove conversas triviais sem impacto clínico e elimina redundâncias.
- Não emite hipóteses diagnósticas, impressões subjetivas nem condutas próprias — registra apenas a conduta declarada pelo médico.

## Executando no navegador

Requisitos: Node.js 20+ e uma chave da API da Anthropic.

```bash
npm install
cp .env.example .env   # e preencha ANTHROPIC_API_KEY
npm run dev            # desenvolvimento (tsx watch)
```

Acesse http://localhost:3000. Para produção:

```bash
npm run build
npm start
```

## Aplicativo de desktop (macOS)

O app pode ser empacotado como aplicativo nativo do macOS (Electron), com ícone próprio e instalador `.dmg`:

```bash
npm install
npm run app        # roda o app desktop em modo de desenvolvimento
npm run dist:mac   # gera o instalador em release/ (rode em um Mac)
```

Abra o `.dmg` gerado em `release/` e arraste **Anamnese Médica** para Aplicativos (ou para a Mesa/Desktop, se preferir o ícone na área de trabalho).

Notas do desktop:

- **Chave da API**: no app empacotado, crie o arquivo `~/Library/Application Support/Anamnese Médica/.env` com a linha `ANTHROPIC_API_KEY=sk-ant-...`. O próprio app mostra o caminho exato num aviso quando a chave não é encontrada. Em desenvolvimento (`npm run app`), o `.env` da raiz do projeto é usado.
- **Microfone**: o macOS pede a permissão na primeira gravação (o texto da permissão já está configurado no app).
- **Transcrição no desktop**: o serviço de fala do Chrome não existe dentro do Electron; o app usa **transcrição local (Whisper via transformers.js)** — grave normalmente e clique em "Transcrever gravação (local)". Na primeira vez, o modelo (~80 MB) é baixado e fica em cache; o áudio nunca sai do computador. Para maior acurácia, troque `onnx-community/whisper-base` por `onnx-community/whisper-small` em `public/app.js` (download maior).
- **Build sem assinatura**: sem certificado de desenvolvedor Apple, o build sai não assinado — na primeira abertura, clique com o botão direito no app → "Abrir".

## Aplicativo de desktop (Windows)

Em um PC com Windows e [Node.js 20+](https://nodejs.org) instalado:

```powershell
git clone https://github.com/guimarq-cloud/novo1.git
cd novo1
git checkout claude/medical-documentation-specialist-kwyxz1
npm install
npm run dist:win
```

O instalador sai em `release/AnamneseMedica-Setup-1.0.0.exe`. Dois cliques nele instalam o app e **criam automaticamente o atalho "Anamnese Médica" na área de trabalho** (instalação em um clique, sem assistente).

Notas do Windows:

- **SmartScreen**: por não ser assinado, o Windows pode exibir "O Windows protegeu o computador" — clique em "Mais informações" → "Executar assim mesmo".
- **Chave da API**: crie o arquivo `%APPDATA%\Anamnese Médica\.env` com a linha `ANTHROPIC_API_KEY=sk-ant-...` (o app mostra o caminho exato num aviso quando a chave não é encontrada).
- **Microfone**: se a gravação não iniciar, verifique Configurações → Privacidade e segurança → Microfone → "Permitir que aplicativos da área de trabalho acessem seu microfone".
- **Transcrição local**: igual ao macOS — botão "Transcrever gravação (local)", com download único do modelo (~80 MB) na primeira vez.
- O build do Windows deve ser feito no próprio Windows (no macOS/Linux o electron-builder exigiria wine para gravar o ícone no executável).

## Notas

- No navegador, a transcrição ao vivo usa a Web Speech API (Chrome e Edge). Nesse modo o áudio do reconhecimento é processado por serviço do navegador — avalie a política de privacidade aplicável ao seu contexto clínico antes de usar com pacientes reais. A alternativa "Transcrever gravação (local)" processa tudo no dispositivo e também funciona em qualquer navegador.
- A chamada ao modelo usa `claude-opus-5` com fallback de recusa habilitado (`fallbacks: "default"`), streaming e cache do prompt de sistema.
- **A anamnese gerada é apoio à documentação e deve ser revisada pelo profissional responsável antes de ir ao prontuário.**
