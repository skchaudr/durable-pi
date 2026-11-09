// Continue-and-mark for codemode scripts. A replay-unsafe nested call (bash) that a restart catches in flight settles
// as an error whose text says it was interrupted, so the script's `await tools.bash(...)` would reject and, without a
// try/catch, end the whole script. The host rewrites every model-issued script so such a rejection RESOLVES with
// `{ interrupted: true, output, error }` instead and the script goes on; every other rejection is unchanged. The
// rewrite is applied in `beforeTool`, so it lands in the task checkpoint and a replay runs the same code.
import { CODEMODE_OPTIONS_PREFIX } from "@earendil-works/pi-codemode/source";

/** The text pi-durable gives a nested call that a restart interrupted (tool.js: `execute` recovery and `abort`). */
export const INTERRUPTED_CALL = /was interrupted( by a restart)? and may have partially run/;

/** Marks a script the host already rewrote, so a hook that runs twice (a rerun from the `call` phase) wraps once. */
const MARKER = "/*dpi-prelude*/";

/**
 * One line, no newline: the user's first line shares it, so line numbers in error stacks are the user's. `tools` is
 * the sandbox's guarded proxy (a parameter of the wrapper pi-codemode generates); the inner function shadows it with
 * a proxy whose function members resolve an interrupted rejection as a value. The proxy's target is a fresh object,
 * not `tools`: that one is frozen, and a proxy over a frozen object must report its values unchanged. Unknown members
 * still throw the sandbox's "does not exist" error, since the read reaches the sandbox proxy's own trap.
 */
const PRELUDE =
  `${MARKER}const __dpiInt=/${INTERRUPTED_CALL.source}/,__dpiT=tools,` +
  `__dpiTools=new Proxy({},{has(_,k){return k in __dpiT},ownKeys(){return Reflect.ownKeys(__dpiT)},` +
  `getOwnPropertyDescriptor(_,k){const d=Reflect.getOwnPropertyDescriptor(__dpiT,k);return d&&{...d,configurable:true}},` +
  `get(_,k){const v=__dpiT[k];if(typeof v!=="function")return v;` +
  `return function(...a){const p=v.apply(__dpiT,a);if(!p||typeof p.then!=="function")return p;` +
  `return p.then(undefined,(e)=>{const m=e&&typeof e.message==="string"?e.message:String(e);` +
  `if(__dpiInt.test(m))return{interrupted:true,output:m,error:m};throw e;});};}});` +
  `return await (async (tools) => {`;

const EPILOGUE = `\n})(__dpiTools);`;

export const isWrapped = (code: string) => code.includes(MARKER);

/**
 * The script with the host prelude. An `// @options:` first line stays first, followed by a newline as before, so
 * pi-codemode's `parseCodemodeSource` still finds it and the code it strips keeps its leading newline.
 */
export function wrapScript(code: string): string {
  if (isWrapped(code)) return code;
  const newline = code.indexOf("\n");
  const firstLine = (newline === -1 ? code : code.slice(0, newline)).replace(/\r$/, "");
  if (firstLine.trimStart().startsWith(CODEMODE_OPTIONS_PREFIX) && newline !== -1)
    return `${code.slice(0, newline)}\n${PRELUDE}${code.slice(newline + 1)}${EPILOGUE}`;
  return `${PRELUDE}${code}${EPILOGUE}`;
}

type CallRow = { id: number; name: string; args?: string; status?: string; error?: string };

/** The result's `details.calls` rows a restart interrupted, so the agent learns of them even when the script did not say. */
export function interruptedCalls(details: unknown): CallRow[] {
  const calls = (details as { calls?: unknown } | undefined)?.calls;
  if (!Array.isArray(calls)) return [];
  return (calls as CallRow[]).filter((row) => typeof row?.error === "string" && INTERRUPTED_CALL.test(row.error));
}

export function interruptedTrailer(rows: CallRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((row) => `c${row.id} ${row.name} ${row.args ?? ""}`.trimEnd());
  return `\n\n${rows.length} call(s) were interrupted by a restart and resolved as { interrupted: true }; they may have partially run and were not re-run: ${lines.join("\n")}`;
}
