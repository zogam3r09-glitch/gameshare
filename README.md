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

## Publicar (um amigo assistindo de outra rede)

Tudo até aqui roda numa máquina só. Para alguém de fora assistir, três peças
precisam estar acessíveis. O `.env.example` tem o bloco "CENÁRIO 2" pronto.

### 1. LiveKit Cloud

Crie um projeto em <https://cloud.livekit.io>, copie as credenciais em
**Settings → Keys** e ajuste no `.env`:

```
LIVEKIT_URL=wss://seu-projeto.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxxxxxx
LIVEKIT_API_SECRET=<segredo do projeto>
```

Nenhuma mudança de código: o token-server devolve essa URL aos clientes.

### 2. Token server (Render)

Existe um [`render.yaml`](render.yaml) pronto. No Render:
**New → Blueprint**, aponte para este repositório, e preencha os cinco valores
que ele pedir (`LIVEKIT_*`, `ALLOWED_ORIGINS`, `VITE_VIEWER_BASE_URL`).

Os dois que quebram em silêncio já vêm fixos no blueprint:

- `TOKEN_SERVER_HOST=0.0.0.0` — o padrão `127.0.0.1` só aceita conexões locais
  e o host nunca alcançaria o processo
- `TRUST_PROXY=1` — sem isso o rate limit vê só o IP do proxy e limita todos
  os visitantes juntos

A porta vem de `PORT`, que o Render injeta. O `healthCheckPath: /health` faz
um deploy com configuração incompleta falhar ali, em vez de subir quebrado.

> **Plano free dorme após ~15 min sem tráfego.** Na prática não atrapalha: você
> clica em CRIAR TRANSMISSÃO, isso já acorda o servidor, e quando o amigo abre
> o link segundos depois ele está quente.

Outro host de Node serve igual — o comando é
`pnpm --filter @game-share/token-server start`, que roda via `tsx` (por isso
`tsx` está em `dependencies`, não em `devDependencies`).

### 3. Viewer (Cloudflare Pages)

No Cloudflare Pages, conecte o repositório e configure:

| Campo | Valor |
| ----- | ----- |
| Build command | `corepack enable && pnpm install && pnpm --filter @game-share/viewer build` |
| Output directory | `apps/viewer/dist` |
| Variável de ambiente | `VITE_TOKEN_SERVER_URL=https://<seu-servico>.onrender.com` |

O fallback de SPA já está resolvido: `apps/viewer/public/_redirects` é lido
pelo Cloudflare sozinho. Sem ele, `/watch/XXXX-XXXX` daria 404, porque o
caminho não é um arquivo. Equivalentes em outros hosts:

| Host | Configuração |
| ---- | ------------ |
| Netlify, Cloudflare Pages | `public/_redirects` (já incluído) |
| Vercel | `{"rewrites":[{"source":"/(.*)","destination":"/index.html"}]}` em `vercel.json` |
| nginx | `try_files $uri $uri/ /index.html;` |

**`VITE_TOKEN_SERVER_URL` precisa existir no momento do BUILD**, não só em
runtime — ela é embutida no bundle. Verificado: o Vite lê variáveis `VITE_*`
do ambiente do host e elas têm precedência sobre qualquer `.env` do
repositório, então definir no painel do Cloudflare basta.

### Ordem que evita retrabalho

Os dois lados referenciam o domínio um do outro, o que parece um impasse. Não é:

1. Suba o **token-server** primeiro com `ALLOWED_ORIGINS` e
   `VITE_VIEWER_BASE_URL` provisórios. Anote a URL `.onrender.com`.
2. Suba o **viewer** com `VITE_TOKEN_SERVER_URL` já apontando para ela. Anote
   a URL `.pages.dev`.
3. Volte ao Render e corrija `ALLOWED_ORIGINS` e `VITE_VIEWER_BASE_URL` para o
   domínio real do viewer.
4. Leia o log do Render: se algum dos dois estiver errado, a validação de
   coerência avisa em texto claro no startup.

### Checklist

Os cinco primeiros itens são **verificados sozinhos**: o token-server checa a
coerência da configuração ao subir e avisa no log. Não precisa decorar nada —
suba o servidor com o `.env` de produção e leia a saída.

```
WARN [token-server] configuracao incoerente: VITE_VIEWER_BASE_URL usa https
     mas LIVEKIT_URL usa ws:// — o navegador recusa WebSocket inseguro numa
     pagina segura. Use wss://
```

Cobertos automaticamente:

- `LIVEKIT_URL` em `ws://` com viewer em HTTPS
- `VITE_TOKEN_SERVER_URL` em `http://` com viewer em HTTPS (conteúdo misto)
- entrada de `ALLOWED_ORIGINS` com barra final (o header `Origin` nunca tem,
  então a entrada nunca casa)
- origem do viewer ausente de `ALLOWED_ORIGINS`
- `TOKEN_SERVER_HOST=127.0.0.1` com viewer público

Manuais, porque dependem do host:

- [ ] Fallback de SPA: abrir `/watch/ABCD-EFGH` direto na barra de endereços
      não pode dar 404 (verificado no build local; falta confirmar no host)
- [ ] Se empacotar o Electron, acrescente `null` a `ALLOWED_ORIGINS` (janela
      em `file://` envia `Origin: null`)

---

## Diagnóstico

Quando a transmissão não estiver fluida, os números vêm antes do palpite.

**No terminal do desktop**, a cada ~6 s enquanto está no ar:

```
INFO [broadcast] metricas {"pedido":"2560x1440@60","resolucao":"1920x1080","fpsCaptura":60,
                           "fpsCodificado":32,"kbps":10160,"encoder":"libvpx","gargalo":"none",...}
```

| Campo | O que denuncia |
| ----- | -------------- |
| `resolucao` menor que `pedido` | normal: `max` não faz upscale, a tela é o limite |
| `resolucao` **maior** que `pedido` | as constraints foram ignoradas |
| `fpsCodificado` ≪ `fpsCaptura` | o encoder não acompanha |
| `fpsCodificado` **constante** apesar de mudar a entrada | teto fixo em algum lugar, não falta de CPU |
| `encoder` | `libvpx`/`openh264` = software; nomes com `MediaFoundation`/`AMF` = GPU |
| `gargalo` | `cpu`, `bandwidth` ou `none` — mas `none` **não** significa "está tudo bem" |
| `espectadores: 0` | **descarte a amostra.** Sem assinante o `dynacast` reduz a codificação de propósito; fps e kbps baixos aí não significam nada |

**No viewer**, adicione `?debug=1` à URL para ver fps recebido, jitter buffer,
congelamentos e pacotes perdidos no canto da tela.

**Sonda automatizada**, que mede fonte → encoder → receptor na mesma corrida:

```bash
pnpm --filter @game-share/viewer exec playwright test latency-probe
```

Ela imprime `fonteFps` de propósito: a canvas do teste é limitada pelo Chromium
em aba de segundo plano, então o que importa é a **diferença entre os estágios**,
nunca o valor absoluto.

---

## Limitações atuais

- **O número do preset é um teto, não um alvo.** As constraints usam `max`, e
  `max` nunca faz upscale. Numa tela 1920×1080, escolher `1440p60` **não** dá
  1440p: dá a resolução nativa 1080p com o bitrate e o framerate daquele preset
  (10 Mbps / 60 fps em vez de 2,5 Mbps / 30 fps). Foi assim que a perda de
  qualidade percebida sumiu nos testes — o ganho veio de bitrate, não de pixels.
- **Nada foi testado em jogo ainda.** Área de trabalho e janelas comuns rodam
  fluidas em 720p30 e em 1440p60. Jogo em movimento pesado é outro regime: o
  encoder é `libvpx` (software), e é onde ele pode não acompanhar.
- **`simulcast: false`, de propósito.** Simulcast faz o streamer codificar
  várias camadas ao mesmo tempo — CPU que sai do jogo. Com um SFU e poucos
  amigos, a camada única é a escolha certa até alguém medir. Ligar sem medir só
  trocaria um problema por outro.
- **RTT não é exibido.** `remote-inbound-rtp.roundTripTime` só existe após os
  primeiros relatórios RTCP e some sem assinante; mostrar seria inventar número.
  Bitrate e FPS codificado vêm de `getRTCStatsReport()` (API pública).
- **Registro de salas é em memória.** O token-server lembra as salas que criou
  e recusa espectadores em salas **encerradas** (410 `ROOM_ENDED`), para o link
  antigo dizer "Transmissão encerrada" em vez de esperar para sempre. Mas uma
  sala **desconhecida** continua recebendo token de propósito: o processo pode
  ter reiniciado com a transmissão no ar — no plano gratuito do Render ele
  dorme após 15 min — e tratar desconhecida como inexistente quebraria todo
  link ativo no despertar. Consequência: "esse link nunca existiu" continua
  indistinguível de "aguardando". Resolver de vez exige armazenamento externo.
- **Rate limiting é por processo, em memória.** Suficiente para uma instância;
  com várias réplicas cada uma conta separado. Escalar exigiria um store
  compartilhado (Redis), fora do escopo enquanto for uma instância só.
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
