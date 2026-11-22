import { z } from "zod";

/** Contratos públicos de la API v1. De aquí sale el OpenAPI 3.1 y, de este, el SDK TS. */

export const Id = z.string().uuid();
export const IdParams = z.object({ id: Id });

export const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });

export const AgentOut = z.object({
  id: Id,
  name: z.string(),
  instructions: z.string(),
  model: z.string(),
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]),
  version: z.number().int(),
  tools: z.array(z.string()),
  approvals: z.record(z.string(), z.enum(["NEVER", "ASK_OWNER", "ALWAYS"])),
  external: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ChatCreate = z.object({ agentId: Id, title: z.string().max(200).optional() });
export const ChatOut = z.object({ id: Id, agentId: Id, channel: z.string(), status: z.enum(["OPEN", "HANDOFF", "CLOSED"]), createdAt: z.string() });

export const MessageCreate = z.object({ text: z.string().min(1).max(10_000) });
export const MessageAccepted = z.object({
  status: z.enum(["run_queued", "duplicate", "human_handling", "queued_behind_approval", "coalesced"]),
  messageId: Id.nullable(),
  runId: Id.nullable(),
});
export const MessageOut = z.object({
  id: Id,
  direction: z.enum(["INBOUND", "OUTBOUND"]),
  author: z.enum(["CONTACT", "AGENT", "HUMAN", "SYSTEM"]),
  text: z.string().nullable(),
  status: z.string(),
  runId: Id.nullable(),
  createdAt: z.string(),
});

export const RunOut = z.object({
  id: Id,
  agentId: Id,
  conversationId: Id.nullable(),
  trigger: z.string(),
  status: z.enum(["QUEUED", "RUNNING", "WAITING_APPROVAL", "SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"]),
  output: z.string().nullable(),
  error: z.string().nullable(),
  stepCount: z.number().int(),
  usage: z.unknown(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  steps: z.array(z.object({ index: z.number().int(), kind: z.string(), toolName: z.string().nullable(), data: z.unknown(), createdAt: z.string() })).optional(),
});

export const ApprovalOut = z.object({
  id: Id,
  runId: Id,
  toolName: z.string(),
  preview: z.string(),
  args: z.unknown(),
  mode: z.enum(["NEVER", "ASK_OWNER", "ALWAYS"]),
  status: z.enum(["PENDING", "APPROVED", "EXECUTING", "REJECTED", "EXPIRED", "EXECUTED", "FAILED", "UNKNOWN"]),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export const ApprovalDecision = z.object({ reason: z.string().max(500).optional() });

export const ApiKeyCreate = z.object({ name: z.string().min(1).max(80), scopes: z.array(z.string()).min(1), expiresAt: z.string().datetime().optional() });
export const ApiKeyOut = z.object({
  id: Id,
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export const ApiKeyCreated = ApiKeyOut.extend({ token: z.string().describe("Solo se muestra una vez") });

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ───────────── Tareas (ADR 003) ─────────────

export const TaskStatusEnum = z.enum([
  "PLANNING",
  "RUNNING",
  "WAITING_APPROVAL",
  "WAITING_EXTERNAL",
  "WAITING_CHILD",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
]);
export const TaskSourceEnum = z.enum(["APP", "CHANNEL", "ROUTINE", "DELEGATION"]);

export const TaskLimitsIn = z
  .object({
    maxSteps: z.number().int().min(1).max(200).optional(),
    maxCostUsd: z.number().positive().max(25).optional(),
    maxDurationMs: z
      .number()
      .int()
      .min(10_000)
      .max(7 * 24 * 3_600_000)
      .optional(),
    pauseClockOnWait: z.boolean().optional(),
  })
  .strict();

export const TaskCreateIn = z.object({
  agentId: Id,
  goal: z.string().min(1).max(4_000),
  /** Datos de partida, p. ej. { leadId }. No son instrucciones. */
  context: z.record(z.string(), z.unknown()).optional(),
  limits: TaskLimitsIn.optional(),
});

export const TaskOut = z.object({
  id: Id,
  agentId: Id,
  goal: z.string(),
  source: TaskSourceEnum,
  launchedBy: z.string(),
  status: TaskStatusEnum,
  conversationId: Id.nullable(),
  contactId: Id.nullable(),
  parentTaskId: Id.nullable(),
  depth: z.number().int(),
  plan: z.unknown(),
  planVersion: z.number().int(),
  context: z.unknown(),
  limits: z.object({ maxSteps: z.number(), maxCostUsd: z.number(), maxDurationMs: z.number(), pauseClockOnWait: z.boolean() }),
  spent: z.object({ steps: z.number().int(), costUsd: z.number(), timeMs: z.number() }),
  blockedReason: z.string().nullable(),
  waiting: z.unknown().nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  runs: z
    .array(
      z.object({
        id: Id,
        status: z.string(),
        trigger: z.string(),
        stepCount: z.number().int(),
        costUsd: z.number(),
        createdAt: z.string(),
        finishedAt: z.string().nullable(),
        error: z.string().nullable(),
      }),
    )
    .optional(),
  children: z.array(z.object({ id: Id, status: TaskStatusEnum, goal: z.string() })).optional(),
});
