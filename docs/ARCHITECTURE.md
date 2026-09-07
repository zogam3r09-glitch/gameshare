# Arquitetura — Game Share POC V0.1

## Visão geral

Três processos independentes. O único que conhece o segredo do LiveKit é o
**token-server**; desktop e viewer só recebem tokens já assinados.

```mermaid
flowchart LR
    subgraph desktop["Electron (Windows)"]
        M["main process<br/>desktopCapturer<br/>setDisplayMediaRequestHandler"]
        P["preload<br/>contextBridge"]
        R["renderer (React)<br/>livekit-client"]
        M <-->|IPC tipado| P
        P <-->|window.gameShare| R
    end

    TS["token-server (Node)<br/>livekit-server-sdk<br/>LIVEKIT_API_SECRET"]
    LK["LiveKit SFU<br/>local ou Cloud"]

    subgraph browser["Navegador do amigo"]
        V["viewer (React)<br/>livekit-client"]
    end

    R -->|"1. POST /api/rooms"| TS
    TS -->|"2. roomId + token PUBLISHER + watchUrl"| R
    R -->|"3. WebRTC: publica screen + system audio"| LK

    V -->|"4. POST /api/rooms/:id/viewer-token"| TS
    TS -->|"5. token VIEWER"| V
    V -->|"6. WebRTC: assina tracks"| LK
    LK -.->|"vídeo + áudio"| V

    style TS fill:#1f6feb,color:#fff
    style LK fill:#8957e5,color:#fff
```

## Separação publisher / viewer

As permissões nunca vêm do cliente. Elas são montadas apenas em
[`services/token-server/src/tokens.ts`](../services/token-server/src/tokens.ts):

| Grant              | PUBLISHER | VIEWER |
| ------------------ | :-------: | :----: |
| `roomJoin`         |     ✅    |   ✅   |
| `canSubscribe`     |     ✅    |   ✅   |
| `canPublish`       |     ✅    |   ❌   |
| `canPublishData`   |     ✅    |   ❌   |
| `room` (escopo)    | 1 sala    | 1 sala |

Consequências:

- Um espectador que edite o JS da página **não** consegue publicar: o token
  assinado no servidor não carrega `canPublish`, e o SFU rejeita.
- Um token vale para **uma sala só** (`room: roomId` no grant). Vazar o link de
  uma transmissão não dá acesso a outra.
- O `roomId` é gerado **no servidor** (`POST /api/rooms` ignora qualquer corpo).
  O cliente nunca escolhe o nome da sala.

## Identidades

`pub-<hex>` para o streamer, `view-<hex>` para espectadores
([`packages/shared/src/identity.ts`](../packages/shared/src/identity.ts)).
Isso deixa os dois lados contarem espectadores e detectarem "o streamer saiu"
usando só `room.remoteParticipants`, sem metadados inventados.

## Fluxo de captura no Windows

```mermaid
sequenceDiagram
    participant U as Usuário
    participant R as Renderer
    participant P as Preload
    participant M as Main
    participant C as Chromium

    U->>R: clica na miniatura do monitor/janela
    R->>P: selectCaptureSource(sourceId)
    P->>M: IPC capture:select
    M->>M: valida o id e "arma" a fonte
    U->>R: clica INICIAR TRANSMISSÃO
    R->>C: navigator.mediaDevices.getDisplayMedia()
    C->>M: setDisplayMediaRequestHandler
    M->>M: relê desktopCapturer.getSources() e acha a fonte armada
    M-->>C: callback({ video: source, audio: 'loopback' })
    C-->>R: MediaStream (vídeo + áudio do sistema)
    R->>R: publica no LiveKit
```

Pontos importantes:

- `useSystemPicker: false` — a escolha acontece na nossa UI, com thumbnail.
- Se nenhuma fonte estiver armada, o handler responde `callback({})` e o
  `getDisplayMedia` rejeita. Não existe caminho para capturar sem escolha
  explícita do usuário.
- A fonte é relida no momento do handler: se a janela foi fechada nesse
  intervalo, o erro é explícito em vez de capturar a janela errada.
- `audio: 'loopback'` captura o áudio **do sistema** (Windows). Não capturamos
  microfone nesta fase — a call continua no Discord.

## Segurança do Electron

| Item | Valor |
| ---- | ----- |
| `contextIsolation` | `true` |
| `nodeIntegration` | `false` |
| `sandbox` | `true` (main e preload compilados em CJS por isso) |
| `webSecurity` | `true` |
| Superfície do preload | 7 funções, sem nenhuma API de Node |
| Permissões | só `display-capture`; todo o resto é negado |
| `window.open` / navegação externa | bloqueados |
| CSP | injetada por `onHeadersReceived` no main |

CSP em produção:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:;
connect-src 'self' https: wss:; object-src 'none'; frame-src 'none';
base-uri 'none'; form-action 'none'
```

Em dev, `script-src` ganha `'unsafe-inline' 'unsafe-eval'` e `connect-src`
ganha `localhost`/`127.0.0.1` por causa do HMR do Vite.

> **TODO (v0.2):** estreitar `connect-src` para as origens exatas do
> token-server e do LiveKit. Hoje a URL do LiveKit só é conhecida em runtime
> (vem na resposta do token-server), e duplicá-la numa var `VITE_*` só para
> montar a CSP criaria duas fontes de verdade que saem de sincronia.

## Qualidade

Preset único na V0.1: **720p30**, `simulcast: false`,
`degradationPreference: 'maintain-framerate'` (para jogo, fps importa mais que
nitidez). Os presets 1080p30 / 1080p60 / 1440p60 já existem em
[`packages/shared/src/types.ts`](../packages/shared/src/types.ts) — trocar é
mudar `DEFAULT_PRESET`. Não foram testados nem otimizados.

## Métricas

Só API pública do SDK:

| Métrica | Origem |
| ------- | ------ |
| Resolução | `mediaStreamTrack.getSettings()` |
| FPS de captura | `mediaStreamTrack.getSettings().frameRate` |
| FPS codificado | `LocalTrack.getRTCStatsReport()` → `outbound-rtp.framesPerSecond` |
| Bitrate | delta de `outbound-rtp.bytesSent` entre duas amostras (1,5 s) |
| Qualidade | `RoomEvent.ConnectionQualityChanged` |
| Estado | `RoomEvent.ConnectionStateChanged` |
| Espectadores | `room.remoteParticipants` filtrado por prefixo de identidade |

> **TODO (v0.2):** RTT. `remote-inbound-rtp.roundTripTime` só aparece depois
> dos primeiros relatórios RTCP e some quando não há assinante, então ainda não
> é um número honesto de exibir. Fica de fora até haver viewer real conectado.

Nenhuma propriedade privada do LiveKit é acessada.

## Trocar localhost por domínio

Nada no código conhece `localhost`. Só o `.env`:

- `VITE_VIEWER_BASE_URL` — base usada para montar o link `/watch/:roomId`
  (`buildWatchUrl`, no token-server).
- `LIVEKIT_URL` — o token-server devolve essa URL para os clientes, então
  desktop e viewer sempre apontam para o mesmo SFU sem configuração própria.
- `ALLOWED_ORIGINS` — CORS do token-server.

Para produção: `VITE_VIEWER_BASE_URL=https://seu-dominio`,
`LIVEKIT_URL=wss://…`, e servir a build do viewer com fallback de SPA.
