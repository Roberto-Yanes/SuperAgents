import path from "node:path";
import type { Logger } from "pino";
import type { Env } from "./shared/config/env.js";
import { createLogger } from "./shared/observability/logger.js";
import { withTenantGuard } from "./data/tenant-guard.js";
import { parseAllowlist } from "./shared/security/url-policy.js";
import { createDb, type Db } from "./data/db.js";
import { createAuth, type Auth } from "./access/auth/better-auth.js";
import { ApiKeyService } from "./access/auth/api-keys.js";
import { PrincipalResolver } from "./access/auth/principal-resolver.js";
import { WsTicketService } from "./access/realtime/tickets.js";
import { EventBus } from "./execution/events/bus.js";
import { JobWaitPort, type JobPort, type WaitPort } from "./execution/queue/ports.js";
import { BossQueue } from "./execution/queue/boss.js";
import type { JobQueue } from "./execution/queue/jobs.js";
import { ToolRegistry } from "./integrations/tools/registry.js";
import { builtinTools } from "./integrations/tools/builtin/index.js";
import { ChannelRegistry, apiChannel } from "./integrations/channels/adapter.js";
import { whatsappCloudAdapter, whatsappCloudTester } from "./integrations/channels/whatsapp-cloud.js";
import { BaileysSessionManager, whatsappBaileysAdapter, whatsappBaileysTester, type BaileysSocketFactory } from "./integrations/channels/whatsapp-baileys.js";
import { ComposioToolProvider, composioTester, sdkComposioClient, type ComposioClientFactory } from "./integrations/composio/gateway.js";
import { ConnectionLlmResolver, type LlmResolver } from "./orchestration/llm/registry.js";
import { llmTester } from "./orchestration/llm/tester.js";
import { AgentRuntime } from "./orchestration/runtime/agent-runtime.js";
import { RunStore } from "./orchestration/runtime/run-store.js";
import { ToolBinder } from "./orchestration/runtime/tool-binder.js";
import { ReplyDelivery } from "./orchestration/runtime/reply-delivery.js";
import { TaskStore } from "./orchestration/runtime/task-store.js";
import { TaskAudit } from "./orchestration/runtime/task-audit.js";
import { TaskService } from "./domain/tasks/service.js";
import { WorkspacePolicyService } from "./domain/workspaces/service.js";
import { RunSweeper } from "./orchestration/runtime/run-sweeper.js";
import { RunControl } from "./orchestration/runtime/run-control.js";
import { ApprovalGate } from "./orchestration/approvals/approval-gate.js";
import { ApprovalService } from "./orchestration/approvals/service.js";
import { AgentService } from "./domain/agents/service.js";
import { ConnectionService } from "./domain/connections/service.js";
import { ConversationService } from "./domain/conversations/service.js";
import { ContactService } from "./domain/contacts/service.js";
import { AgendaService } from "./domain/agenda/service.js";
import { LeadService } from "./domain/leads/service.js";
import { RoutineService } from "./domain/routines/service.js";
import { SequenceService } from "./domain/sequences/service.js";
import { TickRoutineScheduler } from "./execution/queue/routine-scheduler.js";
import { agendaTools } from "./integrations/tools/builtin/agenda.js";
import { leadTools } from "./integrations/tools/builtin/leads.js";
import { RunQueryService } from "./domain/runs/service.js";

/**
 * Raíz de composición: el ÚNICO sitio que construye dependencias concretas (inversión de dependencias).
 * Cada ruta y cada worker recibe solo la parte del contexto que usa (segregación de interfaces):
 * ver los tipos *Deps en access/http/routes/* y execution/workers/*.
 */
export interface AppContext {
  env: Env;
  log: Logger;
  db: Db;
  auth: Auth;
  bus: EventBus;
  queue: JobQueue;
  /** Puerto de jobs y esperas (ADR 004): lo que piden las Tasks. Adaptador: pg-boss (o memoria en tests). */
  jobs: JobPort;
  waits: WaitPort;
  boss: BossQueue | null;
  secretKeys: Buffer[];
  // acceso
  apiKeys: ApiKeyService;
  principals: PrincipalResolver;
  wsTickets: WsTicketService;
  // dominio
  agents: AgentService;
  connections: ConnectionService;
  conversations: ConversationService;
  contacts: ContactService;
  agenda: AgendaService;
  leads: LeadService;
  routines: RoutineService;
  sequences: SequenceService;
  runQueries: RunQueryService;
  tasks: TaskService;
  workspacePolicies: WorkspacePolicyService;
  // orquestación
  llm: LlmResolver;
  runtime: AgentRuntime;
  sweeper: RunSweeper;
  runControl: RunControl;
  approvals: ApprovalService;
  // integraciones
  tools: ToolRegistry;
  channels: ChannelRegistry;
  baileys: BaileysSessionManager;
  composio: ComposioToolProvider;
}

export interface ContextOverrides {
  log?: Logger;
  llm?: LlmResolver;
  tools?: ToolRegistry;
  queue?: JobQueue & JobPort;
  fetch?: typeof fetch;
  composioClient?: ComposioClientFactory;
  baileysFactory?: BaileysSocketFactory;
}

export function createContext(env: Env, o: ContextOverrides = {}): AppContext {
  const log = o.log ?? createLogger(env.LOG_LEVEL);
  const db = createDb(env.DATABASE_URL);
  /** Cliente para servicios que atienden a UN workspace: exige workspaceId en consultas masivas (M7). */
  const tenantDb = withTenantGuard(db, env.TENANT_GUARD ?? (env.NODE_ENV === "production" ? "warn" : "error"), log.child({ component: "tenant-guard" }));
  const secretKeys = [env.SECRET_KEY, env.SECRET_KEY_OLD].filter((k): k is string => Boolean(k)).map((k) => Buffer.from(k, "base64"));
  const bus = new EventBus(db, env.DATABASE_URL, log.child({ component: "bus" }));
  const boss = o.queue ? null : new BossQueue(env.DATABASE_URL, log.child({ component: "queue" }));
  const queue: JobQueue & JobPort = o.queue ?? boss!;
  const waits = new JobWaitPort(queue);
  const fetchImpl = o.fetch ?? fetch;

  // Integraciones
  const composioClient = o.composioClient ?? sdkComposioClient;
  const composioKey = env.COMPOSIO_API_KEY ?? null;
  if (!composioKey) log.warn("Composio deshabilitado: falta COMPOSIO_API_KEY");
  const composio = new ComposioToolProvider(db, composioKey, composioClient, {
    log: log.child({ component: "composio" }),
    requireVersions: env.NODE_ENV === "production",
  });
  const tools = o.tools ?? new ToolRegistry();
  if (!o.tools) for (const t of builtinTools) tools.register(t);
  tools.addProvider(composio);
  const baileys = new BaileysSessionManager({
    db,
    bus,
    queue,
    keys: secretKeys,
    log: log.child({ component: "baileys" }),
    dataDir: path.resolve(env.DATA_DIR, "baileys"),
    ...(o.baileysFactory ? { factory: o.baileysFactory } : {}),
  });
  const channels = new ChannelRegistry().register(apiChannel).register(whatsappCloudAdapter(fetchImpl)).register(whatsappBaileysAdapter(baileys));

  // Acceso
  const auth = createAuth(db, {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.PUBLIC_URL,
    trustedOrigins: env.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowSignUp: env.AUTH_SIGNUP === "enabled",
  });
  const apiKeys = new ApiKeyService(tenantDb);
  const principals = new PrincipalResolver({ db, auth, apiKeys });
  const wsTickets = new WsTicketService(db);

  // Dominio
  const llmTest = llmTester(fetchImpl);
  const connections = new ConnectionService(
    tenantDb,
    secretKeys,
    {
      "llm.azure_openai": llmTest,
      "llm.mistral": llmTest,
      "llm.openai": llmTest,
      "llm.anthropic": llmTest,
      "llm.google": llmTest,
      "llm.openai_compatible": llmTest,
      composio: composioTester(composioKey, composioClient, env.NODE_ENV === "production"),
      "channel.whatsapp_cloud": whatsappCloudTester(fetchImpl),
      "channel.whatsapp_baileys": whatsappBaileysTester(),
    },
    { baseUrlAllowlist: parseAllowlist(env.LLM_BASEURL_ALLOWLIST) },
  );
  const conversations = new ConversationService({ db: tenantDb, bus, queue });
  const contacts = new ContactService(tenantDb);
  const agenda = new AgendaService({ db: tenantDb, bus, queue });
  const leads = new LeadService({ db: tenantDb, bus, queue });
  const routines = new RoutineService({ db: tenantDb, system: db, queue, scheduler: new TickRoutineScheduler() });
  const sequences = new SequenceService({ db: tenantDb, queue, conversations });
  const agents = new AgentService(tenantDb, tools);
  const runQueries = new RunQueryService(tenantDb);
  if (!o.tools) {
    for (const t of agendaTools(agenda)) tools.register(t);
    for (const t of leadTools(leads)) tools.register(t);
  }

  // Orquestación
  const llm = o.llm ?? new ConnectionLlmResolver(db, secretKeys, parseAllowlist(env.LLM_BASEURL_ALLOWLIST));
  const runs = new RunStore(tenantDb, bus);
  const binder = new ToolBinder({ db: tenantDb, bus, log: log.child({ component: "tools" }) }); // las tools reciben el cliente con guarda
  const gate = new ApprovalGate({ db, bus, tools, binder, ttlHours: env.APPROVAL_TTL_HOURS });
  const delivery = new ReplyDelivery({ db: tenantDb, bus, queue });
  const taskStore = new TaskStore({ db: tenantDb, bus, queue, waits });
  const taskAudit = new TaskAudit({ db: tenantDb, tools });
  const tasks = new TaskService({ db: tenantDb, bus, queue, waits });
  const workspacePolicies = new WorkspacePolicyService(tenantDb);
  const runtime = new AgentRuntime({
    db: tenantDb,
    bus,
    llm,
    tools,
    runs,
    binder,
    gate,
    delivery,
    conversations,
    tasks: taskStore,
    audit: taskAudit,
    waits,
    log: log.child({ component: "runtime" }),
    maxSteps: env.RUN_MAX_STEPS,
  });
  const approvals = new ApprovalService(tenantDb, bus, queue, db);

  return {
    env,
    log,
    db,
    auth,
    bus,
    queue,
    jobs: queue,
    waits,
    boss,
    secretKeys,
    apiKeys,
    principals,
    wsTickets,
    agents,
    connections,
    conversations,
    contacts,
    agenda,
    leads,
    routines,
    sequences,
    runQueries,
    llm,
    runtime,
    tasks,
    workspacePolicies,
    runControl: new RunControl({ db: tenantDb, runs, conversations, tasks }),
    // El barrido cruza workspaces a propósito: cliente de sistema. Al dar un run por perdido, suelta la cola (D1).
    sweeper: new RunSweeper({ db, queue, runs, conversations, tasks: taskStore, log: log.child({ component: "sweeper" }) }),
    approvals,
    tools,
    channels,
    baileys,
    composio,
  };
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await ctx.baileys.stopAll().catch(() => undefined);
  await ctx.bus.stop();
  await ctx.boss?.stop().catch(() => undefined);
  await ctx.db.$disconnect();
}
