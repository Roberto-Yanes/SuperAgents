# Everglow Agentes — diagrama de arquitectura v4 con estado de implementación (PIL)
# Uso: python3 arquitectura-v4.py  -> arquitectura-v4-estado.png
from PIL import Image, ImageDraw, ImageFont
import math
W, H = 2400, 2600
OUT = "arquitectura-v4-estado.png"
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FM = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
fb = lambda s: ImageFont.truetype(FB, s)
fm = lambda s: ImageFont.truetype(FM, s)
INK, MUTED, LINE = (15, 23, 42), (71, 85, 105), (148, 163, 184)
ST = {
    "done":    dict(fill=(220, 252, 231), bd=(22, 163, 74),  sym="✓", lab="Hecho"),
    "partial": dict(fill=(254, 243, 199), bd=(217, 119, 6),  sym="◐", lab="Parcial"),
    "todo":    dict(fill=(254, 226, 226), bd=(220, 38, 38),  sym="✕", lab="Pendiente"),
    "future":  dict(fill=(241, 245, 249), bd=(100, 116, 139), sym="…", lab="Futuro / condicional"),
    "info":    dict(fill=(255, 255, 255), bd=(148, 163, 184), sym="", lab=""),
}
img = Image.new("RGB", (W, H), (246, 248, 251))
d = ImageDraw.Draw(img)

def wrap(text, font, maxw):
    out = []
    for para in text.split("\n"):
        line = ""
        for w in para.split(" "):
            t = (line + " " + w).strip()
            if d.textlength(t, font=font) <= maxw: line = t
            else:
                if line: out.append(line)
                line = w
        out.append(line)
    return out

def dashed_rrect(x1, y1, x2, y2, color, width=4, dash=14, gap=10, r=14):
    segs = [((x1 + r, y1), (x2 - r, y1)), ((x2, y1 + r), (x2, y2 - r)),
            ((x2 - r, y2), (x1 + r, y2)), ((x1, y2 - r), (x1, y1 + r))]
    for (ax, ay), (bx, by) in segs:
        L = math.hypot(bx - ax, by - ay); n = 0.0
        while n < L:
            e = min(n + dash, L)
            d.line((ax + (bx - ax) * n / L, ay + (by - ay) * n / L, ax + (bx - ax) * e / L, ay + (by - ay) * e / L), fill=color, width=width)
            n += dash + gap
    for cx, cy, a0 in [(x1 + r, y1 + r, 180), (x2 - r, y1 + r, 270), (x2 - r, y2 - r, 0), (x1 + r, y2 - r, 90)]:
        d.arc((cx - r, cy - r, cx + r, cy + r), a0, a0 + 90, fill=color, width=width)

def badge(cx, cy, state, r=17):
    s = ST[state]
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=s["bd"], outline="white", width=3)
    d.text((cx, cy + 1), s["sym"], font=fb(int(r * 1.15)), fill="white", anchor="mm")

def box(x, y, w, h, title, sub="", state="done", note=None, tsize=24, ssize=19, dotted=False):
    s = ST[state]
    if dotted:
        d.rounded_rectangle((x, y, x + w, y + h), radius=14, fill=s["fill"])
        dashed_rrect(x, y, x + w, y + h, s["bd"])
    else:
        d.rounded_rectangle((x, y, x + w, y + h), radius=14, fill=s["fill"], outline=s["bd"], width=4)
    ty = y + 16
    for ln in wrap(title, fb(tsize), w - 60):
        d.text((x + 16, ty), ln, font=fb(tsize), fill=INK); ty += tsize + 6
    if sub:
        ty += 2
        for ln in wrap(sub, fm(ssize), w - 30):
            d.text((x + 16, ty), ln, font=fm(ssize), fill=MUTED); ty += ssize + 5
    if note:
        f = fm(17); tw = d.textlength(note, font=f)
        nx, ny = x + w - tw - 22, y + h - 34
        d.rounded_rectangle((nx - 8, ny, nx + tw + 8, ny + 26), radius=8, fill=s["bd"])
        d.text((nx, ny + 13), note, font=f, fill="white", anchor="lm")
    if s["sym"]: badge(x + w - 22, y + 22, state)
    return ty

def band(y, h, num, name, color, sub=None):
    d.rounded_rectangle((40, y, 1840, y + h), radius=20, fill=(255, 255, 255), outline=(203, 213, 225), width=2)
    d.rounded_rectangle((40, y, 250, y + h), radius=20, fill=color)
    d.rectangle((230, y, 250, y + h), fill=color)
    d.text((62, y + 22), num, font=fb(22), fill=(255, 255, 255))
    yy = y + 54
    fs_ = 25
    while max(d.textlength(w_, font=fb(fs_)) for w_ in name.split()) > 178: fs_ -= 1
    for ln in wrap(name, fb(fs_), 178):
        d.text((62, yy), ln, font=fb(fs_), fill="white"); yy += fs_ + 7
    if sub:
        for ln in wrap(sub, fm(16), 170):
            d.text((62, yy + 6), ln, font=fm(16), fill=(240, 240, 255)); yy += 21

def arrow(x1, y1, x2, y2, color=(71, 85, 105), width=4, head=14, dashed=False):
    if dashed:
        L = math.hypot(x2 - x1, y2 - y1); n = 0.0
        while n < L - head:
            e = min(n + 14, L - head)
            d.line((x1 + (x2 - x1) * n / L, y1 + (y2 - y1) * n / L, x1 + (x2 - x1) * e / L, y1 + (y2 - y1) * e / L), fill=color, width=width)
            n += 24
    else:
        d.line((x1, y1, x2, y2), fill=color, width=width)
    a = math.atan2(y2 - y1, x2 - x1)
    d.polygon([(x2, y2), (x2 - head * math.cos(a - 0.45), y2 - head * math.sin(a - 0.45)),
               (x2 - head * math.cos(a + 0.45), y2 - head * math.sin(a + 0.45))], fill=color)

# ---------------- Encabezado ----------------
d.rectangle((40, 40, 50, 130), fill=(124, 58, 237))
d.text((72, 38), "Everglow Agentes — Arquitectura y estado de implementación (135 tests) — nov 2026", font=fb(42), fill=INK)
d.text((72, 98), "Agentes autónomos que reciben un objetivo, planifican y ejecutan · clientes en España (RGPD) · LLM con residencia UE · producto de Everglow, separado de Studio (Galatea)", font=fm(22), fill=MUTED)
lx = 72; ly = 160
for k in ["done", "partial", "todo"]:
    s = ST[k]
    d.rounded_rectangle((lx, ly, lx + 46, ly + 34), radius=8, fill=s["fill"], outline=s["bd"], width=4)
    badge(lx + 46, ly, k, r=13)
    d.text((lx + 66, ly + 17), s["lab"], font=fb(24), fill=INK, anchor="lm")
    lx += 66 + d.textlength(s["lab"], font=fb(24)) + 60
d.rounded_rectangle((lx, ly, lx + 46, ly + 34), radius=8, fill=ST["future"]["fill"])
dashed_rrect(lx, ly, lx + 46, ly + 34, ST["future"]["bd"], width=3, dash=7, gap=5, r=8)
d.text((lx + 66, ly + 17), "Futuro / condicional (borde punteado)", font=fb(24), fill=INK, anchor="lm")
d.text((2360, ly + 17), "Estado al 22/11/2026", font=fm(20), fill=MUTED, anchor="rm")

X0 = 270  # inicio de contenido dentro de las bandas
# ---------------- 01 Entradas ----------------
y = 230; band(y, 170, "01", "Entradas", (37, 99, 235))
bw = 380; gap = 12
box(X0, y + 18, bw, 134, "App del negocio", "Web y móvil · órdenes al agente, chat y aprobaciones", "todo", "Proyecto aparte · SDK listo")
box(X0 + (bw + gap), y + 18, bw, 134, "WhatsApp", "Clientes finales escriben · el agente contesta (Baileys / Cloud API)", "done")
box(X0 + 2 * (bw + gap), y + 18, bw, 134, "Equipo del negocio", "Dueño y operadores: inbox, takeover, aprobaciones", "done")
box(X0 + 3 * (bw + gap), y + 18, 1838 - 20 - (X0 + 3 * (bw + gap)), 134, "Integraciones", "Sistemas del negocio por API key con scopes", "done")
# ---------------- 02 Acceso / API ----------------
y = 420; band(y, 150, "02", "Acceso / API", (14, 116, 144))
bw3 = (1818 - X0 - 2 * gap) // 3
box(X0, y + 18, bw3, 114, "API Gateway (Fastify)", "REST /v1 · SSE · WebSocket · Idempotency-Key · rate limit", "done")
box(X0 + bw3 + gap, y + 18, bw3, 114, "Auth", "Better Auth · API keys con scopes · tickets SSE/WS", "done")
box(X0 + 2 * (bw3 + gap), y + 18, bw3, 114, "OpenAPI 3.1 + SDK TS", "Contrato público generado desde zod", "done")

# ---------------- 03 Runtime de agentes autónomos (central) ----------------
y = 590; RH = 780
d.rounded_rectangle((34, y - 6, 1846, y + RH + 6), radius=24, outline=(124, 58, 237), width=6)
band(y, RH, "03", "Runtime de agentes autónomos", (124, 58, 237), "Motor de decisiones · ADR-003")
# Loop de decisión
LX, LY, LW = X0, y + 18, 1100
d.rounded_rectangle((LX, LY, LX + LW, LY + 470), radius=16, fill=(250, 245, 255), outline=(196, 181, 253), width=3)
d.text((LX + 20, LY + 16), "Loop de decisión de una Task (el agente decide el orden, no un flujo fijo)", font=fb(24), fill=(76, 29, 149))
nodes = [  # (x, y, título, sub, estado)
    (LX + 30,  LY + 70,  "1 · Objetivo y plan", "PLANNING · plan.update versionado; el agente lo revisa", "done"),
    (LX + 390, LY + 70,  "2 · Ejecutar tool", "RUNNING · tool calling con LLM UE", "done"),
    (LX + 750, LY + 70,  "3 · Evaluar riesgo", "Política por tenant sobre NEVER / ASK_OWNER / ALWAYS", "done"),
    (LX + 750, LY + 280, "4 · Aprobación", "WAITING_APPROVAL · pausa y cola de mensajes (D1)", "done"),
    (LX + 390, LY + 280, "5 · Checkpoint", "RunStep por paso · outbox sin duplicar efectos", "done"),
    (LX + 30,  LY + 280, "6 · ¿Cupo y resultado?", "Pasos / costo / tiempo · BLOCKED visible · ampliar y seguir", "done"),
]
NW, NH = 320, 150
for nx, ny, t, sb, st in nodes:
    box(nx, ny, NW, NH, t, sb, st, tsize=22, ssize=18)
c = (91, 33, 182)
arrow(LX + 30 + NW, LY + 145, LX + 390 - 4, LY + 145, c)          # 1 -> 2
arrow(LX + 390 + NW, LY + 145, LX + 750 - 4, LY + 145, c)         # 2 -> 3
arrow(LX + 750 + NW // 2, LY + 70 + NH, LX + 750 + NW // 2, LY + 280 - 4, c)  # 3 -> 4
d.text((LX + 750 + NW // 2 + 10, LY + 240), "supera el riesgo", font=fm(16), fill=c, anchor="lm")
arrow(LX + 750, LY + 355, LX + 390 + NW + 4, LY + 355, c)         # 4 -> 5
# 3 -> 5 directo (riesgo bajo)
arrow(LX + 750 - 10, LY + 70 + NH - 10, LX + 390 + NW - 30, LY + 280 - 4, c, dashed=True)
d.text((LX + 650, LY + 236), "uso directo", font=fm(16), fill=c, anchor="mm")
arrow(LX + 390, LY + 355, LX + 30 + NW + 4, LY + 355, c)          # 5 -> 6
arrow(LX + 30 + NW // 2, LY + 280, LX + 30 + NW // 2, LY + 70 + NH + 4, c)  # 6 -> 1
d.text((LX + 30 + NW // 2 + 10, LY + 248), "replanificar / siguiente paso", font=fm(16), fill=c, anchor="lm")
d.text((LX + 30, LY + 440), "Sale del loop: SUCCEEDED · FAILED · BLOCKED (sin cupo) · CANCELLED  |  Espera: WAITING_EXTERNAL · WAITING_CHILD", font=fm(17), fill=(76, 29, 149))
# Estados de la Task
sy = LY + 486
d.text((LX, sy + 4), "Estados de la Task:", font=fb(19), fill=INK)
sx = LX + 210
states = ["PLANNING", "RUNNING", "WAITING_APPROVAL", "WAITING_EXTERNAL", "WAITING_CHILD", "SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"]
row = 0
for s_ in states:
    tw = d.textlength(s_, font=fb(15)) + 20
    if sx + tw > LX + LW: sx = LX + 210; row += 1
    d.rounded_rectangle((sx, sy + row * 34, sx + tw, sy + 26 + row * 34), radius=8, fill=(237, 233, 254), outline=(167, 139, 250), width=2)
    d.text((sx + tw / 2, sy + 13 + row * 34), s_, font=fb(15), fill=(76, 29, 149), anchor="mm")
    sx += tw + 8
# Componentes del runtime (debajo del loop)
cy = LY + 570; cw = (LW - 2 * gap) // 3; ch = 140
box(LX, cy, cw, ch, "Task autónoma", "Objetivo, origen, plan versionado, límites y gasto · /v1/tasks", "done")
box(LX + cw + gap, cy, cw, ch, "Loop con cupo", "Corte visible por pasos, costo y tiempo", "done")
box(LX + 2 * (cw + gap), cy, cw, ch, "Delegación", "Task hija solo si la tarea lo pide (WAITING_CHILD) · profundidad 3", "done")
# Columna derecha del runtime
RX = LX + LW + 20; RW = 1818 - RX
box(RX, LY, RW, 140, "Agent runtime base", "Tool calling con checkpoint por paso · caras interna y externa · cancelación · barrido de huérfanos", "done")
box(RX, LY + 150, RW, 120, "Aprobaciones", "WAITING_APPROVAL · caducan solas · cola de mensajes (D1)", "done", "Con cola D1")
box(RX, LY + 280, RW, 112, "Riesgo por tenant", "read · write · send · money · delete → directo o aprobación; solo endurece", "done")
box(RX, LY + 402, RW, 130, "Memoria en 3 capas", "RAG del negocio · memoria del contacto · notas del agente", "partial", "Hechos · falta RAG")
# LLM BYOK UE
ly2 = LY + 542
d.rounded_rectangle((RX, ly2, RX + RW, LY + 730), radius=14, fill=(250, 250, 255), outline=(129, 140, 248), width=3)
d.text((RX + 16, ly2 + 12), "LLM BYOK · residencia UE (ADR-005)", font=fb(19), fill=(55, 48, 163))
hw = (RW - 36) // 2
box(RX + 12, ly2 + 44, hw, 128, "Capa LLM", "Azure UE · Mistral · self/eu-hosted · BYOK", "done", tsize=18, ssize=15)
box(RX + 24 + hw, ly2 + 44, hw, 128, "Validación región UE", "Al guardar y al usar · BLOCKED model_region", "done", tsize=18, ssize=15)

# ---------------- 04 Dominio ----------------
y = 1380; band(y, 250, "04", "Dominio / negocio", (5, 150, 105), "Módulos que el agente usa como tools")
dw = (1818 - X0 - 4 * gap) // 5; dh = 100
dom = [("Contactos", "CRUD · sin duplicados", "done"), ("Conversaciones", "", "done"), ("Inbox y takeover", "API completa", "done"),
       ("Leads y embudo", "API + tools", "done"), ("Agenda y turnos", "API + tools", "done"),
       ("Tareas y runs", "", "done"), ("Rutinas", "routine.cron por minuto", "done"), ("Secuencias", "Seguimiento", "done"),
       ("Plantillas por rubro", "", "todo"), ("Base de conocimiento", "RAG", "todo")]
for i, (t, sb, st) in enumerate(dom):
    box(X0 + (i % 5) * (dw + gap), y + 18 + (i // 5) * (dh + 14), dw, dh, t, sb, st, tsize=21, ssize=17)

# ---------------- 05 Tools e integraciones ----------------
y = 1650; band(y, 230, "05", "Tools e integraciones", (217, 119, 6))
box(X0, y + 18, 330, 194, "Registro de tools", "ToolDef zod: scope, riesgo, aprobación · internas + Composio", "done")
box(X0 + 342, y + 18, 330, 194, "Composio Gateway", "Apps del negocio como tools · aislado por workspace", "partial", "1 key/servidor · sin triggers")
box(X0 + 684, y + 18, 260, 194, "Ejecutores enchufables", "Runtime local / sandbox", "todo", "Post-MVP")
cx0 = X0 + 956; cwid = 1818 - cx0
d.rounded_rectangle((cx0, y + 18, 1818, y + 212), radius=14, fill=(255, 251, 235), outline=(217, 119, 6), width=4)
badge(1818 - 22, y + 40, "partial")
d.text((cx0 + 16, y + 34), "Adaptadores de canal (ChannelAdapter)", font=fb(23), fill=INK)
pw = (cwid - 3 * 12) // 2
for i, (t, st) in enumerate([("WhatsApp · Baileys", "done"), ("WhatsApp · Cloud API", "done"), ("Email · SMTP/Composio", "todo"), ("Instagram", "todo")]):
    px = cx0 + 12 + (i % 2) * (pw + 12); py = y + 78 + (i // 2) * 62
    box(px, py, pw, 52, t, "", st, tsize=16)

# ---------------- 06 Ejecución ----------------
def chip(x, y, w, h, t, st):
    c_ = ST[st]
    d.rounded_rectangle((x, y, x + w, y + h), radius=10, fill=c_["fill"], outline=c_["bd"], width=3)
    f_ = 17
    while d.textlength(t, font=fb(f_)) > w - 40: f_ -= 1
    d.text((x + 12, y + h / 2), t, font=fb(f_), fill=INK, anchor="lm")
    badge(x + w - 16, y + h / 2, st, r=12)
y = 1900; band(y, 290, "06", "Ejecución asíncrona", (219, 39, 119), "Motor de jobs · ADR-004")
box(X0, y + 18, 230, 254, "Puerto de jobs", "JobPort + WaitPort (ADR 004): enqueue, schedule, wakeAt, wakeOnSignal", "done")
qx = X0 + 260; qw = 900
d.rounded_rectangle((qx, y + 18, qx + qw, y + 272), radius=14, fill=ST["done"]["fill"], outline=ST["done"]["bd"], width=4)
badge(qx + qw - 22, y + 40, "done")
d.text((qx + 16, y + 32), "pg-boss 12 · cola, scheduler y workers (hoy)", font=fb(22), fill=INK)
d.text((qx + 16, y + 66), "Retoma Tasks en espera · run.process / task.wake · tareas de días sobre Postgres", font=fm(17), fill=MUTED)
jobs = [("channel.inbound", "done"), ("run.process", "done"), ("task.wake", "done"), ("sequence.step", "done"),
        ("routine.cron", "done"), ("crm.sync", "todo"), ("integration.event", "todo"), ("appointment.reminder", "done")]
jw = (qw - 5 * 10) // 4
for i, (t, st) in enumerate(jobs):
    chip(qx + 10 + (i % 4) * (jw + 10), y + 110 + (i // 4) * 80, jw, 64, t, st)
arrow(X0 + 230, y + 145, qx - 4, y + 145)
tx = qx + qw + 40; tw_ = 1818 - tx
box(tx, y + 18, tw_, 78, "Temporal (futuro)", "Hetzner UE · criterios ADR-004", "future", dotted=True, tsize=19, ssize=15)
arrow(qx + qw + 4, y + 57, tx - 4, y + 57, color=(100, 116, 139), dashed=True, head=10, width=3)
box(tx, y + 106, tw_, 78, "Bus de eventos", "Event + LISTEN/NOTIFY", "done", tsize=19, ssize=15)
box(tx, y + 194, tw_, 78, "Outbox", "Efecto externo sin duplicar", "done", tsize=19, ssize=15)

# ---------------- 07 Datos y cumplimiento ----------------
y = 2210; band(y, 170, "07", "Datos y cumplimiento", (13, 148, 136))
dws = [420, 250, 280, 330]
xs = X0; items = [("PostgreSQL 16 + pgvector", "Prisma 7 · workspaceId en toda entidad", "done", "pgvector activo · sin tablas RAG"),
                  ("Tenant-guard", "Aislamiento por workspace", "done", None),
                  ("Archivos", "Disco · sesión Baileys cifrada", "partial", "Sin S3 ni cifrado"),
                  ("Auditoría RGPD", "Decisión, dato, tool, modelo, región por tramo", "partial", "Falta export/borrado")]
for (t, sb, st, nt), w_ in zip(items, dws):
    box(xs, y + 18, w_, 134, t, sb, st, nt); xs += w_ + gap
box(xs, y + 18, 1818 - xs, 134, "Backups", "pg_dump diario + volúmenes", "todo", "Documentado")

# ---------------- 08 Infraestructura ----------------
y = 2400; band(y, 110, "08", "Infraestructura", (71, 85, 105))
box(X0, y + 14, 1548, 82, "Docker Compose · server (ROLE=all) · postgres + pgvector · caddy (TLS) · ollama opcional", "Imagen única · corre 24/7 en VPS UE", "done", tsize=21, ssize=17)

# ---------------- Columna derecha: externos, observabilidad, seguridad ----------------
SX = 1870; SW = 490
d.rounded_rectangle((SX, 230, SX + SW, 1130), radius=20, fill=(255, 255, 255), outline=(203, 213, 225), width=2)
d.text((SX + 20, 250), "SERVICIOS EXTERNOS (UE)", font=fb(22), fill=MUTED)
box(SX + 16, 296, SW - 32, 190, "LLM en la UE", "Azure OpenAI (región UE) · Mistral (UE) · modelos alojados en la UE. Rechazados: Grok y endpoints sin región demostrada", "done", "Integrado · sin probar real", tsize=22, ssize=17)
box(SX + 16, 500, SW - 32, 170, "Composio", "Una key por servidor · Gmail, Calendar, HubSpot, Holded y +1000 apps", "done", "Integrado · sin probar real", tsize=22, ssize=17)
box(SX + 16, 684, SW - 32, 150, "Meta / WhatsApp", "Baileys · Cloud API al aprobar Tech Provider · Instagram luego", "done", "Integrado · sin probar real", tsize=22, ssize=17)
d.text((SX + 20, 860), "Flechas principales", font=fb(19), fill=INK)
for i, t in enumerate(["Entradas → API → runtime (03)", "Runtime → LLM UE y tools (05)", "Jobs (06) despiertan y retoman Tasks", "Todo efecto externo pasa por el outbox", "Toda consulta lleva workspaceId"]):
    d.text((SX + 20, 894 + i * 30), "• " + t, font=fm(18), fill=MUTED)
# flechas en el cuerpo
arrow(1050, 400, 1050, 436, (37, 99, 235))
arrow(1050, 570, 1050, 600, (124, 58, 237))
arrow(1846, 990, SX - 2, 990, (129, 140, 248))  # runtime -> LLM

def pills(x, y, title, items, color):
    d.rounded_rectangle((x, y, x + 235, y + 1250), radius=20, fill=(255, 255, 255), outline=color, width=3)
    d.text((x + 117, y + 30), title, font=fb(21), fill=color, anchor="mm")
    for i, (t, st, nt) in enumerate(items):
        py = y + 70 + i * 190
        box(x + 14, py, 207, 170, t, nt, st, tsize=20, ssize=16)

pills(SX, 1150, "OBSERVABILIDAD", [("Logs", "done", "pino con redacción"), ("Auditoría", "done", "AuditLog"), ("Métricas", "done", "/metrics"),
                                   ("Costos", "partial", "Tarifa de referencia, no facturación"), ("Health", "done", "/health · /ready"), ("Tokens", "done", "Uso por run")], (13, 148, 136))
pills(SX + 255, 1150, "SEGURIDAD", [("Vault", "partial", "Secretos propios"), ("Claves", "done", "AES-256-GCM + rotación"), ("Caras", "done", "Interna / externa"),
                                     ("Firmas", "partial", "Meta sí · Composio no"), ("TLS", "done", "caddy"), ("Rate limit", "done", "Por principal")], (220, 38, 38))

# ---------------- Pie ----------------
fy = 2535
d.text((40, fy), "Pendiente prioritario (ROADMAP): RAG y base de conocimiento (E6) · exportar y borrar un contacto (E8) · triggers Composio (integration.event) · crm.sync · plantillas por rubro · backups.", font=fm(19), fill=MUTED)
d.text((40, fy + 30), "«Sin probar real»: probado con simulaciones. Fuente: docs/ARCHITECTURE.md, ADR-003/004/005, ROADMAP.md · everglow-agentes · v4.1 · 22/11/2026", font=fm(19), fill=MUTED)
img.save(OUT, optimize=True)
print(OUT, img.size)
