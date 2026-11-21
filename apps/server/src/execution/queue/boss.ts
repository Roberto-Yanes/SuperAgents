import { PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { JOBS, JobPayloads, type JobName, type JobPayload, type JobQueue, type SendOptions } from "./jobs.js";

export class BossQueue implements JobQueue {
  readonly boss: PgBoss;
  private started = false;
  private lastErrorAt = 0;

  constructor(
    databaseUrl: string,
    private readonly log: Logger,
  ) {
    this.boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
    this.boss.on("error", (err) => {
      this.lastErrorAt = Date.now();
      this.log.error({ err }, "pg-boss error");
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
    for (const name of Object.values(JOBS)) {
      await this.boss.createQueue(name, { retryLimit: 3, retryDelay: 5, retryBackoff: true });
    }
    this.started = true;
  }

  /** Listo si arrancó y no ha reportado errores en el último minuto (para /ready). */
  isHealthy(): boolean {
    return this.started && Date.now() - this.lastErrorAt > 60_000;
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.boss.stop({ graceful: true, timeout: 20_000 });
  }

  async send<N extends JobName>(name: N, data: JobPayload<N>, options: SendOptions = {}): Promise<string | null> {
    const parsed = JobPayloads[name].parse(data) as object;
    return this.boss.send(name, parsed, options);
  }

  /** Registra un worker con validación del payload y logs por job. */
  async work<N extends JobName>(
    name: N,
    concurrency: number | { concurrency: number; groupConcurrency?: number },
    handler: (data: JobPayload<N>, meta: { jobId: string; retryCount: number }) => Promise<void>,
  ): Promise<void> {
    const opts = typeof concurrency === "number" ? { concurrency } : concurrency;
    const work = {
      localConcurrency: opts.concurrency,
      batchSize: 1,
      // groupConcurrency (no localGroupConcurrency): coordina entre nodos vía base de datos.
      ...(opts.groupConcurrency !== undefined ? { groupConcurrency: opts.groupConcurrency } : {}),
    };
    await this.boss.work<object>(name, work, async (jobs) => {
      for (const job of jobs) {
        const data = JobPayloads[name].parse(job.data) as JobPayload<N>;
        const log = this.log.child({ job: name, jobId: job.id });
        log.debug("job start");
        try {
          await handler(data, { jobId: job.id, retryCount: job.retryCount });
          log.debug("job done");
        } catch (err) {
          if ((err as { retryable?: boolean }).retryable) log.info({ err: (err as Error).message }, "job aplazado (reintentable)");
          else log.error({ err }, "job failed");
          throw err;
        }
      }
    });
  }
}
