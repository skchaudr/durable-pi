// dpi entry id -> Prime entry id for `fork`. dpi ids are positions in the agent's transcript; Prime's are strings in the
// session file, so an entry maps only when the active branch's messages line up one-to-one with the transcript.
import type { WireEntry } from "../../../dpi-sdk/src/api.js";
import { invalid } from "../errors.js";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const KIND: Record<string, string> = { user: "pi.user", assistant: "pi.assistant", toolResult: "pi.tool-result" };
const KINDS = new Set(Object.values(KIND));

/** `tree` is the `get_session_tree` response, `entries` the agent's snapshot entries. Throws a 400 when there is no fork point. */
export function forkPoint(tree: J, entries: readonly WireEntry[], entryId: number): string {
  const byId = new Map<string, J>((tree?.flatNodes ?? []).map((n: J) => [n.entry?.id, n.entry]));
  const branch: J[] = [];
  for (let e = byId.get(tree?.leafId); e; e = byId.get(e.parentId)) branch.unshift(e);
  const prime = branch.filter((e) => e.type === "message" && e.message?.role in KIND);
  const mine = entries.filter((e) => KINDS.has(e.kind));
  const at = mine.findIndex((e) => e.id === entryId);
  if (at < 0) throw invalid(`Entry ${entryId} is not a user, assistant or tool result entry of this agent`);
  if (prime.length !== mine.length || prime.some((e, i) => KIND[e.message.role] !== mine[i].kind))
    throw invalid(`Prime has no fork point for entry ${entryId}: the session file's messages do not match the transcript (compacted or branched)`);
  return prime[at].id;
}
