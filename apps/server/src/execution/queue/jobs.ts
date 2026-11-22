import { z } from "zod";

/** Nombres de cola del diagrama v3 (más message.outbound para el outbox y approvals.expire). */
export const JOBS = {
  channelInbound: "channel.inbound",
  /** Ejecución y reanudación de runs, serializadas por conversación (grupo pg-boss, H1). */
  runProcess: "run.process",
  /** @deprecated Solo se drenan los jobs ya encolados antes de run.process. No encolar. */
  runExecute: "run.execute",
  /** @deprecated Ídem. */
  runResume: "run.resume",
  /** Barrido de runs huérfanos (worker caído a mitad de un run, M12). Programado cada minuto. */
  runSweep: "run.sweep",
  messageOutbound: "message.outbound",
  sequenceStep: "sequence.step",
  routineCron: "routine.cron",
  crmSync: "crm.sync",
  integrationEvent: "integration.event",
  appointmentReminder: "appointment.reminder",
  approvalsExpire: "approvals.expire",
  /** Arranque, parada o desvinculación de sesiones de canal con estado (Baileys). */
  channelSession: "channel.session",
  /** Sondeo de canales sin push (IMAP). Programado cada minuto. */
  channelPoll: "channel.poll",
  /** Troceado + embeddings de un documento de la base de conocimiento. */
  knowledgeIngest: "knowledge.ingest",
  /** Despertar una Task en espera (plazo, dato externo, tarea hija o cupo ampliado): abre un tramo nuevo (ADR 003). */
  taskWake: "task.wake",
  /** Purga diaria de contenido y auditoría vencidos según la retención de cada workspace (ADR 005). */
  retentionSweep: "retention.sweep",
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

export const JobPayloads = {
  [JOBS.channelInbound]: z.object({
    workspaceId: z.string().uuid(),
    connectionId: z.string().uuid(),
    channel: z.string(),
    externalThreadId: z.string(),
    channelMessageId: z.string(),
    from: z.object({ id: z.string(), phone: z.string().optional(), name: z.string().optional() }),
    text: z.string(),
    receivedAt: z.string(),
  }),
  [JOBS.runProcess]: z.object({
    workspaceId: z.string().uuid(),
    runId: z.string().uuid(),
    kind: z.enum(["execute", "resume"]),
    /** Reencolado por el barrido: el run puede estar en RUNNING de un worker que murió. */
    recover: z.boolean().optional(),
  }),
  [JOBS.runSweep]: z.object({}).passthrough(),
  [JOBS.runExecute]: z.object({ workspaceId: z.string().uuid(), runId: z.string().uuid() }),
  [JOBS.runResume]: z.object({ workspaceId: z.string().uuid(), runId: z.string().uuid() }),
  [JOBS.messageOutbound]: z.object({ workspaceId: z.string().uuid(), messageId: z.string().uuid() }),
  [JOBS.sequenceStep]: z.object({ workspaceId: z.string().uuid(), enrollmentId: z.string().uuid(), step: z.number().int().min(0) }),
  /** Vacío = pase de todas las rutinas vencidas. Con ids, dispara una (el cron por fila también puede usarlo). */
  [JOBS.routineCron]: z.object({ workspaceId: z.string().uuid().optional(), routineId: z.string().uuid().optional() }),
  [JOBS.crmSync]: z.object({ workspaceId: z.string().uuid(), leadId: z.string().uuid() }),
  [JOBS.integrationEvent]: z.object({
    workspaceId: z.string().uuid(),
    connectionId: z.string().uuid(),
    source: z.string(),
    trigger: z.string(),
    eventId: z.string(),
    payload: z.unknown(),
  }),
  [JOBS.appointmentReminder]: z.object({ workspaceId: z.string().uuid(), appointmentId: z.string().uuid() }),
  [JOBS.approvalsExpire]: z.object({}).passthrough(),
  [JOBS.channelPoll]: z.object({}).passthrough(),
  [JOBS.knowledgeIngest]: z.object({ workspaceId: z.string().uuid(), documentId: z.string().uuid() }),
  [JOBS.retentionSweep]: z.object({}).passthrough(),
  [JOBS.taskWake]: z.object({
    workspaceId: z.string().uuid(),
    taskId: z.string().uuid(),
    signal: z.enum(["timer", "external", "child", "limits", "start"]),
    /** Solo el despertar programado para este plazo vale (un wakeAt viejo no despierta una espera nueva). */
    waitToken: z.string().optional(),
  }),
  [JOBS.channelSession]: z.object({ workspaceId: z.string().uuid(), connectionId: z.string().uuid(), action: z.enum(["start", "stop", "logout"]) }),
} satisfies Record<JobName, z.ZodType>;

export type JobPayload<N extends JobName> = z.infer<(typeof JobPayloads)[N]>;

/**
 * Opciones de envío. No hay singletonKey a propósito: en colas "standard" de pg-boss NO deduplica (M1).
 * La idempotencia vive en los consumidores (transiciones condicionadas en base de datos, claves únicas).
 */
export interface SendOptions {
  startAfter?: number | string | Date;
  retryLimit?: number;
  /** Grupo pg-boss: con groupConcurrency 1 en el worker, los jobs de un mismo grupo nunca corren a la vez. */
  group?: { id: string };
}

/**
 * Encola la ejecución o reanudación de un run. Grupo = conversación (o el propio run si no tiene),
 * así dos runs de la misma conversación no se ejecutan en paralelo (H1).
 */
export function enqueueRun(
  queue: JobQueue,
  run: { workspaceId: string; id: string; conversationId: string | null },
  kind: "execute" | "resume",
  opts: { recover?: boolean; startAfter?: number } = {},
): Promise<string | null> {
  return queue.send(
    JOBS.runProcess,
    { workspaceId: run.workspaceId, runId: run.id, kind, ...(opts.recover ? { recover: true } : {}) },
    { group: { id: run.conversationId ?? run.id }, ...(opts.startAfter !== undefined ? { startAfter: opts.startAfter } : {}) },
  );
}

/** Lo único que la API necesita de la cola. */
export interface JobQueue {
  send<N extends JobName>(name: N, data: JobPayload<N>, options?: SendOptions): Promise<string | null>;
}
