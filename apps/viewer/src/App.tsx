import { useEffect, useRef, useState } from 'react';
import { ConnectionQuality } from 'livekit-client';
import { parseWatchPath } from '@game-share/shared';
import { useWatchRoom, type ReceiveStats } from './useWatchRoom.js';

const QUALITY_LABEL: Record<ConnectionQuality, string> = {
  [ConnectionQuality.Excellent]: 'Excelente',
  [ConnectionQuality.Good]: 'Boa',
  [ConnectionQuality.Poor]: 'Ruim',
  [ConnectionQuality.Lost]: 'Perdida',
  [ConnectionQuality.Unknown]: '—',
};

export function App(): React.JSX.Element {
  const roomId = parseWatchPath(window.location.pathname);
  if (!roomId) return <Message title="Link inválido" body="Confira o link que seu amigo enviou." />;
  return <Watch roomId={roomId} />;
}

function Watch({ roomId }: { roomId: string }): React.JSX.Element {
  const watch = useWatchRoom(roomId);
  const debug = new URLSearchParams(window.location.search).has('debug');
  const shellRef = useRef<HTMLDivElement>(null);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (watch.audioRef.current) watch.audioRef.current.volume = volume;
  }, [volume, watch.audioRef, watch.hasAudio]);

  useEffect(() => {
    const onChange = (): void => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // A barra some depois de um tempo parado para o video ocupar a tela inteira.
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    let timer: ReturnType<typeof setTimeout>;
    const wake = (): void => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), 2500);
    };
    const sleep = (): void => {
      clearTimeout(timer);
      setIdle(true);
    };

    wake();
    shell.addEventListener('mousemove', wake);
    shell.addEventListener('mouseleave', sleep);
    return () => {
      clearTimeout(timer);
      shell.removeEventListener('mousemove', wake);
      shell.removeEventListener('mouseleave', sleep);
    };
  }, []);

  // so escondemos a barra enquanto o video roda; nos outros estados ela informa
  const chromeHidden = idle && watch.phase === 'playing';

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shellRef.current?.requestFullscreen();
  };

  return (
    <div className={`shell ${chromeHidden ? 'shell--idle' : ''}`} ref={shellRef}>
      <video
        className={`stage ${watch.phase === 'playing' ? 'stage--on' : ''}`}
        ref={watch.videoRef}
        autoPlay
        playsInline
        muted /* o áudio sai pelo <audio> abaixo, com controle de volume próprio */
      />
      <audio ref={watch.audioRef} autoPlay />

      {watch.phase !== 'playing' && (
        <div className="overlay">
          {watch.phase === 'connecting' && <Spinner label="Conectando…" />}
          {watch.phase === 'waiting' && <Spinner label="Aguardando transmissão…" />}
          {watch.phase === 'ended' && (
            <Message title="Transmissão encerrada" body="O streamer finalizou a transmissão." />
          )}
          {watch.phase === 'error' && (
            <Message title="Não foi possível assistir" body={watch.error ?? ''} />
          )}
        </div>
      )}

      {debug && watch.phase === 'playing' && <DebugPanel stats={watch.stats} />}

      {watch.audioBlocked && watch.phase === 'playing' && (
        <button className="unmute" onClick={watch.enableAudio}>
          🔊 Clique para ativar o áudio
        </button>
      )}

      <footer className={`bar ${chromeHidden ? 'bar--hidden' : ''}`}>
        <span className="bar__room">{roomId}</span>

        <label className="bar__vol" title="Volume">
          🔈
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            disabled={!watch.hasAudio}
            onChange={(e) => setVolume(Number(e.currentTarget.value))}
          />
        </label>

        <span className="bar__item" title="Espectadores">
          👁 {watch.viewers}
        </span>
        <span className="bar__item" title="Qualidade da conexão">
          {QUALITY_LABEL[watch.quality]}
        </span>
        {!watch.hasAudio && watch.phase === 'playing' && (
          <span className="bar__item bar__item--warn">sem áudio</span>
        )}
        {/* A pessoa volta para a aba e ve a ultima imagem congelada por um
            instante; sem isto parece travamento em vez de retomada. */}
        {watch.videoPausado && (
          <span className="bar__item bar__item--warn" title="O áudio continuou tocando">
            vídeo pausado — aba em segundo plano
          </span>
        )}
        {watch.notice && <span className="bar__item bar__item--warn">{watch.notice}</span>}

        <button className="bar__btn" onClick={toggleFullscreen}>
          {fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
        </button>
      </footer>
    </div>
  );
}

/** Visivel apenas com ?debug=1. Numeros crus, sem interpretacao. */
function DebugPanel({ stats }: { stats: ReceiveStats }): React.JSX.Element {
  const rows: [string, string][] = [
    ['fps recebido', stats.fps !== null ? String(stats.fps) : '—'],
    ['jitter buffer', stats.jitterBufferMs !== null ? `${stats.jitterBufferMs} ms` : '—'],
    ['playout delay', stats.playoutDelayMs !== null ? `${stats.playoutDelayMs} ms` : '—'],
    ['congelamentos', stats.freezeCount !== null ? String(stats.freezeCount) : '—'],
    ['tempo congelado', stats.freezeMs !== null ? `${stats.freezeMs} ms` : '—'],
    ['pacotes perdidos', stats.packetsLost !== null ? String(stats.packetsLost) : '—'],
    ['decoder', stats.decoder ?? '—'],
  ];

  return (
    <dl className="debug">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Spinner({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="state">
      <div className="spinner" />
      <p>{label}</p>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }): React.JSX.Element {
  return (
    <div className="state">
      <h1>{title}</h1>
      <p className="state__body">{body}</p>
    </div>
  );
}
