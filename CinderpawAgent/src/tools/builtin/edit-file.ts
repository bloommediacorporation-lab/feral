/**
 * edit_file — in-place string replacement, the safe alternative to write_file.
 *
 * The current `write_file` requires the model to send the entire file body
 * back, which is wasteful and brittle for large files. `edit_file` accepts
 * an `old_string` / `new_string` pair and applies a targeted replace. This
 * mirrors the Claude Code `Edit` tool semantics:
 *   - by default, the edit fails if `old_string` is not unique in the file
 *     (so a typo can't silently miss the intended match)
 *   - `replace_all: true` skips the uniqueness check and replaces every
 *     occurrence
 *   - the path is validated against `allowedPaths` via `resolveAllowedPath`
 *     so directory-traversal out of the workspace is blocked & audited
 *
 * Requires `fs:read` (to load the file) AND `fs:write` (to persist the edit).
 */

import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../../atomic-write.ts";
import { resolveAllowedPath } from "../../egress/tool-permissions.ts";
import { checkBeforeWrite, noteWrite } from "../read-ledger.ts";
import { lineDelta, isScratchPath, scratchpadBrief } from "../file-delta.ts";
import type { Tool, ToolManifest } from "../../types.ts";

const MAX_EDIT_BYTES = 1024 * 1024; // 1 MB safety cap, same as write_file

export function createEditFileTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "edit_file",
    description:
      "Apply a targeted string replacement to a UTF-8 text file inside an " +
      "allowed directory. Fails if `old_string` is not unique in the file " +
      "(unless `replace_all` is set). Returns a small diff preview showing " +
      "what was changed.\n" +
      scratchpadBrief(),
    permissions: ["fs:read", "fs:write"],
    networkAccess: false,
    allowedPaths,
  };

  return {
    manifest,
    parameters: {
      path: {
        type: "string",
        description: "Absolute path to the file to edit.",
        required: true,
      },
      old_string: {
        type: "string",
        description:
          "The exact text to find in the file. Whitespace and newlines must match exactly. " +
          "Strip read_file's `N<tab>` line-number prefixes — they are not in the file.",
        required: true,
      },
      new_string: {
        type: "string",
        description: "The text to replace it with.",
        required: true,
      },
      replace_all: {
        type: "boolean",
        description:
          "When true, replace every occurrence of old_string. When false " +
          "(default), the edit fails if old_string appears more than once.",
        required: false,
      },
    },
    async execute(args, ctx) {
      const requested = args.path;
      const oldStr = args.old_string;
      const newStr = args.new_string;
      const replaceAll = args.replace_all === true;

      if (typeof requested !== "string" || !requested.trim()) {
        return { ok: false, content: "edit_file requires a non-empty 'path' string.", error: "bad_args" };
      }
      if (typeof oldStr !== "string") {
        return { ok: false, content: "edit_file requires an 'old_string' string.", error: "bad_args" };
      }
      if (typeof newStr !== "string") {
        return { ok: false, content: "edit_file requires a 'new_string' string.", error: "bad_args" };
      }
      if (oldStr === newStr) {
        return { ok: false, content: "old_string and new_string are identical — nothing to do.", error: "no_op" };
      }
      // An empty search string is not an unusual edit, it is a hang. The count
      // loop below advances by `oldStr.length`, so `indexOf("", 0)` returns 0
      // forever and the scan never moves — a tight synchronous loop with no
      // timer, no cancel and no timeout, on the thread that serves every other
      // tool. Ordinary model output produces it (a tool call whose arguments
      // got truncated mid-JSON arrives here as `old_string: ""`), so this is
      // reached by accident and not by attack. Refused with the other argument
      // guards, before any file is opened.
      if (oldStr === "") {
        return {
          ok: false,
          content:
            "edit_file needs a non-empty 'old_string' — it is the text to find. " +
            "To add content to a file, include enough surrounding text to locate " +
            "the insertion point, or use write_file for a new file.",
          error: "bad_args",
        };
      }

      // Resolve the path under the fs:read permission. The write side will
      // be re-validated below — resolveAllowedPath throws on out-of-bounds.
      // We translate the throw into a structured ToolResult so the agent
      // loop sees a clean error (the registry would also catch it, but
      // the message would lose the path context).
      let safePath: string;
      try {
        safePath = resolveAllowedPath(ctx.manifest, "fs:read", requested);
      } catch (err) {
        return {
          ok: false,
          content: String((err as Error).message ?? err),
          error: "permission_denied",
        };
      }

      // Read-before-edit gate. Cheap, mechanical, and placed BEFORE the file
      // is loaded so a refusal costs nothing. See read-ledger.ts.
      const stale = checkBeforeWrite(ctx.sessionId, safePath);
      if (stale) {
        return { ok: false, content: `edit_file: ${stale}`, error: "unread_file" };
      }

      let original: string;
      try {
        const buf = await readFile(safePath);
        if (buf.byteLength > MAX_EDIT_BYTES) {
          return {
            ok: false,
            content: `File exceeds the 1 MB edit cap (${buf.byteLength} bytes).`,
            error: "too_large",
          };
        }
        original = buf.toString("utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return { ok: false, content: `File not found: ${safePath}`, error: "not_found" };
        }
        return { ok: false, content: `Cannot read file: ${String(err)}`, error: "io_error" };
      }

      // Count occurrences of oldStr in the file.
      let occurrences = 0;
      let searchFrom = 0;
      while (true) {
        const idx = original.indexOf(oldStr, searchFrom);
        if (idx === -1) break;
        occurrences++;
        searchFrom = idx + oldStr.length;
      }

      if (occurrences === 0) {
        // `read_file` prefixes every line with `N<tab>` for reference, and the
        // most likely way to arrive here is by copying a block straight out of
        // that output. Naming the cause turns a dead end into a retry: without
        // this the model sees only "not found" and reaches for whitespace,
        // which is not the problem.
        const looksNumbered = /^[ ]*\d+\t/m.test(oldStr);
        return {
          ok: false,
          content:
            `old_string not found in ${safePath}. ` +
            (looksNumbered
              ? `It carries read_file's \`N<tab>\` line-number prefixes — those are not in the file. ` +
                `Strip them and try again.`
              : `Check whitespace, newlines, and indentation.`),
          error: "not_found",
        };
      }
      if (occurrences > 1 && !replaceAll) {
        return {
          ok: false,
          content:
            `old_string appears ${occurrences} times in ${safePath}. ` +
            `Either provide more context to make it unique, or set replace_all=true.`,
          error: "ambiguous_match",
        };
      }

      // Apply the replacement. `replaceAll: true` uses split/join; the
      // unique case uses a single indexOf for clarity in the diff.
      let updated: string;
      let replaced: number;
      if (replaceAll) {
        // String.split with a string argument is well-defined and matches
        // every non-overlapping occurrence.
        updated = original.split(oldStr).join(newStr);
        replaced = occurrences;
      } else {
        const idx = original.indexOf(oldStr);
        updated = original.slice(0, idx) + newStr + original.slice(idx + oldStr.length);
        replaced = 1;
      }

      // Re-validate the write side. The path is the same and the manifest
      // is identical, so this is effectively a no-op — but doing the
      // explicit check keeps the read/write symmetry visible in the code
      // and makes any future divergence between the permissions loud.
      resolveAllowedPath(ctx.manifest, "fs:write", safePath);

      await atomicWriteFile(safePath, updated);
      // Our own write must not make the NEXT edit look stale.
      noteWrite(ctx.sessionId, safePath);

      // Build a tiny diff preview. We pick the first replaced region and
      // show the first 5 lines of context on each side.
      const delta = lineDelta(original, updated);
      const previewIdx = original.indexOf(oldStr);
      const contextBefore = original
        .slice(Math.max(0, original.lastIndexOf("\n", previewIdx - 80) + 1), previewIdx)
        .split("\n")
        .slice(-5)
        .join("\n");
      const contextAfter = updated
        .slice(updated.indexOf(newStr, previewIdx) + newStr.length)
        .split("\n")
        .slice(0, 5)
        .join("\n");

      return {
        ok: true,
        content:
          `Edited ${safePath}: replaced ${replaced} occurrence(s).\n\n` +
          `--- before ---\n${contextBefore}${contextBefore ? "\n" : ""}- ${oldStr}\n--- after ---\n+ ${newStr}\n${contextAfter}`,
        data: {
          path: safePath,
          replaced,
          bytes: Buffer.byteLength(updated, "utf8"),
          // Same counter write_file uses, so "3 edits +40" adds up whichever
          // tool made each one.
          linesAdded: delta.added,
          linesRemoved: delta.removed,
          scratch: isScratchPath(safePath),
        },
      };
    },
  };
}
