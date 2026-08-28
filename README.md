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

## Executando

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

## Notas

- A transcrição ao vivo usa a Web Speech API, disponível no Chrome e Edge (em outros navegadores, grave o áudio e digite/cole a transcrição). No Chrome, o áudio do reconhecimento é processado por serviço do navegador — avalie a política de privacidade aplicável ao seu contexto clínico antes de usar com pacientes reais.
- A chamada ao modelo usa `claude-opus-5` com fallback de recusa habilitado (`fallbacks: "default"`), streaming e cache do prompt de sistema.
- **A anamnese gerada é apoio à documentação e deve ser revisada pelo profissional responsável antes de ir ao prontuário.**
