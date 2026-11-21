import base64, re, html
from fontTools.ttLib import TTFont

FONT = TTFont('/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf')
CMAP = FONT.getBestCmap(); HMTX = FONT['hmtx']; UPM = FONT['head'].unitsPerEm
def tw(s, size, weight=400):
    w = sum(HMTX[CMAP.get(ord(c), CMAP[ord('n')])][0] for c in s) / UPM * size
    return w * (1 + (weight - 400) / 400 * 0.09)
def wrap(s, size, maxw, weight=400):
    words, lines, cur = s.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if tw(t, size, weight) <= maxw or not cur: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

ICONS = {}
def icon(name, x, y, size, color, sw=2):
    if name not in ICONS:
        raw = open(f'/tmp/luc/package/icons/{name}.svg').read()
        body = re.sub(r'<!--.*?-->', '', raw, flags=re.S)
        body = re.search(r'<svg[^>]*>(.*)</svg>', body, re.S).group(1).strip()
        ICONS[name] = body
    s = size / 24
    return (f'<g transform="translate({x},{y}) scale({s})" fill="none" stroke="{color}" '
            f'stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round">{ICONS[name]}</g>')

W, H = 1600, 1652
FAM = "Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
INK, MUTED, LINE = '#0F172A', '#475569', '#94A3B8'
F1, F2 = '#DC2626', '#3730A3'   # flujo WhatsApp, flujo UI

L = [  # key, nombre, color, y0, y1
 ('01', 'Clientes', '#0284C7', 120, 216),
 ('02', 'Acceso / API', '#2563EB', 244, 340),
 ('03', 'Orquestación e inteligencia', '#7C3AED', 368, 518),
 ('04', 'Dominio / negocio', '#059669', 546, 696),
 ('05', 'Integraciones', '#D97706', 724, 894),
 ('06', 'Ejecución asíncrona', '#DB2777', 922, 1042),
 ('07', 'Datos', '#0D9488', 1070, 1166),
 ('08', 'Infraestructura', '#475569', 1194, 1298),
]
C = {k: c for k, n, c, a, b in L}
out = []
def add(s): out.append(s)
def esc(s): return html.escape(s, quote=True)

def text(x, y, s, size=12, weight=400, color=INK, anchor='start', extra=''):
    add(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" font-weight="{weight}" fill="{color}" '
        f'text-anchor="{anchor}" {extra}>{esc(s)}</text>')

def tint(hexc, a):
    r, g, b = int(hexc[1:3], 16), int(hexc[3:5], 16), int(hexc[5:7], 16)
    return f'rgba({r},{g},{b},{a})'

def card(x0, x1, y0, y1, color, title, sub=None, ic=None, dashed=False, chips=None, chip_cols=2, tsize=13.5):
    w, h = x1 - x0, y1 - y0
    dash = ' stroke-dasharray="6 4"' if dashed else ''
    fill = '#FFFFFF' if not dashed else '#FBFBFD'
    add(f'<rect x="{x0}" y="{y0}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{tint(color,0.45)}" stroke-width="1.2"{dash} filter="url(#sh)"/>')
    if not dashed:
        add(f'<rect x="{x0}" y="{y0+10}" width="3.5" height="{h-20}" rx="1.75" fill="{color}"/>')
    tx = x0 + 14
    if ic:
        add(f'<rect x="{x0+12}" y="{y0+12}" width="30" height="30" rx="8" fill="{tint(color,0.12)}"/>')
        add(icon(ic, x0 + 18, y0 + 18, 18, color))
        tx = x0 + 52
    maxw = x1 - tx - 12
    tl = wrap(title, tsize, maxw, 650)
    ty = y0 + 24 if len(tl) == 1 else y0 + 19
    for i, l in enumerate(tl):
        text(tx, ty + i * 16, l, tsize, 650, INK)
    cy = max(y0 + 50, ty + (len(tl) - 1) * 16 + 18)
    if sub:
        subx = x0 + 14
        for i, l in enumerate(wrap(sub, 10.5, x1 - subx - 12)):
            text(subx, cy + 2 + i * 14, l, 10.5, 400, MUTED)
            last = cy + 2 + i * 14
        cy = last + 10
    if chips:
        n = len(chips); cols = chip_cols; rows = (n + cols - 1) // cols
        gx, gy = 6, 6; cw = (w - 28 - gx * (cols - 1)) / cols; ch = 22
        if sub is None: cy = cy - 6
        r = c = 0
        for i, ctext in enumerate(chips):
            full = ctext.endswith('^')
            ctext = ctext.rstrip('^')
            if full and c != 0: r += 1; c = 0
            cww = (w - 28) if full else cw
            cx = x0 + 14 + c * (cw + gx); yy = cy + r * (ch + gy)
            dashed_chip = ctext.endswith('*')
            label = ctext.rstrip('*')
            cst = None
            if len(label) > 2 and label[1] == '|': cst, label = label[0], label[2:]
            d2 = ' stroke-dasharray="4 3"' if dashed_chip else ''
            add(f'<rect x="{cx:.1f}" y="{yy:.1f}" width="{cww:.1f}" height="{ch}" rx="6" fill="{tint(color,0.08 if not dashed_chip else 0.0)}" stroke="{tint(color,0.35)}" stroke-width="1"{d2}/>')
            fs = 10.2; pad = 18 if cst else 0
            while tw(label, fs, 550) > cww - 10 - pad and fs > 8: fs -= 0.2
            text(cx + cww / 2 + pad / 2, yy + 14.6, label, fs, 550, color if not dashed_chip else MUTED, 'middle')
            if cst:
                st_icon(cx + cww / 2 - tw(label, fs, 550) / 2 + pad / 2 - 10, yy + ch / 2, cst, 5.6)
            if full: r += 1; c = 0
            else:
                c += 1
                if c >= cols: r += 1; c = 0

def chip(x0, x1, y0, y1, color, label, ic):
    add(f'<rect x="{x0}" y="{y0}" width="{x1-x0}" height="{y1-y0}" rx="9" fill="#FFFFFF" stroke="{tint(color,0.45)}" stroke-width="1.2" filter="url(#sh)"/>')
    add(f'<rect x="{x0+10}" y="{(y0+y1)/2-12}" width="24" height="24" rx="6" fill="{tint(color,0.12)}"/>')
    add(icon(ic, x0 + 15, (y0 + y1) / 2 - 7, 14, color))
    lines = wrap(label, 12, x1 - x0 - 52, 600)
    base = (y0 + y1) / 2 + 4 - (len(lines) - 1) * 7.5
    for i, l in enumerate(lines):
        text(x0 + 42, base + i * 15, l, 12, 600, INK)

def arrow(pts, color, w=2.0, dashed=False, head=True, start_head=False, hops=None):
    d = f'M{pts[0][0]},{pts[0][1]}'
    for (x, y) in pts[1:]:
        d += f' L{x},{y}'
    if hops:  # solo para tramos horizontales: [(y, x_inicio, x_fin, [x_cruces])]
        pass
    dash = ' stroke-dasharray="6 4"' if dashed else ''
    mk = f' marker-end="url(#ah-{color[1:]})"' if head else ''
    ms = f' marker-start="url(#as-{color[1:]})"' if start_head else ''
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linejoin="round"{dash}{mk}{ms}/>')

def hop_line(y, x0, x1, crosses, color, w=1.6, dashed=False):
    # línea horizontal de x0 a x1 con saltos semicirculares en los cruces
    r = 5; d = f'M{x0},{y}'
    for cx in sorted(crosses):
        d += f' L{cx-r},{y} A{r},{r} 0 0 1 {cx+r},{y}'
    d += f' L{x1},{y}'
    dash = ' stroke-dasharray="6 4"' if dashed else ''
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}"{dash}/>')

def badge(x, y, label, color):
    add(f'<circle cx="{x}" cy="{y}" r="11" fill="{color}" stroke="#FFFFFF" stroke-width="2.2"/>')
    text(x, y + 4.1, label, 11.5, 750, '#FFFFFF', 'middle')

ST_COL = {'d': '#16A34A', 'p': '#D97706', 'x': '#64748B'}
def st_icon(cx, cy, st, r=7):
    col = ST_COL[st]
    if st == 'p':
        add(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="#FFFFFF" stroke="{col}" stroke-width="1.8"/>')
        add(f'<path d="M{cx},{cy-r+0.9} A{r-0.9},{r-0.9} 0 0 1 {cx},{cy+r-0.9} Z" fill="{col}"/>')
        return
    add(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{col}"/>')
    k = r / 7
    if st == 'd':
        add(f'<path d="M{cx-3.3*k},{cy+0.2*k} L{cx-0.9*k},{cy+2.6*k} L{cx+3.4*k},{cy-2.4*k}" fill="none" stroke="#FFFFFF" stroke-width="{1.9*k:.2f}" stroke-linecap="round" stroke-linejoin="round"/>')
    else:
        add(f'<path d="M{cx-2.6*k},{cy-2.6*k} L{cx+2.6*k},{cy+2.6*k} M{cx+2.6*k},{cy-2.6*k} L{cx-2.6*k},{cy+2.6*k}" fill="none" stroke="#FFFFFF" stroke-width="{1.9*k:.2f}" stroke-linecap="round"/>')

def status_tag(x0, x1, y0, y1, st, label=None, pos='tr'):
    """Etiqueta de estado montada sobre el borde de un bloque (arriba o abajo, a izquierda o derecha)."""
    col = ST_COL[st]; fs = 9.4; h = 18
    lw = tw(label, fs, 600) if label else 0
    w = 22 + (lw + 8 if label else -4)
    yc = y0 if pos[0] == 't' else y1
    xa = x1 - 10 - w if pos[1] == 'r' else x0 + 12
    add(f'<rect x="{xa:.1f}" y="{yc-h/2:.1f}" width="{w:.1f}" height="{h}" rx="9" fill="#FFFFFF" stroke="{tint(col,0.75)}" stroke-width="1.2"/>')
    st_icon(xa + 9.5, yc, st, 6.2)
    if label:
        text(xa + 20, yc + 3.3, label, fs, 600, col if st != 'x' else '#475569')

font64 = base64.b64encode(open('/tmp/diag/inter-sub.woff2', 'rb').read()).decode()
markers = ''
for col in [F1, F2, LINE, '#64748B']:
    k = col[1:]
    markers += (f'<marker id="ah-{k}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
                f'<path d="M0,0.8 L9.2,5 L0,9.2 L2.2,5 Z" fill="{col}"/></marker>'
                f'<marker id="as-{k}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
                f'<path d="M0,0.8 L9.2,5 L0,9.2 L2.2,5 Z" fill="{col}"/></marker>')
add(f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{FAM}">
<defs>
<style>@font-face{{font-family:'Inter';src:url(data:font/woff2;base64,{font64}) format('woff2');font-weight:100 900;}}
text{{font-family:{FAM};font-feature-settings:'cv11','ss01';}}</style>
<filter id="sh" x="-5%" y="-10%" width="110%" height="130%"><feDropShadow dx="0" dy="1.2" stdDeviation="1.6" flood-color="#0F172A" flood-opacity="0.08"/></filter>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F8FAFC"/><stop offset="1" stop-color="#F1F5F9"/></linearGradient>
{markers}
</defs>
<rect width="{W}" height="{H}" fill="url(#bg)"/>''')

# ---------- Título ----------
add(f'<rect x="24" y="24" width="6" height="64" rx="3" fill="#7C3AED"/>')
text(44, 56, 'Plataforma Multiagente: arquitectura de referencia (MVP)', 28, 750, INK)
text(44, 82, 'Motor headless 24/7 · un workspace, listo para multitenant · la UI estilo Grok Bot se conecta solo por la API pública', 13.5, 450, MUTED)
add(f'<rect x="1380" y="38" width="176" height="34" rx="17" fill="#EEF2FF" stroke="#C7D2FE"/>')
text(1468, 60, 'MVP · paridad Auryx', 12.5, 650, '#3730A3', 'middle')

# ---------- Rail de capas y paneles ----------
for k, n, col, y0, y1 in L:
    add(f'<rect x="24" y="{y0}" width="140" height="{y1-y0}" rx="12" fill="{col}"/>')
    text(38, y0 + 24, k, 11, 700, 'rgba(255,255,255,0.75)', extra='letter-spacing="1"')
    lines = wrap(n, 13.5, 116, 700)
    for i, l in enumerate(lines):
        text(38, y0 + 44 + i * 17, l, 13.5, 700, '#FFFFFF')
    add(f'<rect x="176" y="{y0}" width="974" height="{y1-y0}" rx="14" fill="{tint(col,0.055)}" stroke="{tint(col,0.18)}" stroke-width="1"/>')

# ---------- Capa 1: Clientes ----------
y0, y1 = 134, 202
card(206, 586, y0, y1, C['01'], 'UI estilo Grok Bot', 'Desktop · Web · Móvil. Proyecto aparte: solo habla con la API pública', 'monitor-smartphone')
card(626, 878, y0, y1, C['01'], 'Integraciones', 'Scripts, Zapier y sistemas del negocio por API key', 'webhook')
card(898, 1130, y0, y1, C['01'], 'Equipo del negocio', 'Dueño y operadores: chat, inbox, aprobaciones', 'users')

# ---------- Capa 2: Acceso ----------
y0, y1 = 258, 326
card(206, 586, y0, y1, C['02'], 'API Gateway', 'REST /v1 · SSE · WebSocket /v1/ws · Idempotency-Key · rate limit', 'network')
card(626, 878, y0, y1, C['02'], 'Auth', 'Sesiones Better Auth · API keys con scopes · tickets WS', 'shield-check')
card(898, 1130, y0, y1, C['02'], 'OpenAPI 3.1 + SDK TS', 'Contrato público, generado desde zod', 'file-code-2')

# ---------- Capa 3: Orquestación ----------
y0, y1 = 382, 504
card(206, 356, y0, y1, C['03'], 'Orquestador', 'Equipos, coordinador, delegate_task y handoff', 'workflow')
card(372, 522, y0, y1, C['03'], 'Aprobaciones', 'Persistidas. NEVER, ASK_OWNER, ALWAYS; vencen solas', 'hand')
card(538, 688, y0, y1, C['03'], 'Memoria y RAG', 'Hechos por contacto y agente · pgvector + texto', 'brain-circuit')
card(704, 904, y0, y1, C['03'], 'Agent runtime', 'Loop de tool calling con checkpoint por paso. Caras externa e interna separadas', 'bot')
card(934, 1130, y0, y1, C['03'], 'Capa LLM', 'Locales: Ollama y LM Studio', 'sparkles', chips=['OpenAI', 'Anthropic', 'Gemini', 'Locales'])

# ---------- Capa 4: Dominio ----------
r1, r2 = (560, 614), (628, 682)
cols_l = [(206, 366), (381, 541), (556, 716)]
cols_r = [(800, 957), (973, 1130)]
items = [(cols_l[0], r1, 'Contactos', 'users'), (cols_l[1], r1, 'Conversaciones', 'message-square'),
         (cols_l[2], r1, 'Inbox y takeover', 'inbox'), (cols_r[0], r1, 'Leads y embudo', 'target'),
         (cols_r[1], r1, 'Agenda y turnos', 'calendar-clock'), (cols_l[0], r2, 'Tareas y runs', 'list-checks'),
         (cols_l[1], r2, 'Rutinas', 'timer'), (cols_l[2], r2, 'Secuencias de seguimiento', 'repeat'),
         (cols_r[0], r2, 'Plantillas por rubro', 'layout-template'), (cols_r[1], r2, 'Base de conocimiento', 'book-open')]
for (x0, x1), (yy0, yy1), lab, ic in items:
    chip(x0, x1, yy0, yy1, C['04'], lab, ic)

# ---------- Capa 5: Integraciones ----------
y0, y1 = 738, 880
card(206, 356, y0, y1, C['05'], 'Registro de tools', 'ToolDef con zod: scope, riesgo, aprobación y conexión requerida', 'wrench')
card(376, 528, y0, y1, '#64748B', 'Ejecutores enchufables', 'Post-MVP', 'cpu', dashed=True, chips=['Runtime local (PC)*', 'OpenSandbox*'], chip_cols=1)
card(548, 700, y0, y1, C['05'], 'Composio Gateway', 'Toolkits y conexiones · acciones como tools con nuestras reglas · triggers', 'blocks')
card(780, 1130, y0, y1, C['05'], 'Adaptadores de canal', 'Interfaz ChannelAdapter: el proveedor se cambia por canal', 'radio',
     chips=['d|WhatsApp · Baileys', 'd|WhatsApp · Cloud API', 'x|Email · SMTP o Composio', 'x|Instagram · luego*'])

# ---------- Capa 6: Ejecución asíncrona ----------
y0, y1 = 936, 1028
card(206, 900, y0, y1, C['06'], 'Cola, scheduler y workers · pg-boss 12', None, 'layers',
     chips=['d|channel.inbound', 'd|run.process', 'd|message.outbound', 'd|run.sweep', 'x|sequence.step', 'x|routine.cron', 'x|crm.sync · integration.event', 'x|appointment.reminder'], chip_cols=4)
card(920, 1130, y0, y1, C['06'], 'Bus de eventos', 'Tabla Event con seq + LISTEN/NOTIFY. Alimenta WS, SSE y auditoría', 'activity')

# ---------- Capa 7: Datos ----------
y0, y1 = 1084, 1152
card(206, 660, y0, y1, C['07'], 'PostgreSQL 16 + pgvector', 'Datos, cola, eventos y vectores · Prisma 7 · workspaceId en toda entidad', 'database')
card(680, 900, y0, y1, C['07'], 'Archivos', 'Disco local o S3 · sesión Baileys cifrada', 'hard-drive')
card(920, 1130, y0, y1, C['07'], 'Backups', 'pg_dump diario + copia de volúmenes', 'archive' if False else 'box')

# ---------- Capa 8: Infraestructura ----------
y0, y1 = 1208, 1284
add(f'<rect x="206" y="{y0}" width="924" height="{y1-y0}" rx="10" fill="#FFFFFF" stroke="{tint(C["08"],0.45)}" stroke-width="1.2" filter="url(#sh)"/>')
add(f'<rect x="218" y="{y0+12}" width="30" height="30" rx="8" fill="{tint(C["08"],0.12)}"/>')
add(icon('container', 224, y0 + 18, 18, C['08']))
text(258, y0 + 28, 'Docker Compose', 13.5, 650, INK)
text(258, y0 + 46, 'VPS, PC o mini PC · restart: unless-stopped', 10.5, 400, MUTED)
text(258, y0 + 62, 'Corre 24/7 aunque no haya UI abierta', 10.5, 400, MUTED)
ct = [('server · ROLE=all', 'API · WS · workers · Baileys', 'server'), ('postgres + pgvector', 'volumen de datos', 'database'),
      ('caddy · TLS', 'HTTPS: UI y webhooks', 'lock'), ('ollama (opcional)', 'modelos locales en el host', 'cpu')]
cx = 516; cw = 144; gap = 10
for i, (a, b, ic) in enumerate(ct):
    x0 = cx + i * (cw + gap)
    dashed = i == 3
    add(f'<rect x="{x0}" y="{y0+12}" width="{cw}" height="{y1-y0-24}" rx="8" fill="{tint(C["08"],0.06)}" stroke="{tint(C["08"],0.35)}"{" stroke-dasharray=\"4 3\"" if dashed else ""}/>')
    add(icon(ic, x0 + 10, y0 + 21, 14, C['08']))
    text(x0 + 30, y0 + 33, a, 11, 650, INK)
    text(x0 + 10, y0 + 52, b, 9.6, 400, MUTED)

# ---------- Servicios externos ----------
add(f'<rect x="1166" y="368" width="208" height="526" rx="14" fill="#FFFFFF" fill-opacity="0.55" stroke="#CBD5E1" stroke-dasharray="6 5"/>')
add(icon('globe', 1180, 376, 14, '#64748B'))
text(1200, 388, 'SERVICIOS EXTERNOS', 10.5, 700, '#64748B', extra='letter-spacing="0.8"')
card(1176, 1364, 398, 488, '#334155', 'APIs de LLM', 'OpenAI, Anthropic, Gemini por API key del workspace', 'cloud')
card(1176, 1364, 512, 702, '#7C3AED', 'Composio', 'Capa única de conectores: auth administrada, acciones y triggers', 'blocks',
     chips=['Holded', 'Gmail', 'Google Calendar^', 'HubSpot', '+1800 apps'], chip_cols=2)
card(1176, 1364, 752, 872, '#334155', 'Meta', 'WhatsApp (Baileys hoy, Cloud API al aprobar Tech Provider) e Instagram', 'message-circle')

# ---------- Bandas transversales ----------
def band(x0, x1, col, title, sub, ic, items):
    y0, y1 = 244, 1166
    add(f'<rect x="{x0}" y="{y0}" width="{x1-x0}" height="{y1-y0}" rx="14" fill="{tint(col,0.08)}" stroke="{tint(col,0.35)}"/>')
    add(f'<rect x="{(x0+x1)/2-16}" y="{y0+14}" width="32" height="32" rx="9" fill="{col}"/>')
    add(icon(ic, (x0 + x1) / 2 - 9, y0 + 21, 18, '#FFFFFF'))
    cxm = (x0 + x1) / 2
    py = y0 + 64
    for it in items:
        stc, it = (it[0], it[2:]) if len(it) > 2 and it[1] == '|' else (None, it)
        add(f'<rect x="{x0+7}" y="{py}" width="{x1-x0-14}" height="22" rx="6" fill="#FFFFFF" stroke="{tint(col,0.35)}"/>')
        fs = 9.6; pad = 11 if stc else 0
        while tw(it, fs, 600) > x1 - x0 - 22 - pad and fs > 7.5: fs -= 0.2
        text(x0 + 12 + pad, py + 14.6, it, fs, 600, col) if stc else text(cxm, py + 14.6, it, fs, 600, col, 'middle')
        if stc: st_icon(x0 + 16.5, py + 11, stc, 5)
        py += 30
    cym = (py + y1) / 2 + 10
    add(f'<text transform="translate({cxm-6},{cym}) rotate(-90)" font-size="15" font-weight="750" fill="{col}" text-anchor="middle" letter-spacing="0.6">{esc(title)}</text>')
    add(f'<text transform="translate({cxm+13},{cym}) rotate(-90)" font-size="10.5" font-weight="500" fill="{MUTED}" text-anchor="middle">{esc(sub)}</text>')
band(1392, 1466, '#0F766E', 'AUDITORÍA Y OBSERVABILIDAD', 'Logs pino · AuditLog · costos por run · /health y /ready · métricas', 'activity', ['d|Logs', 'd|Auditoría', 'x|Métricas', 'p|Costos', 'd|Health', 'd|Tokens'])
band(1482, 1556, '#B91C1C', 'SEGURIDAD', 'Vault solo de secretos propios · key de Composio solo en backend · caras · firma Meta y Composio · TLS', 'lock', ['p|Vault', 'd|Claves', 'd|Caras', 'p|Firmas', 'd|TLS', 'd|Rate limit'])

# ---------- Dependencias (gris) ----------
G = '#64748B'
arrow([(1130, 443), (1174, 443)], G, 1.6)                                  # LLM -> APIs LLM
arrow([(356, 809), (374, 809)], G, 1.6, dashed=True)                       # tools -> ejecutores
# conectores -> Google / Holded por el pasillo entre capas 4 y 5, con saltos en los cruces
add(f'<path d="M624,738 L624,710" fill="none" stroke="{G}" stroke-width="1.6"/>')
hop_line(710, 624, 1156, [734, 756, 788], G)
add(f'<path d="M1156,710 L1156,607 L1174,607" fill="none" stroke="{G}" stroke-width="1.6" marker-end="url(#ah-64748B)"/>')
arrow([(420, 1028), (420, 1082)], G, 1.6)                                  # cola -> postgres
arrow([(1025, 1028), (1025, 1046), (600, 1046), (600, 1082)], G, 1.6)      # bus -> postgres

# ---------- Flujo 1: WhatsApp entrante (rojo) ----------
arrow([(1176, 795), (1132, 795)], F1, 2.2)            # 1 Meta -> adaptador
arrow([(850, 880), (850, 934)], F1, 2.2)              # 2 adaptador -> cola
arrow([(756, 936), (756, 506)], F1, 2.2)              # 3 cola -> runtime
arrow([(904, 432), (932, 432)], F1, 2.2)              # 4 runtime -> LLM
arrow([(934, 456), (906, 456)], F1, 2.2)              #   LLM -> runtime
arrow([(788, 504), (788, 736)], F1, 2.2)              # 5 runtime -> adaptador (outbox)
arrow([(1130, 830), (1174, 830)], F1, 2.2)            # 6 adaptador -> Meta

# ---------- Flujo 2: chat desde la UI (índigo) ----------
arrow([(330, 202), (330, 256)], F2, 2.2)                                   # A UI -> gateway
arrow([(206, 292), (191, 292), (191, 982), (204, 982)], F2, 2.2)          # B gateway -> cola
arrow([(734, 936), (734, 506)], F2, 2.2)                                   # C cola -> runtime
arrow([(880, 382), (880, 354), (560, 354), (560, 328)], F2, 2.2)           # D runtime -> gateway (eventos)
arrow([(470, 258), (470, 204)], F2, 2.2)                                   # E gateway -> UI (SSE/WS)

badge(1153, 795, '1', F1); badge(850, 908, '2', F1); badge(756, 800, '3', F1)
badge(919, 410, '4', F1); badge(788, 620, '5', F1); badge(1153, 830, '6', F1)
badge(330, 230, 'A', F2); badge(191, 620, 'B', F2); badge(734, 650, 'C', F2)
badge(720, 354, 'D', F2); badge(470, 230, 'E', F2)

# ---------- Estado de implementación por bloque (v1.2, verificado sobre el código v2) ----------
TAGS = [
 # capa 1
 ((206, 586, 134, 202), 'x', 'proyecto aparte · SDK listo', 'tr'),
 ((626, 878, 134, 202), 'd', None, 'tr'),
 ((898, 1130, 134, 202), 'p', 'chat y aprobaciones · sin inbox', 'tr'),
 # capa 2
 ((206, 586, 258, 326), 'd', None, 'tr'),
 ((626, 878, 258, 326), 'd', 'alta pública cerrada', 'tr'),
 ((898, 1130, 258, 326), 'd', None, 'tr'),
 # capa 3
 ((206, 356, 382, 504), 'x', 'post-MVP', 'tr'),
 ((372, 522, 382, 504), 'd', 'pausa y reanuda', 'tr'),
 ((538, 688, 382, 504), 'p', 'hechos sí · sin RAG', 'br'),
 ((704, 904, 382, 504), 'p', 'serializa · 2.º run sobra', 'tl'),
 ((934, 1130, 382, 504), 'd', 'sin probar real', 'tr'),
 # capa 4 (bloques chicos)
 ((206, 366, 560, 614), 'p', 'sin API · duplica', 'tr'),
 ((381, 541, 560, 614), 'd', None, 'tr'),
 ((556, 716, 560, 614), 'p', 'motor sí · sin API', 'tr'),
 ((800, 957, 560, 614), 'p', 'servicio sin cablear', 'tr'),
 ((973, 1130, 560, 614), 'p', 'servicio sin cablear', 'tr'),
 ((206, 366, 628, 682), 'd', None, 'tr'),
 ((381, 541, 628, 682), 'p', 'sin worker ni API', 'tr'),
 ((556, 716, 628, 682), 'p', 'sin worker ni API', 'tr'),
 ((800, 957, 628, 682), 'x', None, 'tr'),
 ((973, 1130, 628, 682), 'x', 'solo tablas', 'tr'),
 # capa 5
 ((206, 356, 738, 880), 'd', None, 'tr'),
 ((376, 528, 738, 880), 'x', 'post-MVP', 'tr'),
 ((548, 700, 738, 880), 'p', 'sin triggers', 'bl'),
 ((780, 1130, 738, 880), 'p', 'falta Email e Instagram', 'tr'),
 # capa 6
 ((206, 900, 936, 1028), 'p', 'faltan 5 colas de dominio', 'tl'),
 ((920, 1130, 936, 1028), 'd', 'reconexión probada', 'tr'),
 # capa 7
 ((206, 660, 1084, 1152), 'd', 'tablas RAG sin uso', 'tl'),
 ((680, 900, 1084, 1152), 'p', 'solo sesión Baileys cifrada', 'tr'),
 ((920, 1130, 1084, 1152), 'x', 'solo documentado', 'tr'),
 # capa 8
 ((206, 1130, 1208, 1284), 'd', 'no probado aquí (sin Docker)', 'tr'),
 # externos
 ((1176, 1364, 398, 488), 'd', 'sin probar real', 'br'),
 ((1176, 1364, 512, 702), 'd', 'sin probar real', 'br'),
 ((1176, 1364, 752, 872), 'p', 'Cloud: hasta el 401 de Meta', 'br'),
]
for (x0, x1, y0, y1), st, lab, pos in TAGS:
    status_tag(x0, x1, y0, y1, st, lab, pos)

# ---------- Leyenda ----------
lx, ly = 1166, 922
add(f'<rect x="{lx}" y="{ly}" width="208" height="376" rx="14" fill="#FFFFFF" stroke="#E2E8F0" filter="url(#sh)"/>')
text(lx + 16, ly + 26, 'LEYENDA', 10.5, 700, '#64748B', extra='letter-spacing="0.8"')
yy = ly + 50
def leg_flow(color, title, steps, letters):
    global yy
    add(f'<line x1="{lx+16}" y1="{yy-4}" x2="{lx+40}" y2="{yy-4}" stroke="{color}" stroke-width="2.4"/>')
    text(lx + 48, yy, title, 11, 700, INK); yy += 18
    for lab, s in zip(letters, steps):
        add(f'<circle cx="{lx+24}" cy="{yy-4}" r="7.5" fill="{color}"/>')
        text(lx + 24, yy - 0.8, lab, 9, 750, '#FFFFFF', 'middle')
        text(lx + 38, yy, s, 10, 450, MUTED); yy += 16
    yy += 8
leg_flow(F1, 'WhatsApp entrante', ['Llega por socket o webhook', 'Se encola channel.inbound', 'Worker inicia el run', 'Tool calling con el LLM', 'Respuesta vía outbox', 'Envío al contacto'], '123456')
leg_flow(F2, 'Chat desde la UI', ['POST /v1/chats/:id/messages', 'Encola run.process', 'Worker inicia el run', 'Eventos message.delta', 'Streaming SSE o WS'], 'ABCDE')
add(f'<line x1="{lx+16}" y1="{yy-4}" x2="{lx+40}" y2="{yy-4}" stroke="{G}" stroke-width="1.6"/>')
text(lx + 48, yy, 'Dependencia', 10, 450, MUTED); yy += 17
add(f'<line x1="{lx+16}" y1="{yy-4}" x2="{lx+40}" y2="{yy-4}" stroke="{G}" stroke-width="1.6" stroke-dasharray="5 4"/>')
text(lx + 48, yy, 'Post-MVP (enchufable)', 10, 450, MUTED)
yy += 26
add(f'<line x1="{lx+16}" y1="{yy-14}" x2="{lx+192}" y2="{yy-14}" stroke="#E2E8F0"/>')
for i, l in enumerate(wrap('Toda entidad lleva workspaceId: pasar a multitenant es un switch, no una reescritura.', 10, 176)):
    text(lx + 16, yy + 4 + i * 14, l, 10, 450, MUTED)

# ---------- Panel inferior: estado de implementación ----------
py0, py1 = 1322, H - 72
add(f'<rect x="24" y="{py0}" width="1532" height="{py1-py0}" rx="14" fill="#FFFFFF" stroke="#E2E8F0" filter="url(#sh)"/>')
add(f'<rect x="24" y="{py0}" width="6" height="{py1-py0}" rx="3" fill="#16A34A"/>')
text(46, py0 + 30, 'Estado de implementación · 21/11/2026 · everglow-agentes v2', 17, 750, INK)
text(46, py0 + 50, 'Verificado contra el código y con pruebas en vivo (Postgres 17 local, LLM simulado). Install, typecheck, lint, build, prisma validate y migraciones OK · 97 tests en verde (13 archivos).', 11, 450, MUTED)
add(f'<line x1="46" y1="{py0+64}" x2="1534" y2="{py0+64}" stroke="#E2E8F0"/>')

def col_block(x, w, title, items, color, bullet=True):
    yy2 = py0 + 88
    text(x, yy2, title, 11, 750, color, extra='letter-spacing="0.6"'); yy2 += 20
    for it in items:
        st = None
        if isinstance(it, tuple): st, it = it
        lines = wrap(it, 10.6, w - 18)
        if st: st_icon(x + 6, yy2 - 3.6, st, 5.6)
        elif bullet: add(f'<circle cx="{x+5}" cy="{yy2-3.6}" r="2.3" fill="{color}"/>')
        for j, l in enumerate(lines):
            text(x + 16, yy2 + j * 14.2, l, 10.6, 450, INK if j == 0 else INK)
        yy2 += len(lines) * 14.2 + 6
    return yy2

# leyenda de estados
x = 46
text(x, py0 + 88, 'LEYENDA', 11, 750, '#64748B', extra='letter-spacing="0.6"')
ly2 = py0 + 112
for st, t1, t2 in [('d', 'Hecho', 'implementado, cableado y verificado'), ('p', 'Parcial', 'existe pero falta una pieza (ver etiqueta)'), ('x', 'Pendiente', 'sin implementar o post-MVP')]:
    st_icon(x + 7, ly2 - 4, st, 7)
    text(x + 22, ly2, t1, 11, 700, INK); text(x + 22 + tw(t1, 11, 700) + 6, ly2, t2, 10.4, 450, MUTED)
    ly2 += 22
for j, l in enumerate(wrap('«sin probar real»: funciona contra servicios simulados o con credenciales falsas; falta probarlo con la cuenta real (Meta, Composio, proveedores de LLM).', 10.4, 270)):
    text(x, ly2 + 6 + j * 14, l, 10.4, 450, MUTED)
ly2 += 6 + 3 * 14 + 10
for j, l in enumerate(wrap('Dentro de los bloques: el punto a la izquierda de cada cola, canal o ítem transversal usa la misma escala.', 10.4, 270)):
    text(x, ly2 + j * 14, l, 10.4, 450, MUTED)

col_block(350, 400, 'FUNCIONA DE PUNTA A PUNTA (PROBADO EN VIVO)', [
  ('d', 'Chat por API (A→E): POST del mensaje, run.process, respuesta en streaming por SSE (CORS y ?ticket) y por WebSocket.'),
  ('d', 'WhatsApp Cloud entrante (1→5): webhook firmado (firma mala = 401, wamid repetido = 1 solo run), run con cara externa y outbox.'),
  ('p', 'Paso 6 (envío a Meta): queda FAILED con el 401 del token falso; sin probar real. Baileys solo con simulaciones.'),
  ('d', 'Aprobaciones: el run pausa en WAITING_APPROVAL y se reanuda al aprobar, tanto en el chat como en WhatsApp.'),
  ('d', 'Bus: si se corta el LISTEN, reconecta en ~1 s y el cliente SSE no pierde eventos.'),
], '#16A34A')

col_block(782, 360, 'SIGUIENTE', [
  'Rutas de inbox, takeover y contactos (hoy no hay forma de sacar una conversación de HANDOFF por API).',
  'Cablear leads, agenda, rutinas y secuencias: rutas, workers de cola y tests.',
  'Memoria con RAG sobre knowledge_chunk · plantillas por rubro.',
  'Métricas (prom-client está instalado pero sin uso) y costUsd por run.',
  'Probar con Meta, Composio y LLM reales; levantar el compose con Docker.',
], '#2563EB')

col_block(1174, 360, 'HALLAZGOS QUE SIGUEN ABIERTOS', [
  ('p', 'H1 (alto), parcial: ya no hay runs en paralelo, pero con 2 mensajes seguidos el 2.º run vuelve a contestar (respuesta duplicada).'),
  ('x', 'Nuevo (medio): 2 mensajes a la vez de un número nuevo crean 2 contactos (sin índice único).'),
  ('x', 'Nuevo (medio): handoff.request deja la conversación en HANDOFF sin salida por API.'),
  ('x', 'M9 pendiente · M7 parcial (la guarda multitenant no cubre todos los servicios).'),
  ('d', 'C1 y H2 a H6 cerrados (C1, H6 y CORS de SSE verificados en vivo).'),
], '#B91C1C')

# ---------- Pie ----------
add(f'<line x1="24" y1="{H-54}" x2="1556" y2="{H-54}" stroke="#E2E8F0"/>')
text(24, H - 28, 'docs-v3 · versión 1.2 · 21/11/2026', 11, 500, MUTED)
text(1556, H - 28, 'TypeScript · Fastify · Prisma 7 · PostgreSQL + pgvector · pg-boss 12 · Vercel AI SDK · Composio · Baileys / Cloud API', 11, 450, MUTED, 'end')
add('</svg>')
open('/workspace/plataforma-agentes/docs-v3/diagramas/arquitectura.svg', 'w').write('\n'.join(out))
print('ok')
