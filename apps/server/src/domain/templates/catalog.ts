import type { SequenceStep } from "../sequences/service.js";

/**
 * Plantillas por rubro: punto de partida de un agente para un tipo de negocio (ADR 003: semilla, no flujo).
 * Aplicar una plantilla crea el agente, el embudo, el calendario, la secuencia de seguimiento y rutinas
 * (desactivadas). El agente sigue decidiendo el orden; nada de esto es un guion obligatorio.
 */
export interface SectorTemplate {
  id: string;
  name: string;
  sector: string;
  description: string;
  agent: { name: string; instructions: string; tools: string[]; external: string[] };
  pipeline: Array<{ name: string; kind: "OPEN" | "WON" | "LOST" }>;
  calendar?: {
    name: string;
    slotMinutes: number;
    hours: Partial<Record<"1" | "2" | "3" | "4" | "5" | "6" | "7", Array<[string, string]>>>;
    reminderMinutes: number;
  };
  sequence?: { name: string; steps: SequenceStep[] };
  routines: Array<{ name: string; cron: string; instruction: string }>;
  /** Qué tiene que cargar el negocio para que el agente funcione bien. */
  checklist: string[];
}

const COMMON_RULES = `Reglas de trabajo:
- Antes de dar precios, horarios o condiciones, búscalos con kb.search. Si no están, dilo y ofrece que una persona lo confirme.
- Guarda con memory.save los datos útiles del contacto (preferencias, servicio de interés), nunca datos de salud o bancarios.
- Si el contacto pide una persona, se queja o el caso se sale de lo habitual, usa handoff.request.
- Respuestas breves, cercanas y en el idioma del contacto.`;

const WEEKDAYS_9_20: SectorTemplate["calendar"] = {
  name: "Agenda principal",
  slotMinutes: 30,
  hours: {
    "1": [
      ["09:00", "14:00"],
      ["16:00", "20:00"],
    ],
    "2": [
      ["09:00", "14:00"],
      ["16:00", "20:00"],
    ],
    "3": [
      ["09:00", "14:00"],
      ["16:00", "20:00"],
    ],
    "4": [
      ["09:00", "14:00"],
      ["16:00", "20:00"],
    ],
    "5": [["09:00", "14:00"]],
  },
  reminderMinutes: 1440,
};

const BASE_TOOLS = ["kb.search", "memory.save", "memory.recall", "handoff.request", "contact.update", "lead.create"];

export const TEMPLATES: SectorTemplate[] = [
  {
    id: "clinica-dental",
    name: "Clínica dental",
    sector: "salud",
    description: "Recepción por WhatsApp: resuelve dudas, da cita y hace seguimiento de presupuestos.",
    agent: {
      name: "Recepción clínica",
      instructions: `Eres la recepción de una clínica dental. Atiendes a pacientes y personas interesadas: resuelves dudas sobre tratamientos, precios y horarios, y das cita.
- Para citas: pregunta el motivo, busca huecos con agenda.slots y reserva con agenda.book cuando el paciente confirme.
- Urgencias (dolor fuerte, sangrado, traumatismo): ofrece el primer hueco disponible y avisa al equipo con handoff.request.
- No das diagnósticos ni recomiendas medicación.
${COMMON_RULES}`,
      tools: [...BASE_TOOLS, "agenda.slots", "agenda.book"],
      external: [],
    },
    pipeline: [
      { name: "Consulta", kind: "OPEN" },
      { name: "Primera visita", kind: "OPEN" },
      { name: "Presupuesto enviado", kind: "OPEN" },
      { name: "Tratamiento aceptado", kind: "WON" },
      { name: "No sigue", kind: "LOST" },
    ],
    calendar: WEEKDAYS_9_20,
    sequence: {
      name: "Seguimiento de presupuesto",
      steps: [
        {
          kind: "agent",
          delayMinutes: 2 * 24 * 60,
          instruction: "Pregunta con amabilidad si tiene dudas sobre el presupuesto que le dimos y ofrece resolverlas.",
        },
        {
          kind: "agent",
          delayMinutes: 7 * 24 * 60,
          instruction: "Último recordatorio del presupuesto: ofrece una llamada con el equipo o una cita para revisarlo. Sin insistir más.",
        },
      ],
    },
    routines: [
      {
        name: "Resumen diario de citas",
        cron: "0 8 * * 1-5",
        instruction: "Resume las citas de hoy y los presupuestos pendientes de respuesta para el equipo.",
      },
    ],
    checklist: [
      "Sube a la base de conocimiento tarifas, tratamientos, horarios, dirección y formas de pago.",
      "Conecta WhatsApp (Cloud API o Baileys) y asígnalo a este agente.",
      "Revisa los horarios del calendario.",
    ],
  },
  {
    id: "estetica",
    name: "Centro de estética",
    sector: "belleza",
    description: "Reservas de tratamientos, dudas de precios y recuperación de clientas.",
    agent: {
      name: "Recepción estética",
      instructions: `Eres la recepción de un centro de estética. Informas de tratamientos y precios, das cita y recuerdas las revisiones.
- Recomienda tratamientos solo a partir de lo que diga la base de conocimiento.
- Para reservar usa agenda.slots y agenda.book tras confirmar día y hora.
${COMMON_RULES}`,
      tools: [...BASE_TOOLS, "agenda.slots", "agenda.book"],
      external: [],
    },
    pipeline: [
      { name: "Interesada", kind: "OPEN" },
      { name: "Cita reservada", kind: "OPEN" },
      { name: "Clienta", kind: "WON" },
      { name: "Perdida", kind: "LOST" },
    ],
    calendar: { ...WEEKDAYS_9_20!, slotMinutes: 45 },
    sequence: {
      name: "Recuperar clientas",
      steps: [{ kind: "agent", delayMinutes: 45 * 24 * 60, instruction: "Saluda, pregunta qué tal le fue el último tratamiento y ofrece la próxima sesión." }],
    },
    routines: [],
    checklist: ["Sube la carta de tratamientos y precios.", "Configura el calendario con la duración real de cada servicio."],
  },
  {
    id: "inmobiliaria",
    name: "Inmobiliaria",
    sector: "inmobiliario",
    description: "Califica compradores e inquilinos, agenda visitas y hace seguimiento.",
    agent: {
      name: "Asesor inmobiliario",
      instructions: `Eres el primer contacto de una inmobiliaria. Calificas a cada interesado: compra o alquiler, zona, presupuesto, plazo y si necesita financiación.
- Crea o actualiza el lead con lead.create y guarda sus criterios con memory.save.
- Informa solo de inmuebles que aparezcan en la base de conocimiento; no inventes disponibilidad.
- Propón visita con agenda.slots y agenda.book cuando el interés sea real.
${COMMON_RULES}`,
      tools: [...BASE_TOOLS, "agenda.slots", "agenda.book"],
      external: [],
    },
    pipeline: [
      { name: "Nuevo", kind: "OPEN" },
      { name: "Calificado", kind: "OPEN" },
      { name: "Visita", kind: "OPEN" },
      { name: "Oferta", kind: "OPEN" },
      { name: "Cerrado", kind: "WON" },
      { name: "Descartado", kind: "LOST" },
    ],
    calendar: { ...WEEKDAYS_9_20!, name: "Visitas", slotMinutes: 60 },
    sequence: {
      name: "Seguimiento tras visita",
      steps: [
        { kind: "agent", delayMinutes: 24 * 60, instruction: "Pregunta qué le pareció la visita y si quiere ver otras opciones parecidas." },
        {
          kind: "agent",
          delayMinutes: 5 * 24 * 60,
          instruction: "Comparte que hay novedades en su zona si las hay en la base de conocimiento; si no, pregunta si sigue buscando.",
        },
      ],
    },
    routines: [
      {
        name: "Leads sin respuesta",
        cron: "0 9 * * 1-5",
        instruction: "Revisa los leads calificados sin actividad en 3 días y prepara un borrador de seguimiento para cada uno.",
      },
    ],
    checklist: ["Sube el listado de inmuebles (precio, zona, características) a la base de conocimiento.", "Revisa las etapas del embudo."],
  },
  {
    id: "gestoria",
    name: "Gestoría / asesoría",
    sector: "servicios profesionales",
    description: "Atiende consultas, recoge documentación pendiente y recuerda plazos.",
    agent: {
      name: "Asistente de gestoría",
      instructions: `Eres el asistente de una gestoría. Atiendes consultas de clientes sobre trámites, documentación y plazos.
- Responde con la información de la base de conocimiento; para casos concretos de impuestos o laboral, deriva al gestor con handoff.request.
- Nunca pidas contraseñas ni datos bancarios completos por chat.
${COMMON_RULES}`,
      tools: BASE_TOOLS,
      external: [],
    },
    pipeline: [
      { name: "Consulta", kind: "OPEN" },
      { name: "Propuesta", kind: "OPEN" },
      { name: "Cliente", kind: "WON" },
      { name: "No contrata", kind: "LOST" },
    ],
    sequence: {
      name: "Documentación pendiente",
      steps: [
        { kind: "agent", delayMinutes: 3 * 24 * 60, instruction: "Recuerda la documentación pendiente para su trámite y ofrece ayuda para enviarla." },
        { kind: "agent", delayMinutes: 7 * 24 * 60, instruction: "Último recordatorio de la documentación; avisa de que el gestor le llamará si no llega." },
      ],
    },
    routines: [
      {
        name: "Plazos del mes",
        cron: "0 9 1 * *",
        instruction: "Prepara para el equipo un resumen de los plazos fiscales del mes según la base de conocimiento.",
      },
    ],
    checklist: ["Sube el calendario fiscal y la lista de documentos por trámite.", "Define qué consultas deben ir siempre al gestor."],
  },
  {
    id: "restaurante",
    name: "Restaurante",
    sector: "hostelería",
    description: "Reservas de mesa, carta, alérgenos y eventos.",
    agent: {
      name: "Reservas restaurante",
      instructions: `Atiendes las reservas y dudas de un restaurante: carta, horarios, alérgenos, grupos y eventos.
- Para reservar pide fecha, hora, número de personas y nombre; usa agenda.slots y agenda.book.
- Sobre alérgenos responde solo con lo que diga la base de conocimiento y recomienda avisar en sala.
- Grupos de más de 10 o eventos: recoge los datos y deriva con handoff.request.
${COMMON_RULES}`,
      tools: [...BASE_TOOLS, "agenda.slots", "agenda.book"],
      external: [],
    },
    pipeline: [
      { name: "Consulta", kind: "OPEN" },
      { name: "Reserva", kind: "WON" },
      { name: "Sin reserva", kind: "LOST" },
    ],
    calendar: {
      name: "Mesas",
      slotMinutes: 30,
      hours: {
        "2": [
          ["13:00", "16:00"],
          ["20:00", "23:00"],
        ],
        "3": [
          ["13:00", "16:00"],
          ["20:00", "23:00"],
        ],
        "4": [
          ["13:00", "16:00"],
          ["20:00", "23:00"],
        ],
        "5": [
          ["13:00", "16:00"],
          ["20:00", "23:30"],
        ],
        "6": [
          ["13:00", "16:30"],
          ["20:00", "23:30"],
        ],
        "7": [["13:00", "16:30"]],
      },
      reminderMinutes: 240,
    },
    routines: [],
    checklist: ["Sube la carta con precios y alérgenos.", "Ajusta el horario de servicio del calendario."],
  },
  {
    id: "taller-sat",
    name: "Taller / servicio técnico",
    sector: "servicios técnicos",
    description: "Recoge averías, da cita de revisión y avisa del estado de las reparaciones.",
    agent: {
      name: "Atención taller",
      instructions: `Eres la atención al cliente de un taller / servicio técnico. Recoges la avería (equipo o vehículo, síntomas, desde cuándo), das cita y orientas sobre plazos.
- No des presupuestos cerrados sin diagnóstico: ofrece la revisión.
- Crea el lead con el resumen de la avería y propón cita con agenda.slots y agenda.book.
${COMMON_RULES}`,
      tools: [...BASE_TOOLS, "agenda.slots", "agenda.book"],
      external: [],
    },
    pipeline: [
      { name: "Aviso", kind: "OPEN" },
      { name: "Diagnóstico", kind: "OPEN" },
      { name: "Presupuesto", kind: "OPEN" },
      { name: "Reparado", kind: "WON" },
      { name: "No repara", kind: "LOST" },
    ],
    calendar: { ...WEEKDAYS_9_20!, name: "Revisiones", slotMinutes: 60 },
    sequence: {
      name: "Presupuesto sin respuesta",
      steps: [{ kind: "agent", delayMinutes: 2 * 24 * 60, instruction: "Pregunta si quiere seguir con la reparación presupuestada o si tiene dudas." }],
    },
    routines: [],
    checklist: [
      "Sube tarifas de revisión, plazos habituales y garantías.",
      "Conecta el ERP (p. ej. Odoo por Composio) si quieres que el agente consulte el estado de las órdenes.",
    ],
  },
];

export function findTemplate(id: string): SectorTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
