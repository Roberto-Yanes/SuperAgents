import { JOBS, type JobName, type JobPayload, type JobQueue } from "./jobs.js";

/**
 * Puerto de jobs y esperas (ADR 004). El dominio y el runtime piden esto, no pg-boss.
 * Hoy el único adaptador de producción es BossQueue; los tests usan MemoryJobPort.
 */
export interface EnqueueOptions {
  /** No antes de esta fecha. */
  runAt?: Date;
  /** Grupo de serialización: dos jobs del mismo grupo no corren a la vez (conversación o tarea). */
  group?: string;
}

export interface JobPort {
  enqueue<N extends JobName>(name: N, payload: JobPayload<N>, opts?: EnqueueOptions): Promise<void>;
  schedule<N extends JobName>(name: N, cron: string, payload: JobPayload<N>, opts?: { tz?: string; key?: string }): Promise<void>;
}

export type WaitSignal = "external" | "child" | "limits" | "start";

export interface TaskRef {
  workspaceId: string;
  id: string;
}

export interface WaitPort {
  /** Despertar la tarea en una fecha (WAITING_EXTERNAL con plazo). `token` identifica esa espera concreta. */
  wakeAt(task: TaskRef, at: Date, token: string): Promise<void>;
  /** Despertar la tarea ahora por una señal (llegó el dato, terminó la hija, se amplió el cupo, arranque). */
  wakeOnSignal(task: TaskRef, signal: WaitSignal): Promise<void>;
}

/**
 * Esperas de tareas sobre cualquier JobPort: un job task.wake.
 * La aprobación NO pasa por aquí: su señal es la transición que ya reencola run.process al decidir (ApprovalService).
 */
export class JobWaitPort implements WaitPort {
  constructor(private readonly jobs: JobPort) {}

  wakeAt(task: TaskRef, at: Date, token: string): Promise<void> {
    return this.jobs.enqueue(
      JOBS.taskWake,
      { workspaceId: task.workspaceId, taskId: task.id, signal: "timer", waitToken: token },
      { runAt: at, group: `task:${task.id}` },
    );
  }

  wakeOnSignal(task: TaskRef, signal: WaitSignal): Promise<void> {
    return this.jobs.enqueue(JOBS.taskWake, { workspaceId: task.workspaceId, taskId: task.id, signal }, { group: `task:${task.id}` });
  }
}

/** Adaptador en memoria: guarda lo encolado y programado. Para tests y para inspeccionar el dominio sin Postgres. */
export class MemoryJobPort implements JobPort, JobQueue {
  readonly jobs: Array<{ name: JobName; data: unknown; opts?: EnqueueOptions }> = [];
  readonly schedules: Array<{ name: JobName; cron: string; data: unknown; key?: string }> = [];

  async enqueue<N extends JobName>(name: N, payload: JobPayload<N>, opts?: EnqueueOptions): Promise<void> {
    this.jobs.push({ name, data: payload, ...(opts ? { opts } : {}) });
  }

  async schedule<N extends JobName>(name: N, cron: string, payload: JobPayload<N>, opts: { key?: string } = {}): Promise<void> {
    this.schedules.push({ name, cron, data: payload, ...(opts.key ? { key: opts.key } : {}) });
  }

  /** Compatibilidad con JobQueue (servicios anteriores al puerto). */
  async send<N extends JobName>(name: N, data: JobPayload<N>, options?: { startAfter?: number | string | Date; group?: { id: string } }): Promise<string> {
    const runAt = options?.startAfter instanceof Date ? options.startAfter : undefined;
    this.jobs.push({
      name,
      data,
      ...(runAt || options?.group ? { opts: { ...(runAt ? { runAt } : {}), ...(options?.group ? { group: options.group.id } : {}) } } : {}),
    });
    return String(this.jobs.length);
  }

  take(name: JobName) {
    const found = this.jobs.filter((j) => j.name === name);
    this.jobs.splice(0, this.jobs.length, ...this.jobs.filter((j) => j.name !== name));
    return found;
  }
}
