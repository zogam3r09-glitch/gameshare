import { createLogger } from '@game-share/shared';

const log = createLogger('rooms');

export interface RoomRecord {
  roomId: string;
  createdAt: number;
  /** null enquanto a transmissao nao foi encerrada pelo streamer */
  endedAt: number | null;
}

export interface RegistryOptions {
  /** por quanto tempo uma sala encerrada ainda e lembrada */
  rememberEndedMs?: number;
  /** por quanto tempo uma sala sem encerramento explicito e lembrada */
  maxAgeMs?: number;
  now?: () => number;
}

/**
 * Registro em memoria das salas criadas.
 *
 * Existe para um caso concreto: o amigo que abre o link depois que a
 * transmissao acabou. Sem isto ele fica em "Aguardando transmissao..." para
 * sempre, sem nunca saber que nao ha nada para esperar.
 *
 * Deliberadamente NAO tratamos "sala desconhecida" como inexistente. O
 * processo pode ter reiniciado — no plano gratuito do Render ele dorme depois
 * de 15 min sem trafego — e ai o registro volta vazio enquanto a transmissao
 * segue no ar. Responder "esse link nao existe" nesse caso seria uma
 * regressao pior do que a ambiguidade que estamos resolvendo. Sala
 * desconhecida continua recebendo token, como antes.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly rememberEndedMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: RegistryOptions = {}) {
    this.rememberEndedMs = options.rememberEndedMs ?? 30 * 60 * 1000;
    this.maxAgeMs = options.maxAgeMs ?? 12 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  create(roomId: string): RoomRecord {
    this.prune();
    const record: RoomRecord = { roomId, createdAt: this.now(), endedAt: null };
    this.rooms.set(roomId, record);
    return record;
  }

  /** null = desconhecida (nunca criada AQUI, ou ja esquecida). */
  get(roomId: string): RoomRecord | null {
    this.prune();
    return this.rooms.get(roomId) ?? null;
  }

  markEnded(roomId: string): void {
    const record = this.rooms.get(roomId);
    if (!record || record.endedAt !== null) return;
    record.endedAt = this.now();
    log.info('sala marcada como encerrada', { roomId });
  }

  size(): number {
    this.prune();
    return this.rooms.size;
  }

  /** Sem timer: limpamos ao consultar, que basta para este volume. */
  private prune(): void {
    const now = this.now();
    for (const [roomId, record] of this.rooms) {
      const age = now - record.createdAt;
      const endedFor = record.endedAt === null ? 0 : now - record.endedAt;
      if (age > this.maxAgeMs || (record.endedAt !== null && endedFor > this.rememberEndedMs)) {
        this.rooms.delete(roomId);
      }
    }
  }
}
