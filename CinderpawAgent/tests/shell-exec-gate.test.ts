/**
 * PROMISES.md says shell execution can be switched off. Until 2026-09-07 it
 * could not: the switch was an `if` around two registrations in boot.ts, and
 * ten tools registered outside it kept spawning processes with the switch set
 * to false. These tests hold the gate to the promise rather than to the
 * placement of a brace.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createCodeQualityTool } from "../src/tools/builtin/code-quality.ts";
import { createGitStatusTool } from "../src/tools/builtin/git.ts";
import { createShellExecTool } from "../src/tools/builtin/shell-exec.ts";
import { createTodoWriteTool } from "../src/tools/builtin/todo-write.ts";
import type { AuditLog, EgressProxy, ProcessSandbox } from "../src/types.ts";

function registry(): ToolRegistry {
  return new ToolRegistry({} as EgressProxy, {} as AuditLog, {} as ProcessSandbox);
}

const ROOTS = [process.cwd()];

afterEach(() => {
  delete process.env.CINDERPAW_ENABLE_SHELL_EXEC;
});

describe("CINDERPAW_ENABLE_SHELL_EXEC=false", () => {
  test("refuses every tool that declares process:spawn, not just shell_exec", () => {
    // The exact bug: these two were outside the boot.ts `if`, and their own
    // manifests say they spawn processes.
    process.env.CINDERPAW_ENABLE_SHELL_EXEC = "false";
    const r = registry();
    r.register(createShellExecTool(ROOTS));
    r.register(createCodeQualityTool("install_deps", ROOTS));
    r.register(createCodeQualityTool("build_project", ROOTS));
    r.register(createGitStatusTool(ROOTS));

    expect(r.has("shell_exec")).toBe(false);
    expect(r.has("install_deps")).toBe(false);
    expect(r.has("build_project")).toBe(false);
    expect(r.has("git_status")).toBe(false);
  });

  test("says what it withheld", () => {
    // A control that silently removes tools reads as a broken install.
    process.env.CINDERPAW_ENABLE_SHELL_EXEC = "false";
    const r = registry();
    r.register(createCodeQualityTool("run_tests", ROOTS));
    expect(r.withheldForShellExec).toContain("run_tests");
  });

  test("leaves tools that do not spawn alone", () => {
    // The switch is about process execution. Turning it on must not quietly
    // amputate half the product.
    process.env.CINDERPAW_ENABLE_SHELL_EXEC = "false";
    const r = registry();
    r.register(createTodoWriteTool({ get: () => [], set: () => {} } as never));
    expect(r.has("todo_write")).toBe(true);
  });

  test("the default registers them, because the switch is opt-out", () => {
    const r = registry();
    r.register(createGitStatusTool(ROOTS));
    r.register(createCodeQualityTool("run_tests", ROOTS));
    expect(r.has("git_status")).toBe(true);
    expect(r.has("run_tests")).toBe(true);
    expect(r.withheldForShellExec).toHaveLength(0);
  });
});
