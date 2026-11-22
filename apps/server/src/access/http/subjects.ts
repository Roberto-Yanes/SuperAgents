import type { AppContext } from "../../container.js";
import { UUID_RE } from "../../shared/validation.js";

/** Subjects del bus a los que un cliente puede suscribirse (WS, GET /v1/events). Id siempre UUID estricto (C1). */
export const SUBJECT = new RegExp(`^(run|conversation|connection|task):(${UUID_RE.source.slice(1, -1)})$`, "i");
export type SubjectKind = "run" | "conversation" | "connection" | "task";

export function parseSubject(subject: string): { kind: SubjectKind; id: string; normalized: string } | null {
  const m = SUBJECT.exec(subject);
  if (!m) return null;
  const kind = m[1]!.toLowerCase() as SubjectKind;
  const id = m[2]!.toLowerCase();
  return { kind, id, normalized: `${kind}:${id}` };
}

export type SubjectDeps = Pick<AppContext, "runQueries" | "conversations" | "connections" | "tasks">;

/** El recurso del subject pertenece al workspace del principal. */
export async function subjectBelongsTo(deps: SubjectDeps, workspaceId: string, kind: SubjectKind, id: string): Promise<boolean> {
  if (kind === "run") return deps.runQueries.exists(workspaceId, id);
  if (kind === "conversation") return deps.conversations.exists(workspaceId, id);
  if (kind === "task") return deps.tasks.exists(workspaceId, id);
  return deps.connections.get(workspaceId, id).then(
    () => true,
    () => false,
  );
}
