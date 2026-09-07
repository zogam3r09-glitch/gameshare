# Game Share — POC V0.1

Compartilhamento privado de tela/jogo entre amigos, com foco em baixa latência.

**Streamer** roda um app Electron no Windows, escolhe um monitor ou uma janela,
e recebe um link. **Quem assiste** abre o link no navegador — sem instalar nada,
sem cadastro.

Não é um clone do Discord. Esta fase existe só para provar o núcleo técnico:
captura no Windows → WebRTC → navegador.

---

## Arquitetura

```
Electron (streamer)  ──POST /api/rooms────────►  token-server  ──assina──►  token PUBLISHER
        │                                              ▲
        └──WebRTC (vídeo + áudio do sistema)──►  LiveKit SFU
                                                       ▲
Browser (viewer)  ──POST /viewer-token──►  token-server ┘  ──assina──►  token VIEWER
        └──WebRTC (assina tracks)────────►  LiveKit SFU
```

O `LIVEKIT_API_SECRET` vive **só** no token-server. Desktop e viewer nunca o
veem — recebem apenas tokens já assinados, com permissões decididas no servidor.

Detalhes, diagramas Mermaid e a tabela publisher/viewer:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Estrutura

```
apps/
  desktop/          Electron + React + TypeScript (electron-vite)
    src/main/       processo principal: captura, CSP, IPC
    src/preload/    ponte contextBridge (7 funções, zero Node exposto)
    src/renderer/   UI + publisher LiveKit
  viewer/           React + Vite — página /watch/:roomId
services/
  token-server/     Node + Express — única parte que conhece o segredo
packages/
  shared/           tipos, roomId, identidades, logger
scripts/
  livekit-dev.mjs   baixa e roda um LiveKit local (sem Docker)
```

---

## Requisitos

| Ferramenta | Versão testada |
| ---------- | -------------- |
| Windows    | 11 (10 deve funcionar) |
| Node.js    | 24.19 (mínimo 22.12) |
| pnpm       | 12.3 |
| Git        | 2.55 |

Sem Docker e sem banco de dados.

> **Windows:** evite colocar o projeto dentro de `AppData\Local\Packages\…`
> (caminhos virtualizados de apps MSIX). O pnpm não consegue rodar scripts de
> postinstall ali.

---

## Instalação

```bash
pnpm install
```

`pnpm-workspace.yaml` já libera os postinstall do `electron` e do `esbuild`
(`allowBuilds`). Se mesmo assim o binário do Electron não aparecer em
`node_modules/.pnpm/electron@*/node_modules/electron/dist/`, force uma vez:

```bash
pnpm approve-builds electron esbuild -y
```

---

## Configurar o LiveKit

Copie o exemplo e ajuste:

```bash
cp .env.example .env
```

### Opção A — LiveKit local (padrão, sem Docker)

O `.env.example` já vem apontado para `ws://127.0.0.1:7880` com credenciais de
desenvolvimento. Suba o servidor:

```bash
pnpm livekit:dev
```

Na primeira execução ele baixa o binário oficial do LiveKit para `.livekit/`
(ignorado pelo git) e roda em modo `--dev`. Use as mesmas
`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` do `.env` — o script lê de lá.

### Opção B — LiveKit Cloud

Crie um projeto em <https://cloud.livekit.io>, e no `.env`:

```
LIVEKIT_URL=wss://seu-projeto.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxxxxxx
LIVEKIT_API_SECRET=<segredo do projeto>
```

Nada mais muda. O token-server devolve a `LIVEKIT_URL` aos clientes, então
desktop e viewer seguem sem configuração própria de SFU.

### Variáveis de ambiente

Um `.env` único na raiz, lido pelos três pacotes.

| Variável | Onde é usada | Observação |
| -------- | ------------ | ---------- |
| `LIVEKIT_URL` | token-server | `ws://` ou `wss://`. É repassada aos clientes. |
| `LIVEKIT_API_KEY` | token-server | — |
| `LIVEKIT_API_SECRET` | token-server | **Nunca** chega ao cliente. Mínimo 32 caracteres. |
| `TOKEN_TTL_SECONDS` | token-server | Padrão `21600` (6 h). |
| `TOKEN_SERVER_PORT` / `TOKEN_SERVER_HOST` | token-server | Padrão `8787` / `127.0.0.1`. |
| `ALLOWED_ORIGINS` | token-server | CSV de origens com CORS liberado. |
| `VITE_TOKEN_SERVER_URL` | desktop + viewer | Vai para o bundle do cliente. |
| `VITE_VIEWER_BASE_URL` | token-server | Base do link `/watch/:roomId`. Troque por seu domínio em produção. |

Variáveis com prefixo `VITE_` **são embutidas no bundle do cliente**. Nunca
coloque segredos nelas.

---

## Executar

Tudo de uma vez (token-server + viewer + desktop, em paralelo):

```bash
pnpm dev
```

Ou separadamente, em quatro terminais:

```bash
pnpm livekit:dev
```

```bash
pnpm dev:server
```

```bash
pnpm dev:viewer
```

```bash
pnpm dev:desktop
```

| Serviço | URL |
| ------- | --- |
| LiveKit | `ws://127.0.0.1:7880` |
| token-server | <http://127.0.0.1:8787> (health em `/health`) |
| viewer | <http://localhost:5174> |
| renderer do desktop | <http://localhost:5173> (interno do Electron) |

---

## Testar localmente

### Automatizado

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm test
```

```bash
pnpm test:e2e
```

- `pnpm test` — 34 testes unitários (geração/validação de roomId, permissões
  dos tokens, contrato HTTP do token-server, comportamento com LiveKit ausente).
- `pnpm test:e2e` — Playwright sobre o viewer: rota, link inválido,
  normalização do roomId, estados explícitos, ausência de segredo no HTML.
  Sobe token-server e viewer sozinho. Requer `npx playwright install chromium`
  na primeira vez.

A permissão nativa de captura do Windows **não** é automatizada de propósito —
o teste ficaria frágil. Esse passo é manual.

### Manual (o caminho completo)

1. `pnpm livekit:dev` num terminal.
2. `pnpm dev` em outro.
3. Na janela do Electron: **CRIAR TRANSMISSÃO**.
4. Escolha um monitor ou uma janela pela miniatura.
5. **INICIAR TRANSMISSÃO**.
6. **COPIAR LINK** (ou **Abrir no navegador**).
7. Cole o link no Chrome. O vídeo deve aparecer.
8. Abra o mesmo link numa segunda aba/máquina — o contador de participantes
   deve subir nos dois lados.
9. **ENCERRAR TRANSMISSÃO** no desktop — o viewer deve mostrar
   "Transmissão encerrada" imediatamente, não uma tela em branco. O desktop
   desconecta e manda o token-server apagar a sala no SFU, então os
   espectadores caem na hora em vez de esperar o `emptyTimeout` (5 min).

---

## Limitações atuais

- **Só o preset 720p30 é testado.** Os outros (`1080p30`, `1080p60`, `1440p60`)
  aparecem no seletor de qualidade, mas ninguém mediu CPU nem latência neles.
  Só o 720p30 é marcado como "(testado)" na UI.
- **`simulcast: false`, de propósito.** Simulcast faz o streamer codificar
  várias camadas ao mesmo tempo — CPU que sai do jogo. Com um SFU e poucos
  amigos, a camada única é a escolha certa até alguém medir. Ligar sem medir só
  trocaria um problema por outro.
- **RTT não é exibido.** `remote-inbound-rtp.roundTripTime` só existe após os
  primeiros relatórios RTCP e some sem assinante; mostrar seria inventar número.
  Bitrate e FPS codificado vêm de `getRTCStatsReport()` (API pública).
- **Sem persistência.** Um `roomId` bem-formado sempre recebe token de viewer,
  mesmo que a sala nunca tenha existido — o viewer fica em "Aguardando
  transmissão…" em vez de "esse link não existe". Distinguir os dois casos
  exigiria guardar estado, o que está fora da V0.1.
- **Sem rate limiting** no token-server. Aceitável para localhost; obrigatório
  antes de expor à internet.
- **`audio: 'loopback'` captura o áudio do sistema inteiro**, não o da janela
  escolhida. É o que a API do Electron oferece hoje no Windows.
- **Sem microfone** (por decisão): a call continua no Discord.
- **Sem empacotamento.** Não há instalador nem `electron-builder`; roda em dev.
- **`connect-src` da CSP** libera `https:`/`wss:` genéricos porque a URL do
  LiveKit só é conhecida em runtime. Ver TODO em `docs/ARCHITECTURE.md`.
- **Electron packaged (`file://`) mandaria `Origin: null`.** Se for empacotar,
  adicione `null` a `ALLOWED_ORIGINS`.

---

## Próximos passos

1. Confirmar áudio do sistema em jogo real de tela cheia (DirectX/exclusivo).
2. Simulcast + presets 1080p30/60 com medição de latência.
3. Persistir salas e encerrar a sala no SFU quando o publisher sai
   (`RoomServiceClient.deleteRoom`).
4. Rate limiting e expiração curta de token no token-server.
5. Empacotar com `electron-builder` e apertar a CSP com as origens reais.
6. Deploy: viewer atrás de HTTPS com fallback de SPA, LiveKit Cloud ou SFU
   próprio, `VITE_VIEWER_BASE_URL` no domínio.
