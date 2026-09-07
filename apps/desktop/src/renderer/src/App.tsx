import { useEffect, useMemo, useState } from 'react';
import { ConnectionQuality, ConnectionState } from 'livekit-client';
import { QUALITY_PRESETS, type CaptureSource, type QualityPresetName } from '@game-share/shared';
import { Broadcaster, type BroadcastState } from './broadcast.js';

const broadcaster = new Broadcaster();

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
          <select
            value={state.preset}
            disabled={starting}
            onChange={(e) => broadcaster.setPreset(e.currentTarget.value as QualityPresetName)}
          >
            {Object.values(QUALITY_PRESETS).map((p) => (
              <option key={p.name} value={p.name}>
                {p.height}p{p.frameRate}
                {p.name === '720p30' ? ' (testado)' : ''}
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
  const fps =
    stats.encodedFps !== null
      ? `${stats.encodedFps} fps`
      : stats.captureFps !== null
        ? `${stats.captureFps} fps (captura)`
        : '—';

  return (
    <section className="panel">
      <p className="live">
        <span className="live__dot" /> AO VIVO
      </p>

      <dl className="stats">
        <Stat label="Fonte" value={sourceName} />
        <Stat label="Resolução" value={resolution} />
        <Stat label="FPS" value={fps} />
        <Stat label="Bitrate" value={stats.videoKbps !== null ? `${stats.videoKbps} kbps` : '—'} />
        <Stat label="Áudio do sistema" value={stats.hasAudio ? 'Ativo' : 'Sem áudio'} />
        <Stat label="Participantes" value={String(stats.viewers)} />
        <Stat label="Conexão" value={CONNECTION_LABEL[stats.connection]} />
        <Stat label="Qualidade" value={QUALITY_LABEL[stats.quality]} />
        <Stat label="Encoder" value={encoderLabel(stats.encoder)} />
        <Stat label="Gargalo" value={LIMIT_LABEL[stats.limitedBy ?? 'none'] ?? stats.limitedBy!} />
        <Stat
          label="Quadros perdidos"
          value={stats.framesDropped !== null ? String(stats.framesDropped) : '—'}
        />
      </dl>

      <label className="link">
        Link para os amigos
        <input readOnly value={room?.watchUrl ?? ''} onFocus={(e) => e.currentTarget.select()} />
      </label>

      <div className="panel__foot">
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
