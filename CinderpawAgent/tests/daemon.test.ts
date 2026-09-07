import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimsWrote, daemonNotice, daemonPrompt, unkeptWriteClaims } from "../src/core/daemon.ts";

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "daemon-"));
}

describe("claimsWrote", () => {
  test("fires on a write claim in both languages", () => {
    expect(claimsWrote("I created src/foo.ts for you.")).toBe(true);
    expect(claimsWrote("Am creat fisierul src/foo.ts.")).toBe(true);
    expect(claimsWrote("I've written the report to REPORT.md")).toBe(true);
    expect(claimsWrote("L-am salvat in notes/x.md")).toBe(true);
  });

  test("does not fire on mentioning, offering, or denying", () => {
    // The three false positives that would make this unusable. An answer that
    // honestly reports a missing file must never be accused of lying about it.
    expect(claimsWrote("I could not find src/foo.ts anywhere.")).toBe(false);
    expect(claimsWrote("Pot crea src/foo.ts daca vrei.")).toBe(false);
    expect(claimsWrote("Nu am creat niciun fisier.")).toBe(false);
  });
});

describe("unkeptWriteClaims", () => {
  test("a claimed file that is absent is reported", async () => {
    const dir = await workspace();
    expect(await unkeptWriteClaims("I created report.md with the summary.", dir)).toEqual(["report.md"]);
  });

  test("a claimed file that exists is not reported", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "report.md"), "hi");
    expect(await unkeptWriteClaims("I created report.md with the summary.", dir)).toEqual([]);
  });

  test("every claim is checked, not just the first", async () => {
    // "I created the module and its test" is two claims; checking one lets the
    // other through, which is the whole reason claimedPaths exists.
    const dir = await workspace();
    await writeFile(join(dir, "mod.ts"), "export {}");
    expect(await unkeptWriteClaims("I created mod.ts and mod.test.ts.", dir)).toEqual(["mod.test.ts"]);
  });

  test("mentioning a missing file without claiming to have written it is silent", async () => {
    const dir = await workspace();
    expect(await unkeptWriteClaims("I could not find config.json in the project.", dir)).toEqual([]);
  });

  test("a path whose parent directory does not exist is skipped, not accused", async () => {
    // Unknown location means no claim checked. An agent working in a directory
    // this process cannot resolve must not have every sentence called a lie.
    const dir = await workspace();
    expect(await unkeptWriteClaims("I created nowhere/at/all/report.md.", dir)).toEqual([]);
  });

  test("code fences are quoted material, not claims", async () => {
    const dir = await workspace();
    const answer = "I created the file.\n```\nsee also missing.ts\n```";
    expect(await unkeptWriteClaims(answer, dir)).toEqual([]);
  });
});

describe("what gets said", () => {
  test("the agent is told which files are missing", () => {
    const p = daemonPrompt(["a.ts", "b.ts"]);
    expect(p).toContain("a.ts");
    expect(p).toContain("b.ts");
  });

  test("the person is told too, without naming machinery", () => {
    // The reflection goes to a transcript nobody reads. If the retries fail, the
    // reason has to be on the user's screen or it may as well not exist.
    const n = daemonNotice(["report.md"]);
    expect(n).toContain("report.md");
    expect(n.toLowerCase()).not.toContain("daemon");
    expect(n.toLowerCase()).not.toContain("done_when");
  });
});
