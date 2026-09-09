import { createLogger } from '@game-share/shared';

const log = createLogger('clipe');

/** Tamanho de cada pedaco entregue pelo MediaRecorder. */
const INTERVALO_MS = 1000;

/**
 * Reducao aplicada ao clone que o clipe grava. Funciona: um clipe gravado
 * sobre captura 1080p60 decodifica em 1280x720, e o arquivo cai de 2,4 MB para
 * 460 KB em 12 segundos.
 *
 * CUIDADO ao verificar isso: `getSettings()` logo depois de `applyConstraints`
 * ainda devolve as dimensoes ANTIGAS — a mudanca so aparece quando o proximo
 * quadro sai. Ja me fez concluir que a reducao nao tinha funcionado. A unica
 * leitura confiavel e no arquivo produzido, ou depois de alguns quadros.
 */
const CLIPE_LARGURA = 1280;
const CLIPE_ALTURA = 720;
const CLIPE_FPS = 30;

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
  /** faixa clonada e reduzida; precisa ser parada junto, senao vaza captura */
  private clone: MediaStreamTrack | null = null;
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
   * Grava uma COPIA REDUZIDA da captura, nao a captura em si.
   *
   * O buffer precisa ficar sempre ligado — clipe que exige lembrar de ligar
   * antes nao serve para nada, porque quando o momento acontece ja passou. Mas
   * gravar e um segundo encoder na mesma CPU que o jogo esta usando, e a
   * medicao de codec mostrou que nao existe aceleracao por hardware aqui.
   *
   * A saida e clonar a faixa e reduzir o clone: `clone()` aceita constraints
   * independentes da faixa transmitida, entao a transmissao segue em 1080p60 e
   * o clipe grava em 720p30 — cerca de um quinto dos pixels por segundo, num
   * arquivo que vai ser mandado no grupo de qualquer jeito.
   *
   * Medido com espectador conectado, mesma tela, com e sem o buffer: fps
   * codificado 31 -> 32 e `segLimitadoCpu` zerado nos dois. Nao houve custo
   * detectavel — mas a medicao foi sobre tela de desktop, com a CPU ociosa.
   * Sob jogo pesado a conta pode ser outra, e e por isso que da para desligar.
   */
  async iniciar(stream: MediaStream, bitsPorSegundo: number): Promise<void> {
    if (this.recorder) return;

    const tipos = ['video/webm;codecs=vp8', 'video/webm'];
    const mimeType = tipos.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) {
      log.warn('MediaRecorder sem tipo suportado; clipe indisponivel');
      return;
    }

    const original = stream.getVideoTracks()[0];
    if (!original) return;

    this.clone = original.clone();
    try {
      await this.clone.applyConstraints({
        width: { max: CLIPE_LARGURA },
        height: { max: CLIPE_ALTURA },
        frameRate: { max: CLIPE_FPS },
      });
    } catch (err) {
      // reduzir e otimizacao, nao requisito: sem isso grava na resolucao cheia
      log.warn('nao foi possivel reduzir o clone do clipe', { message: String(err) });
    }

    const paraGravar = new MediaStream([this.clone, ...stream.getAudioTracks()]);

    try {
      const recorder = new MediaRecorder(paraGravar, {
        mimeType,
        videoBitsPerSecond: bitsPorSegundo,
      });
      recorder.ondataavailable = (e) => this.receber(e.data);
      recorder.onerror = (e) => log.error('MediaRecorder falhou', { message: String(e) });
      recorder.start(INTERVALO_MS);
      this.recorder = recorder;

      // NAO logar getSettings() aqui: neste instante ele ainda devolve as
      // dimensoes de antes do applyConstraints. Sai junto do primeiro pedaco,
      // quando ja passou quadro pelo pipeline e o valor e real.
      log.info('buffer de clipe ligado', { segundos: this.segundos, mimeType, bitsPorSegundo });
    } catch (err) {
      log.error('nao foi possivel iniciar o buffer de clipe', { message: String(err) });
      this.clone.stop();
      this.clone = null;
    }
  }

  private receber(pedaco: Blob): void {
    // O MediaRecorder ainda entrega um pedaco depois do stop(). Sem esta
    // guarda ele vira o cabecalho de um buffer ja encerrado, e `montar()`
    // devolve um clipe de um segundo, de uma transmissao que acabou.
    if (!this.recorder) return;
    if (pedaco.size === 0) return;
    if (!this.cabecalho) {
      this.cabecalho = pedaco;
      const s = this.clone?.getSettings();
      log.info('clipe gravando', {
        resolucao: `${s?.width ?? '?'}x${s?.height ?? '?'}@${s?.frameRate ?? '?'}`,
      });
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
    this.clone?.stop();
    this.clone = null;
    this.cabecalho = null;
    this.cauda = [];
  }
}
