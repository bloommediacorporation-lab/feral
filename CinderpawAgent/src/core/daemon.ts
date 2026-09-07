/**
 * daemon.ts — the answer said it wrote a file. The file is not there.
 *
 * `done_when` (cron/done-when.ts) already settled the principle: "completed" is
 * the agent's opinion, and where an assertion exists the world's opinion wins.
 * `core/unattended.ts:300` acts on it. But both of those need somebody to
 * DECLARE the assertion, and the only declarers are the cron API, the UI, and a
 * person who types `done_when:` into a chat message. Nobody types that. So on a
 * machine that was never set up, for the person sitting in front of the app, the
 * verification that exists protects nothing at all.
 *
 * This is the assertion nobody has to declare. It needs no configuration, no
 * project layout, no test runner, no key, and it works on the first turn of a
 * fresh install: if the answer says it created a file, the file has to be on
 * disk. Agents' Last Exam reports falsely declaring completion as the single
 * most common failure across every harness they measured, and it is a harness
 * failure rather than a model one, which is exactly why a harness can fix it.
 *
 * Deliberately narrow, on the same discipline as `unsourced.ts` — a warning
 * that cries wolf is a warning people switch off:
 *
 *  - only when the answer claims a WRITE ("am creat", "I wrote"). An answer that
 *    merely mentions a path is not a claim, and "I could not find src/x.ts" names
 *    a missing file honestly. Those must never fire.
 *  - only when the path's PARENT DIRECTORY exists. A relative path from a
 *    workspace this process cannot see resolves to nonsense, and accusing on
 *    nonsense is worse than staying quiet. Unknown location means no claim
 *    checked, the same rule the voice retention sweep follows.
 *  - never outside what we can resolve, and never a network path.
 *
 * It reports facts, not verdicts: which claimed files are absent. What to do
 * about it is the caller's decision.
 */

import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { claimedPaths } from "./unsourced.ts";

/**
 * Does the answer claim to have WRITTEN something, as opposed to mentioning it?
 *
 * Romanian and English, because the product answers in the user's language and a
 * gate that only understands English is a gate that is off for most people. The
 * Romanian perfect keeps its participle under negation ("nu am creat" contains
 * "am creat"), so `nu`/`n-` is excluded explicitly; English negation breaks the
 * pattern on its own. Offering to write ("pot crea", "I'll create") is not a
 * claim to have written and must not match.
 */
const WROTE = new RegExp(
  [
    String.raw`(?<!\bnu\s)(?<!\bn-)(?:\b|-)am\s+(?:creat|scris|salvat|generat|ad[aă]ugat|actualizat)`,
    String.raw`\b(?:creat|scris|salvat|generat)-(?:o|le|i)\b`,
    String.raw`\bI(?:'ve| have)? (?:created|written|wrote|saved|added|generated|updated)\b`,
    String.raw`\b(?:written|saved|created|added) (?:it )?(?:to|at|in)\b`,
  ].join("|"),
  "i",
);

export function claimsWrote(answer: string): boolean {
  return WROTE.test(answer);
}

/**
 * Every file the answer claims to have written that is not on disk.
 *
 * Empty when there is no write claim, when no path could be resolved, or when
 * every claimed file is present — all three are "nothing to contradict", and the
 * caller must treat them the same way.
 *
 * `cwd` is where relative paths resolve. It defaults to the process directory,
 * which is where the sidecar's own file tools land; a caller that knows the
 * workspace should pass it.
 */
export async function unkeptWriteClaims(answer: string, cwd: string = process.cwd()): Promise<string[]> {
  if (!claimsWrote(answer)) return [];
  const missing: string[] = [];
  for (const claimed of claimedPaths(answer)) {
    // A UNC or URL-ish path is not something to stat, and a drive we cannot see
    // is not evidence of anything.
    if (claimed.startsWith("\\\\") || claimed.startsWith("//")) continue;
    const full = isAbsolute(claimed) ? claimed : resolve(cwd, claimed);
    // ponytail: parent-exists is the whole anti-false-positive rule. If the
    // agent worked in a directory this process cannot resolve, every claim would
    // look broken. Pass the real workspace root as `cwd` to narrow it further.
    if (!(await exists(dirname(full)))) continue;
    if (!(await exists(full))) missing.push(claimed);
  }
  return missing;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** What the agent is told, in its own transcript, instead of the user hearing "done". */
export function daemonPrompt(missing: string[]): string {
  const list = missing.map((m) => `  - ${m}`).join("\n");
  return (
    "(system: you said you wrote the following, and they are not on disk:\n" +
    list +
    "\nThis was checked mechanically, not judged — the files are absent. Either " +
    "write them now with the appropriate tool, or correct your answer to say " +
    "plainly what you actually did. Do not repeat the claim.)"
  );
}

/**
 * What the PERSON is told when the agent could not put it right.
 *
 * The reflection above lands in the transcript, which on the desktop is a place
 * nobody looks. If the gate fires, the retries run out and the claim is still
 * false, the person is about to be handed an answer we know to be wrong. They
 * get told, in their own window, in words that name no machinery.
 */
export function daemonNotice(missing: string[]): string {
  const which = missing.length === 1 ? `${missing[0]} is` : `${missing.join(", ")} are`;
  return `Note: this reply says it wrote files that are not there (${which} missing). Check before relying on it.`;
}
