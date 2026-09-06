/**
 * The database belongs to the profile, not to the directory you were standing
 * in when you typed `cinderpaw`.
 *
 * The default was the relative string "data/cinderpaw.db", resolved against
 * `process.cwd()`. The desktop never saw it, because the Rust host passes
 * CINDERPAW_DB explicitly and is the only thing in the tree that sets it. The
 * npm CLI has no such host, so running it from two directories built two
 * unrelated brains, each with its own writer lock, and said nothing.
 *
 * Everything else in the sidecar already resolved through `cinderpawHome()`.
 * These tests pin the database to the same rule.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";
import { defaultDbPath } from "../src/config.ts";

let home: string;
let elsewhere: string;
let originalCwd: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cinderpaw-dbpath-home-"));
  elsewhere = mkdtempSync(join(tmpdir(), "cinderpaw-dbpath-cwd-"));
  originalCwd = process.cwd();
  originalHome = process.env.CINDERPAW_HOME;
  process.env.CINDERPAW_HOME = home;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.CINDERPAW_HOME;
  else process.env.CINDERPAW_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

/**
 * `defaultDbPath` lives in `config.ts` beside the other path rules, so the test
 * calls it directly. `resolve()` mirrors what `loadConfig` does with the value.
 */
function resolveDbPath(): string {
  const explicit = process.env.CINDERPAW_DB;
  return resolve(explicit ?? defaultDbPath());
}

describe("the database follows the profile", () => {
  test("the default path is inside the profile dir, not the working directory", () => {
    process.chdir(elsewhere);
    const dbPath = resolveDbPath();

    expect(isAbsolute(dbPath)).toBe(true);
    expect(dbPath.startsWith(home)).toBe(true);
    expect(dbPath.startsWith(elsewhere)).toBe(false);
    expect(dbPath.endsWith(join("data", "cinderpaw.db"))).toBe(true);
  });

  test("two different working directories resolve to the SAME database", () => {
    process.chdir(elsewhere);
    const fromA = resolveDbPath();
    process.chdir(tmpdir());
    const fromB = resolveDbPath();

    expect(fromA).toBe(fromB);
  });

  test("a pre-rename feral.db in the profile still wins when it is the only one", () => {
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(join(home, "data", "feral.db"), "months of history");
    process.chdir(elsewhere);

    const dbPath = resolveDbPath();
    expect(dbPath).toBe(join(home, "data", "feral.db"));
  });

  test("an explicit CINDERPAW_DB still wins, and a relative one is still cwd-relative", () => {
    process.env.CINDERPAW_DB = "custom/spot.db";
    process.chdir(elsewhere);
    try {
      const dbPath = resolveDbPath();
      expect(dbPath).toBe(join(elsewhere, "custom", "spot.db"));
    } finally {
      delete process.env.CINDERPAW_DB;
    }
  });
});
