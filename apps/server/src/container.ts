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
import { RunSweeper } from "./orchestration/runtime/run-sweeper.js";
import { RunControl } from "./orchestration/runtime/run-control.js";
import { ApprovalGate } from "./orchestration/approvals/approval-gate.js";
import { ApprovalService } from "./orchestration/approvals/service.js";
import { AgentService } from "./domain/agents/service.js";
import { ConnectionService } from "./domain/connections/service.js";
import { ConversationService } from "./domain/conversations/service.js";
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
  runQueries: RunQueryService;
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
  queue?: JobQueue;
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
  const queue: JobQueue = o.queue ?? boss!;
  const fetchImpl = o.fetch ?? fetch;

  // Integraciones
  const composioClient = o.composioClient ?? sdkComposioClient;
  const composio = new ComposioToolProvider(db, secretKeys, composioClient, {
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
  const apiKeys = new ApiKeyService(db);
  const principals = new PrincipalResolver({ db, auth, apiKeys });
  const wsTickets = new WsTicketService(db);

  // Dominio
  const llmTest = llmTester(fetchImpl);
  const connections = new ConnectionService(
    db,
    secretKeys,
    {
      "llm.openai": llmTest,
      "llm.anthropic": llmTest,
      "llm.google": llmTest,
      "llm.openai_compatible": llmTest,
      composio: composioTester(composioClient, env.NODE_ENV === "production"),
      "channel.whatsapp_cloud": whatsappCloudTester(fetchImpl),
      "channel.whatsapp_baileys": whatsappBaileysTester(),
    },
    { baseUrlAllowlist: parseAllowlist(env.LLM_BASEURL_ALLOWLIST) },
  );
  const conversations = new ConversationService({ db: tenantDb, bus, queue });
  const agents = new AgentService(tenantDb, tools);
  const runQueries = new RunQueryService(tenantDb);

  // Orquestación
  const llm = o.llm ?? new ConnectionLlmResolver(db, secretKeys, parseAllowlist(env.LLM_BASEURL_ALLOWLIST));
  const runs = new RunStore(db, bus);
  const binder = new ToolBinder({ db: tenantDb, bus, log: log.child({ component: "tools" }) }); // las tools reciben el cliente con guarda
  const gate = new ApprovalGate({ db, bus, tools, binder, ttlHours: env.APPROVAL_TTL_HOURS });
  const delivery = new ReplyDelivery({ db: tenantDb, bus, queue });
  const runtime = new AgentRuntime({
    db: tenantDb,
    bus,
    llm,
    tools,
    runs,
    binder,
    gate,
    delivery,
    log: log.child({ component: "runtime" }),
    maxSteps: env.RUN_MAX_STEPS,
  });
  const approvals = new ApprovalService(db, bus, queue);

  return {
    env,
    log,
    db,
    auth,
    bus,
    queue,
    boss,
    secretKeys,
    apiKeys,
    principals,
    wsTickets,
    agents,
    connections,
    conversations,
    runQueries,
    llm,
    runtime,
    runControl: new RunControl({ db, runs }),
    sweeper: new RunSweeper({ db, queue, runs, log: log.child({ component: "sweeper" }) }),
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
