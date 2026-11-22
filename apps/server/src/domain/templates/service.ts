import type { Db } from "../../data/db.js";
import { audit, type Actor } from "../../data/audit.js";
import { invalid, notFound } from "../../shared/errors.js";
import type { AgendaService } from "../agenda/service.js";
import type { AgentService } from "../agents/service.js";
import type { LeadService } from "../leads/service.js";
import type { RoutineService } from "../routines/service.js";
import type { SequenceService } from "../sequences/service.js";
import { findTemplate, TEMPLATES, type SectorTemplate } from "./catalog.js";

export interface ApplyResult {
  templateId: string;
  agentId: string;
  calendarId: string | null;
  sequenceId: string | null;
  routineIds: string[];
  pipelineApplied: boolean;
  warnings: string[];
  checklist: string[];
}

/**
 * Aplicar una plantilla por rubro. El agente se crea siempre; el resto es opcional y no pisa lo que el negocio ya
 * tenga: el embudo solo se reemplaza si no tiene leads, y las rutinas se crean desactivadas.
 */
export class TemplateService {
  constructor(
    private readonly d: {
      db: Db;
      agents: Pick<AgentService, "create">;
      leads: Pick<LeadService, "setStages">;
      agenda: Pick<AgendaService, "createCalendar">;
      sequences: Pick<SequenceService, "create">;
      routines: Pick<RoutineService, "create">;
    },
  ) {}

  list(): Array<Pick<SectorTemplate, "id" | "name" | "sector" | "description"> & { tools: string[]; hasCalendar: boolean; hasSequence: boolean }> {
    return TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      sector: t.sector,
      description: t.description,
      tools: t.agent.tools,
      hasCalendar: Boolean(t.calendar),
      hasSequence: Boolean(t.sequence),
    }));
  }

  get(id: string): SectorTemplate {
    const t = findTemplate(id);
    if (!t) throw notFound("Plantilla");
    return t;
  }

  async apply(
    workspaceId: string,
    id: string,
    opts: { model: string; agentName?: string; calendar?: boolean; pipeline?: boolean; sequence?: boolean; routines?: boolean },
    actor: Actor,
  ): Promise<ApplyResult> {
    const t = this.get(id);
    if (!/^[\w.-]+:.+$/.test(opts.model)) throw invalid("invalid_model", "Modelo inválido. Formato: conexión:modelo");
    const ws = await this.d.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { timezone: true } });
    const warnings: string[] = [];

    const agent = await this.d.agents.create(
      workspaceId,
      {
        name: opts.agentName ?? t.agent.name,
        instructions: t.agent.instructions,
        model: opts.model,
        tools: t.agent.tools,
        approvals: {},
        external: t.agent.external,
        settings: {},
      },
      actor,
    );

    let pipelineApplied = false;
    if (opts.pipeline !== false) {
      try {
        await this.d.leads.setStages(workspaceId, t.pipeline);
        pipelineApplied = true;
      } catch (err) {
        warnings.push(`El embudo no se cambió: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let calendarId: string | null = null;
    if (t.calendar && opts.calendar !== false) {
      const cal = await this.d.agenda.createCalendar(
        workspaceId,
        {
          name: t.calendar.name,
          timezone: ws.timezone,
          slotMinutes: t.calendar.slotMinutes,
          bufferMinutes: 0,
          minNoticeMinutes: 60,
          maxDaysAhead: 30,
          hours: t.calendar.hours,
          reminderMinutes: t.calendar.reminderMinutes,
        },
        actor,
      );
      calendarId = cal.id;
    }

    let sequenceId: string | null = null;
    if (t.sequence && opts.sequence !== false) {
      const seq = await this.d.sequences.create(workspaceId, { name: t.sequence.name, steps: t.sequence.steps, stopOnReply: true, active: true }, actor);
      sequenceId = seq.id;
    }

    const routineIds: string[] = [];
    if (opts.routines !== false) {
      for (const r of t.routines) {
        const routine = await this.d.routines.create(
          workspaceId,
          { agentId: agent.id, name: r.name, cron: r.cron, instruction: r.instruction, enabled: false },
          actor,
        );
        routineIds.push(routine.id);
      }
      if (t.routines.length) warnings.push("Las rutinas se crearon desactivadas: actívalas cuando las revises.");
    }

    await audit(this.d.db, {
      workspaceId,
      actor,
      action: "template.applied",
      target: `agent:${agent.id}`,
      data: { templateId: t.id, calendarId, sequenceId, routines: routineIds.length },
    });
    return { templateId: t.id, agentId: agent.id, calendarId, sequenceId, routineIds, pipelineApplied, warnings, checklist: t.checklist };
  }
}
