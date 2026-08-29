# Implantação em servidor no Brasil (dados sensíveis / LGPD)

Guia para hospedar o app em um servidor localizado em território nacional, com a opção de **nenhum dado clínico sair do país**.

> **Aviso**: este guia é técnico, não é parecer jurídico. Valide o desenho final com o encarregado de dados (DPO) ou assessoria jurídica da sua instituição.

## 1. Entenda o fluxo dos dados antes de escolher

| Dado | Onde é processado |
|---|---|
| Áudio da consulta | **Nunca sai do aparelho** do usuário (gravação e transcrição acontecem no navegador) |
| Transcrição em texto | Vai do aparelho ao **seu servidor** (no Brasil, neste guia) |
| Estruturação da anamnese | Depende do modo abaixo |
| Armazenamento | **Nenhum** — o servidor não grava consultas em disco |

**Modo A — API da Anthropic (`LLM_PROVIDER=anthropic`, padrão):** melhor qualidade de estruturação, porém o texto da transcrição é processado nos servidores da Anthropic, **fora do Brasil**. Se a sua leitura da LGPD/da instituição veda qualquer transferência internacional de dado sensível, este modo só é aceitável com anonimização prévia do texto — e o padrão seguro é assumir que não atende ao requisito.

**Modo B — 100% nacional (`LLM_PROVIDER=ollama`):** a anamnese é gerada por um modelo aberto (via [Ollama](https://ollama.com)) rodando **dentro do próprio servidor brasileiro**. Nenhuma chamada externa com dado clínico. Trade-offs: exige um servidor maior (RAM/GPU) e a qualidade da estruturação é inferior à do Claude — a revisão médica do resultado, que já é obrigatória, torna-se ainda mais importante.

Para o requisito que você descreveu ("não é possível a transmissão destes dados para o exterior"), **use o Modo B**.

## 2. Contrate o servidor (VPS) em datacenter brasileiro

Qualquer provedor com VPS Ubuntu em datacenter no Brasil serve. Exemplos com infraestrutura nacional: **Magalu Cloud**, **KingHost**, **Locaweb**, **HostDime Brasil**; hyperscalers com região São Paulo: AWS (`sa-east-1`), Google Cloud (`southamerica-east1`), Azure (Brazil South) — para a leitura mais estrita de soberania, prefira provedor de capital nacional e confirme em contrato a localização dos dados.

Dimensionamento:

- **Modo A**: 2 vCPU / 4 GB RAM (o trabalho pesado é remoto).
- **Modo B (CPU)**: 8 vCPU / 16 GB RAM — roda `llama3.1:8b` a velocidade aceitável; a anamnese leva de dezenas de segundos a poucos minutos.
- **Modo B (GPU)**: VPS/bare metal com GPU NVIDIA (ex.: 16 GB VRAM) — resposta em segundos e permite modelos melhores (`qwen3:14b`, `llama3.3:70b` quantizado em GPUs maiores).

Peça **Ubuntu 24.04 LTS** e anote o IP público.

## 3. Aponte um domínio para o servidor

O HTTPS válido (exigido pelo microfone no celular e emitido automaticamente neste guia) precisa de um domínio:

1. Registre um domínio — para instituição brasileira, o natural é um `.com.br`/`.med.br` no [Registro.br](https://registro.br) (~R$ 40/ano).
2. No painel DNS, crie um registro **A** apontando para o IP do servidor, ex.: `anamnese.suaclinica.com.br → 203.0.113.10`.
3. Sem domínio, para testar: use `SEU-IP.sslip.io` (ex.: `203-0-113-10.sslip.io`) como domínio temporário.

## 4. Prepare o servidor (uma vez)

Conecte por SSH (`ssh root@IP-DO-SERVIDOR`) e rode:

```bash
# Atualizações e firewall
apt update && apt upgrade -y
apt install -y git ufw
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# Docker
curl -fsSL https://get.docker.com | sh
```

## 5. Instale o app

```bash
git clone https://github.com/guimarq-cloud/novo1.git /opt/anamnese
cd /opt/anamnese
git checkout claude/medical-documentation-specialist-kwyxz1
```

Crie o arquivo `.env` (`nano .env`) com o conteúdo do modo escolhido:

**Modo B — 100% nacional (recomendado para o seu requisito):**

```env
DOMINIO=anamnese.suaclinica.com.br
APP_PASSWORD=uma-senha-forte-aqui
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.1:8b
```

**Modo A — API da Anthropic:**

```env
DOMINIO=anamnese.suaclinica.com.br
APP_PASSWORD=uma-senha-forte-aqui
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

Suba os serviços:

```bash
# Modo B (inclui o Ollama):
docker compose --profile nacional up -d --build
docker compose exec ollama ollama pull llama3.1:8b   # baixa o modelo (uma vez, ~5 GB)

# Modo A:
docker compose up -d --build
```

O Caddy emite o certificado HTTPS sozinho na primeira visita (Let's Encrypt).

## 6. Teste e instale nos aparelhos

1. Abra `https://SEU-DOMINIO` num navegador — deve aparecer a tela "🔒 Acesso protegido"; entre com a `APP_PASSWORD`.
2. Cole uma transcrição de teste e gere a anamnese.
3. Nos celulares: Chrome → ⋮ → "Instalar app" / Safari → Compartilhar → "Adicionar à Tela de Início". Sem avisos de certificado.

## 7. Operação

```bash
cd /opt/anamnese
docker compose logs -f app          # logs
git pull && docker compose up -d --build   # atualizar o app
docker compose --profile nacional exec ollama ollama pull MODELO   # trocar/atualizar modelo
```

Trocar o modelo do Modo B: edite `OLLAMA_MODEL` no `.env` (ex.: `qwen3:14b` com 32 GB RAM ou GPU), rode o `ollama pull` correspondente e `docker compose up -d`.

## 8. Checklist LGPD (resumo técnico)

- [x] Servidor e processamento em território nacional (Modo B)
- [x] Nenhum armazenamento de consultas no servidor
- [x] Áudio nunca deixa o aparelho do usuário
- [x] Acesso por senha; sessões expiram em 30 dias; cookie HttpOnly/Secure
- [x] TLS (HTTPS) em todo o tráfego
- [ ] A seu cargo: termos de uso/consentimento do paciente, registro das operações de tratamento, política de acesso da equipe, backups do servidor e avaliação do DPO
