/** Projects only the applied patches recorded in native tool results. */
import type { HostFileChange } from "@codexhost/harness-adapter";

import { displayPath, isAntigravityFileMutatingTool, toolTargetFile } from "./tool-projection.js";

/** The current native GENERIC result records applied edits as diff blocks. */
export function nativeToolFileChange(
  toolName: string,
  detail: { parameters?: unknown; output?: unknown },
  cwd: string,
): HostFileChange | null {
  if (!isAntigravityFileMutatingTool(toolName) || typeof detail.output !== "string") return null;
  const target = toolTargetFile(toolName, detail.parameters);
  if (!target) return null;
  const displayed = displayPath(target, cwd);
  if (!displayed) return null;
  const patches = Array.from(
    detail.output.matchAll(/^\[diff_block_start\]\r?\n[\s\S]*?^\[diff_block_end\]/gm),
    (match) =>
      match[0].slice(match[0].indexOf("\n") + 1, -"[diff_block_end]".length).replace(/\n$/, ""),
  );
  if (
    patches.length === 0 ||
    patches.some((patch) => !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(patch)) ||
    !/^[+-]/m.test(patches.join("\n"))
  ) {
    return null;
  }
  const aPath = displayed.absolute ? displayed.path : `a/${displayed.path}`;
  const bPath = displayed.absolute ? displayed.path : `b/${displayed.path}`;
  return {
    path: displayed.path,
    kind: "update",
    unifiedDiff: [
      `diff --git ${aPath} ${bPath}`,
      `--- ${aPath}`,
      `+++ ${bPath}`,
      ...patches,
      "",
    ].join("\n"),
  };
}
