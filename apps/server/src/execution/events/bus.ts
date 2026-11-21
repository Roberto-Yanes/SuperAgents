import pg from "pg";
import type { Logger } from "pino";
import type { Db } from "../../data/db.js";
import type { Prisma } from "../../data/generated/prisma/client.js";

export interface BusEvent {
  seq: string;
  workspaceId: string;
  type: string;
  subject: string;
  data: unknown;
  createdAt: string;
}

export interface PublishInput {
  workspaceId: string;
  type: string;
  subject: string;
  data?: Prisma.InputJsonValue;
}

/** Cliente de transacción interactiva de Prisma (lo mínimo que necesita publish). */
type Tx = Pick<Db, "event" | "$executeRaw">;
type Listener = (event: BusEvent) => void;

const MAX_BACKOFF_MS = 30_000;

/**
 * Bus de eventos: tabla Event (seq global) + trigger NOTIFY 'ega_events' + LISTEN en una conexión dedicada.
 *
 * Garantías:
 * - Orden por subject: cada publish toma un advisory lock transaccional por subject, así el orden de commit
 *   coincide con el orden de seq dentro de un subject (D-015, M11).
 * - Las notificaciones se procesan en cadena (una tras otra).
 * - Reconexión: si se corta la conexión LISTEN, reconecta con backoff, vuelve a hacer LISTEN y reproduce
 *   desde el último seq entregado de cada subject con suscriptores (H6).
 */
export class EventBus {
  private client: pg.Client | undefined;
  private listening = false;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Último seq entregado por clave workspaceId|subject (para reproducir tras reconectar). */
  private readonly lastSeq = new Map<string, bigint>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly databaseUrl: string,
    private readonly log: Logger,
  ) {}

  async publish(input: PublishInput, tx?: Tx): Promise<BusEvent> {
    const write = async (t: Tx) => {
      await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}|${input.subject}`}, 0))`;
      return t.event.create({ data: { workspaceId: input.workspaceId, type: input.type, subject: input.subject, data: input.data ?? {} } });
    };
    const row = tx ? await write(tx) : await this.db.$transaction((t) => write(t));
    return toBusEvent(row);
  }

  /** Eventos de un subject posteriores a afterSeq (reconexión de clientes con Last-Event-ID / after). */
  async backlog(workspaceId: string, subject: string, afterSeq: bigint, limit = 500): Promise<BusEvent[]> {
    const rows = await this.db.event.findMany({ where: { workspaceId, subject, seq: { gt: afterSeq } }, orderBy: { seq: "asc" }, take: limit });
    return rows.map(toBusEvent);
  }

  /**
   * Seguir un subject desde `afterSeq`: entrega el backlog y luego lo que llegue en vivo, sin huecos ni duplicados.
   * Se suscribe ANTES de leer el backlog y descarta lo ya entregado por seq.
   */
  async follow(workspaceId: string, subject: string, afterSeq: bigint, deliver: (e: BusEvent) => void): Promise<() => void> {
    let cursor = afterSeq;
    let live = false;
    const queued: BusEvent[] = [];
    const emit = (e: BusEvent) => {
      if (BigInt(e.seq) <= cursor) return;
      cursor = BigInt(e.seq);
      deliver(e);
    };
    const off = this.subscribe(workspaceId, subject, (e) => (live ? emit(e) : queued.push(e)));
    try {
      for (const e of await this.backlog(workspaceId, subject, cursor)) emit(e);
    } catch (err) {
      off();
      throw err;
    }
    live = true;
    for (const e of queued) emit(e);
    return off;
  }

  subscribe(workspaceId: string, subject: string, listener: Listener): () => void {
    const key = `${workspaceId}|${subject}`;
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(key);
        this.lastSeq.delete(key);
      }
    };
  }

  isHealthy(): boolean {
    return this.listening;
  }

  isStarted(): boolean {
    return !this.stopped;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.listening = false;
    const c = this.client;
    this.client = undefined;
    await c?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.databaseUrl });
    client.on("notification", (msg) => {
      this.chain = this.chain.then(() => this.onNotify(msg.payload));
    });
    const lost = (reason: string, err?: unknown) => {
      if (this.client !== client) return; // ya reemplazado
      this.listening = false;
      this.client = undefined;
      client.removeAllListeners("notification");
      void client.end().catch(() => undefined);
      if (!this.stopped) {
        this.log.warn({ err, reason }, "conexión LISTEN perdida; reconectando");
        this.scheduleReconnect();
      }
    };
    client.on("error", (err) => lost("error", err));
    client.on("end", () => lost("end"));
    this.client = client;
    try {
      await client.connect();
      await client.query("LISTEN ega_events");
      this.listening = true;
      const reconnected = this.attempt > 0;
      this.attempt = 0;
      if (reconnected) {
        this.log.info("conexión LISTEN restablecida");
        this.chain = this.chain.then(() => this.replayAfterReconnect());
      }
    } catch (err) {
      lost("connect_failed", err);
      if (this.attempt === 0 && !this.stopped) throw err; // el primer arranque debe fallar visiblemente
    }
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => this.log.error({ err }, "reconexión del bus fallida"));
    }, delay);
    this.reconnectTimer.unref();
  }

  /** Entrega lo publicado mientras la conexión estuvo caída, por subject y en orden. */
  private async replayAfterReconnect(): Promise<void> {
    for (const key of [...this.listeners.keys()]) {
      const [workspaceId, subject] = splitKey(key);
      const after = this.lastSeq.get(key) ?? (await this.maxSeqBefore(workspaceId, subject));
      try {
        for (const e of await this.backlog(workspaceId, subject, after)) this.dispatch(key, e);
      } catch (err) {
        this.log.error({ err, subject }, "no se pudo reproducir el backlog tras reconectar");
      }
    }
  }

  /** Sin seq conocido para una clave (nada entregado aún): reproducir solo lo del último minuto. */
  private async maxSeqBefore(workspaceId: string, subject: string): Promise<bigint> {
    const row = await this.db.event.findFirst({
      where: { workspaceId, subject, createdAt: { lt: new Date(Date.now() - 60_000) } },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    return row?.seq ?? 0n;
  }

  private async onNotify(payload: string | undefined): Promise<void> {
    if (!payload) return;
    try {
      const meta = JSON.parse(payload) as { seq: string; workspaceId: string; subject: string };
      const key = `${meta.workspaceId}|${meta.subject}`;
      if (!this.listeners.get(key)?.size) return;
      const row = await this.db.event.findUnique({ where: { seq: BigInt(meta.seq) } });
      if (row) this.dispatch(key, toBusEvent(row));
    } catch (err) {
      this.log.warn({ err }, "evento ignorado");
    }
  }

  private dispatch(key: string, event: BusEvent): void {
    const seq = BigInt(event.seq);
    if (seq <= (this.lastSeq.get(key) ?? -1n)) return;
    this.lastSeq.set(key, seq);
    for (const l of this.listeners.get(key) ?? []) {
      try {
        l(event);
      } catch (err) {
        this.log.error({ err }, "listener del bus falló");
      }
    }
  }
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf("|");
  return [key.slice(0, i), key.slice(i + 1)];
}

function toBusEvent(row: { seq: bigint; workspaceId: string; type: string; subject: string; data: unknown; createdAt: Date }): BusEvent {
  return {
    seq: row.seq.toString(),
    workspaceId: row.workspaceId,
    type: row.type,
    subject: row.subject,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
  };
}
