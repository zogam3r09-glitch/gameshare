import { useEffect, useMemo, useState } from 'react';
import { ConnectionQuality, ConnectionState } from 'livekit-client';
import {
  DEFAULT_PRESET,
  QUALITY_PRESETS,
  type CaptureSource,
  type QualityPresetName,
} from '@game-share/shared';
import { Broadcaster, type BroadcastState } from './broadcast.js';

const broadcaster = new Broadcaster();

/**
 * Ponte de automacao, SOMENTE em dev.
 *
 * A janela do Electron nao e controlavel por ferramentas de navegador, entao
 * sem isto nao ha como roteirizar uma transmissao — nem para teste, nem para
 * reproduzir um bug na mesma sequencia duas vezes. Com
 * `--remote-debugging-port`, da para chamar os mesmos metodos que os botoes
 * chamam.
 *
 * Fica atras de import.meta.env.DEV: no build de producao a propriedade nao
 * existe, entao nao vira superficie de ataque para quem executar o app.
 */
if (import.meta.env.DEV) {
  (globalThis as unknown as { __broadcaster: Broadcaster }).__broadcaster = broadcaster;
}

const QUALITY_LABEL: Record<ConnectionQuality, string> = {
  [ConnectionQuality.Excellent]: 'Excelente',
  [ConnectionQuality.Good]: 'Boa',
  [ConnectionQuality.Poor]: 'Ruim',
  [ConnectionQuality.Lost]: 'Perdida',
  [ConnectionQuality.Unknown]: 'Desconhecida',
};

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  [ConnectionState.Disconnected]: 'Desconectado',
  [ConnectionState.Connecting]: 'Conectando',
  [ConnectionState.Connected]: 'Conectado',
  [ConnectionState.Reconnecting]: 'Reconectando',
  [ConnectionState.SignalReconnecting]: 'Reconectando (sinal)',
};

/** O que esta segurando a qualidade, direto do RTCStats. */
const LIMIT_LABEL: Record<string, string> = {
  none: 'nenhum',
  cpu: 'CPU (encoder não dá conta)',
  bandwidth: 'banda',
  other: 'outro',
};

/**
 * `encoderImplementation` denuncia se a codificação é por software.
 * libvpx = VP8/VP9 na CPU; nomes com MediaFoundation/AMF/NVENC = GPU.
 */
function encoderLabel(impl: string | null): string {
  if (!impl) return '—';
  const software = /libvpx|openh264|libaom/i.test(impl);
  return `${impl} ${software ? '(software)' : '(hardware)'}`;
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<BroadcastState>(() => {
    let initial!: BroadcastState;
    broadcaster.subscribe((s) => (initial = s))();
    return initial;
  });

  useEffect(() => broadcaster.subscribe(setState), []);

  return (
    <main className="app">
      <header className="app__header">
        <h1>
          GAME SHARE <span className="app__tag">POC</span>
        </h1>
      </header>

      {state.error ? (
        <ErrorPanel message={state.error} onBack={() => broadcaster.reset()} />
      ) : state.phase === 'live' || state.phase === 'ending' ? (
        <LivePanel state={state} />
      ) : state.phase === 'choosing' || state.phase === 'starting' ? (
        <SourcePanel state={state} />
      ) : (
        <IdlePanel busy={state.phase === 'creating'} />
      )}

      {state.notice && !state.error && <p className="notice">{state.notice}</p>}
    </main>
  );
}

function IdlePanel({ busy }: { busy: boolean }): React.JSX.Element {
  return (
    <section className="panel panel--center">
      <p className="muted">
        Compartilhe sua tela ou uma janela com amigos. Eles assistem pelo navegador, sem instalar
        nada.
      </p>
      <button className="btn btn--primary" disabled={busy} onClick={() => void broadcaster.createBroadcast()}>
        {busy ? 'CRIANDO…' : 'CRIAR TRANSMISSÃO'}
      </button>
    </section>
  );
}

function SourcePanel({ state }: { state: BroadcastState }): React.JSX.Element {
  const starting = state.phase === 'starting';
  const screens = state.sources.filter((s) => s.kind === 'screen');
  const windows = state.sources.filter((s) => s.kind === 'window');

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Escolha o que transmitir</h2>
        <button
          className="btn btn--ghost"
          disabled={state.sourcesLoading || starting}
          onClick={() => void broadcaster.refreshSources()}
        >
          {state.sourcesLoading ? 'Atualizando…' : 'Atualizar lista'}
        </button>
      </div>

      {state.sourcesLoading && state.sources.length === 0 && (
        <p className="muted">Procurando monitores e janelas…</p>
      )}

      {!state.sourcesLoading && state.sources.length === 0 && (
        <p className="muted">
          Nenhuma fonte encontrada. Verifique em Configurações do Windows → Privacidade e segurança
          se a captura de tela está permitida e clique em “Atualizar lista”.
        </p>
      )}

      {screens.length > 0 && <SourceGroup title="Monitores" sources={screens} state={state} />}
      {windows.length > 0 && <SourceGroup title="Janelas" sources={windows} state={state} />}

      <div className="panel__foot">
        <label className="preset">
          Qualidade
          <span className="preset__hint" title="A resolução é um teto: telas menores são capturadas na resolução nativa, sem upscale. Escolher acima da sua tela só aumenta bitrate e FPS.">
            teto ⓘ
          </span>
          <select
            value={state.preset}
            disabled={starting}
            onChange={(e) => broadcaster.setPreset(e.currentTarget.value as QualityPresetName)}
          >
            {/* a resolucao e um teto: numa tela menor o ganho vem do bitrate */}
            {Object.values(QUALITY_PRESETS).map((p) => (
              <option key={p.name} value={p.name}>
                até {p.height}p{p.frameRate} · {Math.round(p.maxBitrate / 100_000) / 10} Mbps
                {p.name === DEFAULT_PRESET ? ' (padrão)' : ''}
              </option>
            ))}
          </select>
        </label>

        <button
          className="btn btn--primary"
          disabled={!state.selectedSourceId || starting}
          onClick={() => void broadcaster.start()}
        >
          {starting ? 'INICIANDO…' : 'INICIAR TRANSMISSÃO'}
        </button>
        <button className="btn btn--ghost" disabled={starting} onClick={() => void broadcaster.stop()}>
          Cancelar
        </button>
      </div>
    </section>
  );
}

function SourceGroup({
  title,
  sources,
  state,
}: {
  title: string;
  sources: CaptureSource[];
  state: BroadcastState;
}): React.JSX.Element {
  return (
    <>
      <h3 className="group">{title}</h3>
      <ul className="sources">
        {sources.map((source) => (
          <li key={source.id}>
            <button
              className={`source ${state.selectedSourceId === source.id ? 'source--on' : ''}`}
              disabled={state.phase === 'starting'}
              onClick={() => broadcaster.selectSource(source.id)}
              title={source.name}
            >
              {source.thumbnailDataUrl ? (
                <img src={source.thumbnailDataUrl} alt="" />
              ) : (
                <span className="source__noimg">sem preview</span>
              )}
              <span className="source__name">{source.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function LivePanel({ state }: { state: BroadcastState }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const { stats, room } = state;

  const sourceName = useMemo(
    () => state.sources.find((s) => s.id === state.selectedSourceId)?.name ?? '—',
    [state.sources, state.selectedSourceId],
  );

  const copy = async (): Promise<void> => {
    if (!room) return;
    const ok = await window.gameShare.copyToClipboard(room.watchUrl);
    setCopied(ok);
    setTimeout(() => setCopied(false), 2000);
  };

  const resolution = stats.width && stats.height ? `${stats.width} × ${stats.height}` : '—';
  // fonte → encoder, para dar para ver de onde o fps some
  const fps =
    stats.encodedFps !== null
      ? `${stats.sourceFps ?? '?'} → ${stats.encodedFps} fps`
      : '—';

  return (
    <section className="panel">
      <p className="live">
        <span className="live__dot" /> AO VIVO
      </p>

      {/* O que um usuario olha enquanto transmite. O resto e diagnostico. */}
      <dl className="stats">
        <Stat label="Fonte" value={sourceName} />
        <Stat label="Assistindo" value={String(stats.viewers)} />
        {/* "Conexão", nao "Qualidade": ao lado de um seletor chamado
            Qualidade, o nome antigo sugeria que era o preset escolhido. */}
        <Stat label="Conexão" value={QUALITY_LABEL[stats.quality]} />
        <Stat label="Áudio do sistema" value={stats.hasAudio ? 'Ativo' : 'Sem áudio'} />
      </dl>

      <label className="link">
        Link para os amigos
        <input readOnly value={room?.watchUrl ?? ''} onFocus={(e) => e.currentTarget.select()} />
      </label>

      <details className="details">
        <summary>Detalhes técnicos</summary>
        <dl className="stats stats--dense">
          <Stat label="Resolução (captura)" value={resolution} />
          <Stat
            label="Resolução (enviada)"
            value={
              stats.encodedWidth && stats.encodedHeight
                ? `${stats.encodedWidth} × ${stats.encodedHeight}` +
                  (stats.width && stats.encodedWidth < stats.width ? ' ⚠ reduzida' : '')
                : '—'
            }
          />
          <Stat label="FPS (fonte → enviado)" value={fps} />
          <Stat
            label="Tempo limitado"
            value={
              stats.limitedByCpuSeconds === null
                ? '—'
                : `CPU ${stats.limitedByCpuSeconds}s · banda ${stats.limitedByBandwidthSeconds ?? 0}s`
            }
          />
          <Stat label="Bitrate" value={stats.videoKbps !== null ? `${stats.videoKbps} kbps` : '—'} />
          <Stat label="Preset" value={state.preset} />
          <Stat label="Estado" value={CONNECTION_LABEL[stats.connection]} />
          <Stat label="RTT" value={stats.rttMs !== null ? `${stats.rttMs} ms` : '—'} />
          <Stat
            label="Banda estimada"
            value={stats.availableKbps !== null ? `${stats.availableKbps} kbps` : '—'}
          />
          <Stat label="Encoder" value={encoderLabel(stats.encoder)} />
          <Stat label="Gargalo" value={LIMIT_LABEL[stats.limitedBy ?? 'none'] ?? stats.limitedBy!} />
          <Stat
            label="Quadros perdidos"
            value={stats.framesDropped !== null ? String(stats.framesDropped) : '—'}
          />
        </dl>
      </details>

      {/* Fica ligado: clipe que exige lembrar de ligar antes nao clipa nada,
          porque quando a jogada acontece ela ja passou. */}
      <label className="clipe">
        <input
          type="checkbox"
          checked={state.clipeLigado}
          onChange={(e) => broadcaster.setClipe(e.currentTarget.checked)}
        />
        Clipe instantâneo
        <span className="muted">
          {state.clipeLigado
            ? ' — os últimos 30s ficam sempre guardados'
            : ' — desligado, não dá para clipar o que já passou'}
        </span>
      </label>

      <div className="panel__foot">
        {state.clipeLigado && (
          <button
            className="btn"
            disabled={state.clipeSegundos < 2}
            onClick={() => void broadcaster.clipar()}
          >
            {state.clipeSegundos < 2
              ? 'PREPARANDO…'
              : `CLIPAR ÚLTIMOS ${state.clipeSegundos}s`}
          </button>
        )}
        <button className="btn" onClick={() => void copy()}>
          {copied ? 'COPIADO ✓' : 'COPIAR LINK'}
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => void window.gameShare.openExternal(room?.watchUrl ?? '')}
        >
          Abrir no navegador
        </button>
        <button
          className="btn btn--danger"
          disabled={state.phase === 'ending'}
          onClick={() => void broadcaster.stop()}
        >
          {state.phase === 'ending' ? 'ENCERRANDO…' : 'ENCERRAR TRANSMISSÃO'}
        </button>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ErrorPanel({
  message,
  onBack,
}: {
  message: string;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <section className="panel panel--center">
      <h2 className="error__title">Algo deu errado</h2>
      <p className="error__msg">{message}</p>
      <button className="btn" onClick={onBack}>
        VOLTAR
      </button>
    </section>
  );
}
