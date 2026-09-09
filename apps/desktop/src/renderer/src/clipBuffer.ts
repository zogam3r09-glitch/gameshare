import { createLogger } from '@game-share/shared';

const log = createLogger('clipe');

/** Tamanho de cada pedaco entregue pelo MediaRecorder. */
const INTERVALO_MS = 1000;

/**
 * Buffer rotativo dos ultimos segundos da captura, para "clipar o que acabou
 * de acontecer".
 *
 * A ARMADILHA, e por que existe `cabecalho`:
 *
 * O MediaRecorder produz um fluxo WebM em que o PRIMEIRO pedaco carrega o
 * cabecalho EBML — a declaracao de faixas, codecs e dimensoes. Os pedacos
 * seguintes sao so clusters de midia. Guardar apenas os ultimos N segundos e
 * jogar fora os antigos produz um arquivo sem cabecalho, que nenhum player
 * abre. Por isso o primeiro pedaco fica retido para sempre e e sempre o
 * primeiro do arquivo montado.
 *
 * LIMITE CONHECIDO: a duracao gravada no cabecalho e a da gravacao inteira,
 * nao a do trecho salvo, entao alguns players mostram duracao errada ou
 * demoram a permitir avancar. O video em si toca. Corrigir de verdade exigiria
 * reescrever os metadados Matroska, o que nao se justifica aqui.
 */
export class ClipBuffer {
  private recorder: MediaRecorder | null = null;
  private cabecalho: Blob | null = null;
  private cauda: Blob[] = [];
  private readonly maxPedacos: number;

  constructor(private readonly segundos = 30) {
    this.maxPedacos = Math.ceil((segundos * 1000) / INTERVALO_MS);
  }

  get ativo(): boolean {
    return this.recorder !== null;
  }

  /** Segundos realmente disponiveis agora; cresce ate `segundos`. */
  get disponivel(): number {
    if (!this.cabecalho) return 0;
    return Math.min(this.segundos, (this.cauda.length + 1) * (INTERVALO_MS / 1000));
  }

  /**
   * `bitsPorSegundo` limita o custo: gravar re-codifica o video, ou seja um
   * segundo encoder rodando junto com o da transmissao, disputando a mesma CPU
   * que o jogo. Clipe nao precisa da qualidade da transmissao.
   */
  iniciar(stream: MediaStream, bitsPorSegundo: number): void {
    if (this.recorder) return;

    const tipos = ['video/webm;codecs=vp8', 'video/webm'];
    const mimeType = tipos.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) {
      log.warn('MediaRecorder sem tipo suportado; clipe indisponivel');
      return;
    }

    try {
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitsPorSegundo });
      recorder.ondataavailable = (e) => this.receber(e.data);
      recorder.onerror = (e) => log.error('MediaRecorder falhou', { message: String(e) });
      recorder.start(INTERVALO_MS);
      this.recorder = recorder;
      log.info('buffer de clipe ligado', { segundos: this.segundos, mimeType, bitsPorSegundo });
    } catch (err) {
      log.error('nao foi possivel iniciar o buffer de clipe', { message: String(err) });
    }
  }

  private receber(pedaco: Blob): void {
    if (pedaco.size === 0) return;
    if (!this.cabecalho) {
      this.cabecalho = pedaco;
      return;
    }
    this.cauda.push(pedaco);
    while (this.cauda.length > this.maxPedacos) this.cauda.shift();
  }

  /** Monta o arquivo: cabecalho retido + os ultimos segundos. */
  montar(): Blob | null {
    if (!this.cabecalho || this.cauda.length === 0) return null;
    return new Blob([this.cabecalho, ...this.cauda], { type: this.cabecalho.type });
  }

  parar(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
    this.cabecalho = null;
    this.cauda = [];
  }
}
