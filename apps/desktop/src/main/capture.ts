import { desktopCapturer, session, type DesktopCapturerSource } from 'electron';
import { createLogger, errorMessage, type CaptureSource } from '@game-share/shared';

const log = createLogger('main/capture');

const THUMBNAIL = { width: 320, height: 180 };

/**
 * Fonte escolhida explicitamente pelo usuario na UI, armada logo antes do
 * renderer chamar `getDisplayMedia()`. Sem isso o pedido de captura e negado.
 */
let armedSourceId: string | null = null;

/** Windows: `loopback` captura o audio do sistema. Desligado se falhar uma vez. */
let loopbackAudioAvailable = process.platform === 'win32';

export function isLoopbackAudioAvailable(): boolean {
  return loopbackAudioAvailable;
}

/** True apenas na janela entre o clique em INICIAR e o getDisplayMedia resolver. */
export function isSourceArmed(): boolean {
  return armedSourceId !== null;
}

function toCaptureSource(source: DesktopCapturerSource, screenIndex: number): CaptureSource {
  const isScreen = source.id.startsWith('screen:');
  let thumbnailDataUrl = '';
  try {
    thumbnailDataUrl = source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL();
  } catch (err) {
    log.warn('falha ao gerar thumbnail', { id: source.id, message: errorMessage(err) });
  }

  return {
    id: source.id,
    // Electron devolve "Screen 1" / "Entire screen"; deixamos consistente em PT.
    name: isScreen ? `Monitor ${screenIndex}` : source.name || 'Janela sem titulo',
    kind: isScreen ? 'screen' : 'window',
    thumbnailDataUrl,
  };
}

export async function listSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: THUMBNAIL,
    fetchWindowIcons: false,
  });

  let screenIndex = 0;
  const mapped = sources
    // janelas sem titulo costumam ser overlays invisiveis; poluem a lista
    .filter((s) => s.id.startsWith('screen:') || s.name.trim().length > 0)
    .map((s) => toCaptureSource(s, s.id.startsWith('screen:') ? ++screenIndex : 0));

  // monitores primeiro, depois janelas em ordem alfabetica
  mapped.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'screen' ? -1 : 1,
  );

  log.info('fontes de captura listadas', {
    total: mapped.length,
    monitores: mapped.filter((s) => s.kind === 'screen').length,
    janelas: mapped.filter((s) => s.kind === 'window').length,
  });
  return mapped;
}

export function armSource(sourceId: string): void {
  armedSourceId = sourceId;
  log.debug('fonte armada para captura', { sourceId });
}

export function disarmSource(): void {
  if (armedSourceId) log.debug('fonte desarmada', { sourceId: armedSourceId });
  armedSourceId = null;
}

/**
 * Handler unico de getDisplayMedia. `useSystemPicker: false` porque a escolha
 * acontece na nossa propria UI (com thumbnail), nao no seletor do sistema.
 */
export function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      const wanted = armedSourceId;
      if (!wanted) {
        log.warn('getDisplayMedia recusado: nenhuma fonte foi escolhida na UI');
        callback({});
        return;
      }

      desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const source = sources.find((s) => s.id === wanted);
          if (!source) {
            // janela fechada entre a listagem e o inicio da transmissao
            log.error('fonte escolhida nao existe mais', { sourceId: wanted });
            callback({});
            return;
          }

          if (loopbackAudioAvailable) {
            log.info('concedendo captura com audio loopback', { sourceId: source.id });
            callback({ video: source, audio: 'loopback' });
          } else {
            log.warn('concedendo captura SEM audio (loopback indisponivel)', {
              sourceId: source.id,
            });
            callback({ video: source });
          }
        })
        .catch((err: unknown) => {
          log.error('falha ao resolver a fonte de captura', { message: errorMessage(err) });
          callback({});
        });
    },
    { useSystemPicker: false },
  );

  log.info('display media handler registrado', {
    plataforma: process.platform,
    audioLoopback: loopbackAudioAvailable,
  });
}

/** Chamado pelo renderer quando o loopback nao produziu faixa de audio. */
export function markLoopbackUnavailable(): void {
  if (loopbackAudioAvailable) {
    loopbackAudioAvailable = false;
    log.warn('audio loopback marcado como indisponivel; proximas capturas serao so video');
  }
}
