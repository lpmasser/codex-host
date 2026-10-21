import path from "node:path";
import { describe, expect, it } from "vitest";
import { nativeToolFileChange } from "../src/index.js";
const cwd = path.resolve("/test/workspace");
const target = path.join(cwd, "src", "app.ts");
const output = (patch: string) => `[diff_block_start]\n${patch}\n[diff_block_end]\n`;
describe("native applied diff boundary", () => {
  it.each([
    ["CRLF", "@@ -1,1 +1,1 @@\r\n-old\r\n+new\r\n"],
    ["pure insertion", "@@ -0,0 +1,1 @@\n+new\n"],
    ["pure deletion", "@@ -1,1 +0,0 @@\n-old\n"],
    ["multiple hunks", "@@ -3,1 +3,1 @@\n-old\n+new\n@@ -55,1 +55,1 @@\n-before\n+after\n"],
    ["long line", `@@ -1,1 +1,1 @@\n-${"A".repeat(20_000)}\n+${"B".repeat(20_000)}\n`],
  ])("preserves native %s patches without rebuilding hunks", (_name, patch) => {
    const change = nativeToolFileChange(
      "replace_file_content",
      {
        parameters: { TargetFile: target },
        output: `[diff_block_start]\r\n${patch}[diff_block_end]\r\n`,
      },
      cwd,
    );
    expect(change).toEqual({
      path: "src/app.ts",
      kind: "update",
      unifiedDiff: `diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n${patch}`,
    });
  });
  it("preserves Unicode, control characters and externally located paths", () => {
    const outside = path.resolve("/other/语言.ts");
    const change = nativeToolFileChange(
      "replace_file_content",
      {
        parameters: { TargetFile: outside },
        output: output("@@ -1,1 +1,1 @@\n-旧内容\n+🚀 مرحبا\t\u001b[31m"),
      },
      cwd,
    );
    expect(change?.path).toBe(outside.replaceAll("\\", "/"));
    expect(change?.unifiedDiff).toContain("-旧内容\n+🚀 مرحبا\t\u001b[31m");
  });
  it("rejects incomplete, malformed, unchanged and non-text results", () => {
    for (const body of [
      output("Not an applied patch"),
      output("@@ -1,1 +1,1 @@\n unchanged"),
      "[diff_block_start]\n@@ -1,1 +1,1 @@\n-old\n+new",
      {},
    ]) {
      expect(
        nativeToolFileChange(
          "replace_file_content",
          { parameters: { TargetFile: target }, output: body },
          cwd,
        ),
      ).toBeNull();
    }
    for (const invalidPath of ["bad\npath", "bad\0path"]) {
      expect(
        nativeToolFileChange(
          "replace_file_content",
          {
            parameters: { TargetFile: invalidPath },
            output: output("@@ -1,1 +1,1 @@\n-old\n+new"),
          },
          cwd,
        ),
      ).toBeNull();
    }
  });
});
