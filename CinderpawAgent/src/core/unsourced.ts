/**
 * "It says…" — about a file nothing opened.
 *
 * Three tasks in a row today came back with confident, detailed answers built
 * on nothing: a summary of a module that does not exist, complete with its
 * budget ledger and microtask yielding; a directory listing that included that
 * invented file; and "2026.8.1 written to …\VERSION.md" for a folder that was
 * never created. Every one of those turns made ZERO tool calls. The model did
 * not fail to read the file — it never tried.
 *
 * `done_when` covers the case where the task produces an artifact somebody can
 * assert on. It cannot cover an answer, and an answer is what most of these
 * tasks are.
 *
 * So this checks the one thing that needs no judgement: a turn that talks about
 * a file, having opened nothing. Not "does the answer look invented" — that is
 * an opinion, and opinions are what we are trying to stop trusting. Just the
 * mechanical gap between what the answer describes and what the turn actually
 * did.
 *
 * Deliberately narrow, so it never cries wolf:
 *   - only when the turn made NO tool calls at all. A turn that opened
 *     something and then also mentioned a second path is ambiguous, and an
 *     ambiguous warning is a warning people learn to ignore.
 *   - only when a real path shape appears (extension, separator, or drive).
 *     Prose about "the config" is not a claim about a file.
 *   - URLs are not files.
 *
 * It does not accuse. It states what did not happen and lets the reader draw
 * the conclusion — the same discipline as "no done_when declared: unverified".
 */

/** Paths as they appear in prose: `D:\a\b.ts`, `/etc/hosts`, `src/x.ts`, `REPORT.md`. */
const PATH_SHAPES = [
  /\b[A-Za-z]:[\\/][^\s"'`,;)]+/g, // Windows absolute
  /(?<![\w:])\/(?:[\w.-]+\/)+[\w.-]+/g, // POSIX absolute with at least one directory
  /\b[\w.-]+[\\/][\w.-]+(?:[\\/][\w.-]+)*\.\w{1,5}\b/g, // relative with a separator and extension
  // Bare filename, with two rules that only matter once something STATS the
  // result instead of merely warning about it. The lookbehind stops a name
  // being harvested out of the middle of a longer path already matched above
  // (`report.md` from `docs/report.md`), and the dotted middle keeps a
  // multi-part name whole (`mod.test.ts`, not `test.ts`). Getting either wrong
  // produces a path that is missing from disk because it was never the name.
  /(?<![\w./\\-])[\w-]+(?:\.[\w-]+)*\.(?:ts|tsx|js|jsx|json|md|py|rs|go|toml|yaml|yml|sh|ps1|txt|sql|html|css)\b/g,
];

/**
 * The first file path an answer claims to know about, or null.
 *
 * Exported for tests and for anything else that needs "is this answer about a
 * file" without re-deriving the shapes.
 */
export function claimedPath(answer: string): string | null {
  return claimedPaths(answer)[0] ?? null;
}

/**
 * EVERY distinct file path an answer claims, in the order they appear.
 *
 * `claimedPath` answers "is this answer about a file"; the Daemon gate
 * (`core/daemon.ts`) needs all of them, because "I created the module and its
 * test" is two claims and checking only the first lets the second one through.
 * Same shapes, same quoted-material rules — deliberately one implementation, so
 * a path the warning ignores is a path the gate ignores too.
 */
export function claimedPaths(answer: string): string[] {
  const prose = withoutQuotedMaterial(answer);
  const found: string[] = [];
  for (const shape of PATH_SHAPES) {
    shape.lastIndex = 0;
    for (const match of prose.match(shape) ?? []) {
      // Trailing sentence punctuation is prose, not part of the name.
      const cleaned = match.replace(/[.,;:)\]}'"`]+$/, "");
      if (cleaned && !found.includes(cleaned)) found.push(cleaned);
    }
  }
  return found;
}

/** Shared by both detectors, so they never disagree about what the agent said. */
function withoutQuotedMaterial(answer: string): string {
  return (
    answer
      // Fenced blocks are quoted material — code the agent is proposing, not a
      // claim about having read something.
      .replace(/```[\s\S]*?```/g, " ")
    // Inline code is NOT stripped, and that is the whole difference between a
    // detector that works and one that never fires. Models write paths in
    // backticks by habit — `src/core/loop.ts` — so removing inline code removes
    // exactly the claims this is here to catch. Found live: the warning stayed
    // silent through a full round of fabricated answers for this one reason.
    // URLs go before path matching, not after: `https://example.com/docs/x.md`
    // contains a perfectly good POSIX path shape, and trying to exclude it by
    // looking at the characters before the match is how you get a rule that
      // works until somebody writes a URL slightly differently.
      .replace(/\bhttps?:\/\/\S+/gi, " ")
  );
}

/**
 * "Am verificat acum", "I checked", "pe care am citit-o în acest turn" — the
 * answer asserting it went and looked.
 *
 * This is the detector the path one could not be. The A/B on 2026-08-11 put the
 * exact live sequence through six runs, and the turn that failed was triggered
 * by "scratch padul functioenaza?" — misspelt, with no keyword in it. Nothing
 * keyed on the QUESTION was ever going to catch that. The answer, though, said
 * it had read the file "în acest turn", and whether a tool ran is not a matter
 * of opinion.
 *
 * The precondition does the narrowing here, not the word list. This only ever
 * runs when ZERO tools executed while the answer was produced, and in that turn
 * "I checked" is false by construction — no judgement about whether the content
 * looks invented, which is the thing this whole file exists to stop trusting.
 *
 * Two things must NOT fire, and they are the reason for the shape of it:
 * offering to check ("pot verifica", "I'll check") is not claiming to have, and
 * saying you did not check is the honest answer we are trying to encourage.
 * English negation breaks the pattern on its own ("I have not checked" does not
 * contain "I have checked"); Romanian keeps the same participle, so `nu` is
 * excluded explicitly.
 */
const FRESH_CHECK = new RegExp(
  [
    // Romanian: the perfect tense, with the clitic that often splits it
    // ("l-am citit", "am citit-o"). `nu`/`n-` in front means the opposite.
    String.raw`(?<!\bnu\s)(?<!\bn-)(?:\b|-)am\s+(?:verificat|citit|rulat|deschis|executat|testat|inspectat)`,
    String.raw`\b(?:verificat|citit|rulat|deschis|executat|testat)-(?:o|le|i)\b`,
    // English.
    String.raw`\bI(?:'ve| have)? (?:checked|read|ran|run|opened|verified|tested|executed|inspected)\b`,
    String.raw`\bjust (?:checked|read|ran|verified|tested)\b`,
  ].join("|"),
  "i",
);

/** Whether the answer asserts it went and looked. Exported for tests. */
export function claimsFreshCheck(answer: string): boolean {
  return FRESH_CHECK.test(withoutQuotedMaterial(answer));
}

/**
 * "Check it", "does it still work", "testează și vezi dacă merge" — a message
 * asking about the state of the world right now, rather than about what was
 * found earlier.
 *
 * The second trigger for `withOpenFirst`, and it exists because of a transcript.
 * Ten minutes into a Discord session that had already read both files, the agent
 * was told "Testeaza si vezi daca merge" and replied "Am verificat acum" with
 * their exact sizes — 1709 bytes, 859 bytes — having made zero tool calls that
 * turn. Both numbers were CORRECT. It invented nothing; it recited results it
 * genuinely had, ten minutes old, and called that a check. A fresh session given
 * the same question a few minutes later used the tools immediately, which is what
 * made this look like the model degrading over a session. It was not. The
 * difference was that the fresh session had nothing in context to answer from.
 *
 * That is the whole failure: the better the memory, the more confidently a
 * question about NOW gets answered from THEN. A path in the message was the only
 * thing that ever triggered the instruction, and "is it still working?" has no
 * path in it.
 *
 * Narrow on purpose, and the exclusions carry as much weight as the matches:
 * talking about tests ("write a test", "the test suite is green") is not asking
 * for one to be run, so `test` only counts when it takes an object. Romanian
 * appears with and without diacritics because the owner types both.
 */
const CHECK_NOW = new RegExp(
  [
    // English — verbs that are almost always an instruction to act.
    String.raw`\b(?:verify|confirm|re-?run)\b`,
    // `check` and `test` only when they take an object: "check if", "test the
    // gateway". Bare, they are the vocabulary of every conversation about a test
    // suite, and "Check https://… when you get a chance" is not a request to go
    // and look at this machine.
    String.raw`\b(?:check|test)\s+(?:it|this|that|if\b|whether|the\s)`,
    String.raw`\b(?:see|find out) if\b`,
    String.raw`\bmake sure\b`,
    String.raw`\bstill\s+(?:work|working|running|there|up|alive)\b`,
    // Romanian. No `\b` before a diacritic: JS word boundaries are ASCII, so
    // `\bî` never matches at the start of "încearcă".
    String.raw`\btesteaz`,
    String.raw`\bverific`,
    String.raw`\bvezi dac`,
    String.raw`[iî]ncearc`,
    String.raw`\bmai (?:merge|func[tț]ioneaz)`,
  ].join("|"),
  "i",
);

/** Whether a message asks for the current state to be checked. Exported for tests. */
export function asksForCheck(userText: string): boolean {
  return CHECK_NOW.test(userText);
}

/**
 * The user's message, with the one instruction the model actually obeys added
 * when the message names a file.
 *
 * The warning below is a footnote on damage already done. This is the same
 * detector pointed the other way — before the turn instead of after it.
 *
 * It exists because of a measurement, not a theory: this model reaches for a
 * tool when it is told to in those words ("read it with a tool, do not answer
 * from memory") and invents fluently when it is not. Same prompt, same model,
 * one sentence apart. An A/B against a build from before any of today's changes
 * produced the identical fabricated answer word for word, so the gap is not
 * something more prompt engineering in SOUL.md closes — a general rule there was
 * tried, verified present in the running binary, and ignored completely. A rule
 * attached to the specific message, naming the specific file, is not.
 *
 * So the person no longer has to know the magic words. If their message names a
 * file, we say them.
 *
 * The trigger is `claimedPath`, deliberately: the layer that prevents and the
 * layer that warns then agree by construction on what counts as a claim about a
 * file. Cost when it does not fire: one regex over the message.
 */
export function withOpenFirst(userText: string): string {
  const path = claimedPath(userText);
  // The path form names WHICH file to open, so it wins when both match — a
  // generic "check something" would be a downgrade.
  if (path) {
    return (
      `${userText}\n\n` +
      `[Open \`${path}\` with a tool and read it before you describe it. ` +
      `Do not answer from memory.]`
    );
  }
  if (asksForCheck(userText)) {
    return (
      `${userText}\n\n` +
      `[Check this now with a tool before you answer. Results from earlier in this ` +
      `conversation are what things WERE, not what they are — do not answer from them, ` +
      `and do not say you checked unless you did.]`
    );
  }
  return userText;
}

/**
 * The line to append to an answer that describes a file the turn never opened —
 * or that says it went and looked when nothing did — or null when there is
 * nothing to say.
 *
 * `toolCalls` is the whole run's count, not one turn's: a run that read
 * something in its third turn and summarised it in its fifth is doing exactly
 * what it should. Which is also why the freshness claim is worth catching: with
 * this count at zero, "I checked" is not a doubtful claim, it is a false one.
 */
export function unsourcedWarning(
  answer: string,
  toolCalls: number,
  /**
   * What was asked. Checked as well as the answer, because the strongest case
   * is the one the answer hides: asked to summarise a named file, the model
   * described it at length WITHOUT ever naming it again — so an answer-only
   * check found nothing to object to while the whole reply was invented. What
   * the person named is the claim; whether the agent repeats it is style.
   */
  prompt = "",
): string | null {
  if (toolCalls > 0) return null;
  // Two ways in, one warning out. The path is the sharper subject when there is
  // one — it names what the answer is about — so it is tried first.
  const path = claimedPath(answer) ?? claimedPath(prompt);
  const subject = path
    ? `This is about \`${path}\``
    : claimsFreshCheck(answer)
      ? "This says it went and looked"
      : null;
  if (!subject) return null;
  return (
    `⚠️ _${subject}, but no file was opened and no command was run ` +
    `while producing this answer — nothing here was checked against your machine._`
  );
}
