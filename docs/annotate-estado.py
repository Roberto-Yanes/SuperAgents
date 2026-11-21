from PIL import Image, ImageDraw, ImageFont
SRC = "/mnt/user-data/uploads/1333f9da-image.png"
OUT = "/home/claude/annot/arquitectura-v3-estado.png"
S = 3200 / 2072  # coordenadas medidas sobre la vista de 2072 px de ancho

FONT_B = "/usr/share/fonts/opentype/inter/Inter-Bold.otf"
FONT_M = "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf"
FONT_SYM = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
GREEN, AMBER, RED = (22, 163, 74), (217, 119, 6), (220, 38, 38)
STYLE = {"done": (GREEN, "✓"), "partial": (AMBER, "◐"), "todo": (RED, "✕")}

base = Image.open(SRC).convert("RGBA")
W, H = base.size
EXTRA = 380
canvas = Image.new("RGBA", (W, H + EXTRA), (244, 246, 250, 255))
canvas.paste(base, (0, 0))
over = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
d = ImageDraw.Draw(over)
fb = lambda s: ImageFont.truetype(FONT_B, s)
fm = lambda s: ImageFont.truetype(FONT_M, s)
fs = lambda s: ImageFont.truetype(FONT_SYM, s)

def box(x1, y1, x2, y2, state, note=None, badge=True, width=6, radius=16):
    color, sym = STYLE[state]
    X1, Y1, X2, Y2 = [round(v * S) for v in (x1, y1, x2, y2)]
    d.rounded_rectangle((X1 - 4, Y1 - 4, X2 + 4, Y2 + 4), radius=radius, outline=color + (255,), width=width)
    if badge:
        r = 26
        cx, cy = X2 - 6, Y1 - 4
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color + (255,), outline=(255, 255, 255, 255), width=4)
        f = fs(28)
        d.text((cx, cy + 1), sym, font=f, fill=(255, 255, 255, 255), anchor="mm")
    if note:
        f = fm(22)
        tw = d.textlength(note, font=f)
        px, py = X2 - tw - 30, Y2 + 4 - 17
        d.rounded_rectangle((px - 10, py - 6, px + tw + 10, py + 28), radius=10, fill=color + (235,))
        d.text((px, py + 11), note, font=f, fill=(255, 255, 255, 255), anchor="lm")

def chip(x1, y1, x2, y2, state):
    color, sym = STYLE[state]
    X1, Y1, X2, Y2 = [round(v * S) for v in (x1, y1, x2, y2)]
    d.rounded_rectangle((X1 - 3, Y1 - 3, X2 + 3, Y2 + 3), radius=10, outline=color + (255,), width=5)
    r = 15
    cx, cy = X2 - 2, Y1 - 2
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color + (255,), outline=(255, 255, 255, 255), width=3)
    d.text((cx, cy + 1), sym, font=fs(17), fill=(255, 255, 255, 255), anchor="mm")

# 01 Clientes
box(267, 173, 759, 262, "todo", "Proyecto aparte · SDK listo")
box(811, 173, 1137, 262, "done")
box(1163, 173, 1463, 262, "partial", "Chat y aprobaciones · falta inbox")
# 02 Acceso / API
box(267, 334, 759, 422, "done")
box(811, 334, 1137, 422, "done")
box(1163, 334, 1463, 422, "done")
# 03 Orquestación
box(267, 494, 461, 652, "todo", "Post-MVP")
box(482, 494, 676, 652, "done")
box(697, 494, 891, 652, "partial", "Hechos · falta RAG")
box(912, 494, 1170, 652, "done")
box(1210, 494, 1463, 652, "done")
# 04 Dominio
box(267, 725, 473, 795, "partial", "Por canal · sin API")
box(494, 725, 700, 795, "done")
box(720, 725, 927, 795, "partial", "Motor sí · sin API")
box(1036, 725, 1239, 795, "todo")
box(1260, 725, 1463, 795, "todo")
box(267, 813, 473, 883, "done")
box(494, 813, 700, 883, "partial", "Modelo · sin worker")
box(720, 813, 927, 883, "todo")
box(1036, 813, 1239, 883, "todo")
box(1260, 813, 1463, 883, "todo")
# 05 Integraciones
box(267, 955, 461, 1140, "done")
box(487, 955, 683, 1140, "todo", "Post-MVP")
box(709, 955, 906, 1140, "done", "Sin triggers aún")
box(1011, 955, 1463, 1140, "partial", badge=True)
chip(1028, 1036, 1232, 1065, "done")
chip(1240, 1036, 1445, 1065, "done")
chip(1028, 1072, 1232, 1101, "todo")
chip(1240, 1072, 1445, 1101, "todo")
# Servicios externos
box(1522, 515, 1766, 632, "done", "Integrado · sin probar real")
box(1522, 663, 1766, 908, "done", "Integrado · sin probar real")
box(1522, 974, 1766, 1130, "done", "Integrado · sin probar real")
# 06 Ejecución
box(267, 1212, 1165, 1332, "done", badge=True)
cols = [(285, 494), (503, 712), (720, 929), (937, 1146)]
row1 = ["done", "done", "done", "todo"]  # channel.inbound, run.execute, run.resume, sequence.step
row2 = ["todo", "todo", "todo", "todo"]  # routine.cron, crm.sync, integration.event, appointment.reminder
for (a, b), st in zip(cols, row1):
    chip(a, 1270, b, 1297, st)
for (a, b), st in zip(cols, row2):
    chip(a, 1306, b, 1333, st)
box(1191, 1212, 1463, 1332, "done")
# 07 Datos
box(267, 1404, 855, 1492, "done", "pgvector activo · sin tablas RAG")
box(880, 1404, 1165, 1492, "partial", "Disco · sin S3 ni cifrado")
box(1191, 1404, 1463, 1492, "todo", "Documentado")
# 08 Infraestructura
box(267, 1566, 1463, 1662, "done", badge=False)
for a, b in [(668, 855), (867, 1054), (1067, 1253), (1266, 1453)]:
    chip(a, 1580, b, 1646, "done")
# Observabilidad (Logs, Auditoría, Métricas, Costos, Health, Tokens)
pills_y = [(399, 427), (438, 466), (477, 505), (516, 544), (555, 583), (594, 622)]
for (a, b), st in zip(pills_y, ["done", "done", "todo", "partial", "done", "done"]):
    chip(1811, a, 1889, b, st)
# Seguridad (Vault, Claves, Caras, Firmas, TLS, Rate limit)
for (a, b), st in zip(pills_y, ["partial", "done", "done", "partial", "done", "done"]):
    chip(1928, a, 2006, b, st)

# Leyenda y resumen (franja inferior)
y0 = H + 30
d.rounded_rectangle((48, y0, W - 48, H + EXTRA - 30), radius=24, fill=(255, 255, 255, 255), outline=(203, 213, 225, 255), width=3)
d.text((90, y0 + 50), "Estado de implementación · 21/11/2026 · everglow-agentes v2 (46 tests en verde)", font=fb(40), fill=(15, 23, 42, 255), anchor="lm")
lx = 90
for state, label in [("done", "Hecho"), ("partial", "Parcial"), ("todo", "Pendiente")]:
    color, sym = STYLE[state]
    d.ellipse((lx, y0 + 105, lx + 48, y0 + 153), fill=color + (255,))
    d.text((lx + 24, y0 + 130), sym, font=fs(26), fill=(255, 255, 255, 255), anchor="mm")
    d.text((lx + 64, y0 + 129), label, font=fb(30), fill=(15, 23, 42, 255), anchor="lm")
    lx += 64 + d.textlength(label, font=fb(30)) + 70
lines = [
    "Flujos completos de punta a punta: chat desde la UI (A→E) y WhatsApp entrante (1→6), con aprobaciones que pausan y reanudan el run.",
    "Siguiente: inbox y takeover por API · agenda y turnos · leads y embudo · secuencias y rutinas · memoria con RAG · plantillas por rubro · métricas y costes.",
    "«Sin probar real»: probado con simulaciones; falta validar con cuentas reales de Meta, Composio y proveedores LLM.",
]
for i, line in enumerate(lines):
    d.text((90, y0 + 195 + i * 38), line, font=fm(26), fill=(51, 65, 85, 255), anchor="lm")

Image.alpha_composite(canvas, over).convert("RGB").save(OUT, optimize=True)
print(OUT)
