import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { nativeToolFileChange } from "../src/code-action-diff.js";
import {
  parseAntigravityToolDetail,
  parseSubagentTranscript,
  readAntigravityToolDetail,
} from "../src/subagent-transcript.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const cwd = path.resolve("/test/workspace");
const file = path.join(cwd, "src", "app.ts");
const log = (...steps: unknown[]) => steps.map((step) => JSON.stringify(step)).join("\n") + "\n";
const plan = (index: number, args: Record<string, unknown>) => ({
  step_index: index,
  source: "MODEL",
  type: "PLANNER_RESPONSE",
  status: "DONE",
  thinking: "Never expose the planner's internal thinking.",
  tool_calls: [{ name: "replace_file_content", args }],
});
const result = (index: number, content: string) => ({
  step_index: index,
  source: "MODEL",
  type: "GENERIC",
  status: "DONE",
  content,
});
const appliedDiff =
  "Changes applied.\n[diff_block_start]\n@@ -3,2 +3,2 @@\n-old\n+new\n \n[diff_block_end]\n";

describe("Antigravity native tool details", () => {
  it("binds repeated edits to their execution step and decodes original parameters", () => {
    const text = log(
      plan(1, {
        TargetFile: JSON.stringify(file),
        TargetContent: '"first"',
        ReplacementContent: '"second"',
      }),
      result(2, "First result"),
      plan(3, {
        TargetFile: JSON.stringify(file),
        TargetContent: '"second"',
        ReplacementContent: '"third"',
        StartLine: "3",
        AllowMultiple: "false",
      }),
      result(4, appliedDiff),
    );
    expect(parseAntigravityToolDetail(text, 4, "replace_file_content")).toEqual({
      parameters: {
        TargetFile: file,
        TargetContent: "second",
        ReplacementContent: "third",
        StartLine: 3,
        AllowMultiple: false,
      },
      output: appliedDiff,
    });
    expect(parseAntigravityToolDetail(text, 2, "replace_file_content")?.output).toBe(
      "First result",
    );
    expect(parseAntigravityToolDetail(text, 4, "view_file")).toBeNull();
    expect(parseAntigravityToolDetail(text, 3, "replace_file_content")).toBeNull();
  });

  it("ignores checkpoints and error messages when associating the native call with its result", () => {
    const text =
      log(
        plan(1, { TargetFile: JSON.stringify(file) }),
        { step_index: 2, source: "SYSTEM", type: "CHECKPOINT", status: "DONE", content: "Summary" },
        {
          step_index: 3,
          source: "SYSTEM",
          type: "ERROR_MESSAGE",
          status: "DONE",
          error: "An earlier retry",
        },
        result(4, appliedDiff),
      ) + '{"step_index":5';
    expect(parseAntigravityToolDetail(text, 4, "replace_file_content")?.output).toBe(appliedDiff);
  });

  it("resets pending calls at a new user Turn and never publishes internal thinking", () => {
    const text = log(
      plan(1, { TargetFile: '"old.ts"' }),
      {
        step_index: 2,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        content: "Next Turn",
      },
      plan(3, { TargetFile: JSON.stringify(file) }),
      result(4, appliedDiff),
    );
    const detail = parseAntigravityToolDetail(text, 4, "replace_file_content");
    expect(detail?.parameters.TargetFile).toBe(file);
    expect(JSON.stringify(detail)).not.toContain("internal thinking");
  });

  it("preserves subagent compaction and does not consume its pending tool call", () => {
    const text = log(
      plan(1, { TargetFile: JSON.stringify(file) }),
      { step_index: 2, source: "MODEL", type: "CHECKPOINT", status: "DONE", content: "Summary" },
      result(3, appliedDiff),
    );
    const snapshot = parseSubagentTranscript(
      text,
      conversationId,
      conversationId,
      "completed",
      cwd,
      64_000,
    );
    expect(snapshot.turns[0]?.items).toMatchObject([
      { item: { type: "contextCompaction" } },
      {
        item: {
          type: "toolExecution",
          toolName: "replace_file_content",
          arguments: { TargetFile: file },
        },
      },
    ]);
  });

  it("reads only the selected Profile's transcript and rejects redirected logs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-tool-detail-"));
    const dir = path.join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      conversationId,
      ".system_generated",
      "logs",
    );
    const selected = { conversationId, stepIndex: 2, toolName: "replace_file_content", home };
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "transcript.jsonl"),
        log(plan(1, { TargetFile: JSON.stringify(file) }), result(2, appliedDiff)),
      );
      expect((await readAntigravityToolDetail(selected))?.output).toBe(appliedDiff);
      await rm(path.join(dir, "transcript.jsonl"));
      const outside = path.join(home, "unrelated.jsonl");
      await writeFile(
        outside,
        log(plan(1, { TargetFile: JSON.stringify(file) }), result(2, "Unrelated")),
      );
      await symlink(outside, path.join(dir, "transcript.jsonl"));
      expect(await readAntigravityToolDetail(selected)).toBeNull();
      expect(
        await readAntigravityToolDetail({ ...selected, conversationId: "../unrelated" }),
      ).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("waits for a terminal native step that is still being appended to an existing log", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-tool-flush-"));
    const dir = path.join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      conversationId,
      ".system_generated",
      "logs",
    );
    try {
      await mkdir(dir, { recursive: true });
      const fileName = path.join(dir, "transcript.jsonl");
      await writeFile(
        fileName,
        log(plan(1, { TargetFile: JSON.stringify(file) })) + '{"step_index":2',
      );
      const append = (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        await writeFile(
          fileName,
          log(plan(1, { TargetFile: JSON.stringify(file) }), result(2, appliedDiff)),
        );
      })();
      const [detail] = await Promise.all([
        readAntigravityToolDetail({
          conversationId,
          stepIndex: 2,
          toolName: "replace_file_content",
          home,
        }),
        append,
      ]);
      expect(detail?.output).toBe(appliedDiff);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("Antigravity applied native diffs", () => {
  it("uses the actual applied patch with its line numbers and trailing context preserved", () => {
    const change = nativeToolFileChange(
      "replace_file_content",
      { parameters: { TargetFile: file }, output: appliedDiff },
      cwd,
    );
    expect(change).toEqual({
      path: "src/app.ts",
      kind: "update",
      unifiedDiff:
        "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -3,2 +3,2 @@\n-old\n+new\n \n",
    });
  });

  it("combines multiple applied diff blocks for a multi-edit without reconstructing requested replacements", () => {
    const output =
      appliedDiff + "[diff_block_start]\n@@ -8,1 +8,1 @@\n-before\n+after\n[diff_block_end]\n";
    const change = nativeToolFileChange(
      "multi_replace_file_content",
      { parameters: { TargetFile: file, ReplacementChunks: [] }, output },
      cwd,
    );
    expect(change?.unifiedDiff).toContain("@@ -3,2 +3,2 @@");
    expect(change?.unifiedDiff).toContain("@@ -8,1 +8,1 @@");
    expect(change?.unifiedDiff).not.toContain("diff_block");
  });

  it.each([
    [
      "write_to_file",
      { TargetFile: file, CodeContent: "Requested" },
      "Created file with requested content.",
    ],
    ["view_file", { AbsolutePath: file }, appliedDiff],
  ])("keeps %s without an applied edit as tool details", (toolName, parameters, output) => {
    expect(nativeToolFileChange(toolName as string, { parameters, output }, cwd)).toBeNull();
  });
});
