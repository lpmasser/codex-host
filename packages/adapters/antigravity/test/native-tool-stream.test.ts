import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessSession, HostEvent } from "@codexhost/harness-adapter";
import { CodexTurnProjector, projectHistoricalTurn } from "@codexhost/protocol-core";
import { hostTurnIdSchema, type HostTurnId, type JsonObject } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { AntigravityAdapter } from "../src/index.js";

const conversationId = "22222222-2222-4222-8222-222222222222";

async function withNativeStream(
  build: (home: string) => { nativeSteps: unknown[]; events: unknown[] },
  check: (fixture: {
    home: string;
    session: HarnessSession;
    turnId: HostTurnId;
    observed: HostEvent[];
    wire: JsonObject[];
    finish(): Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-native-stream-"));
  const release = path.join(home, "release-done");
  const { nativeSteps, events } = build(home);
  const script = String.raw`
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('models')){console.log('gemini-3.8-flash\tGemini 3.8 Flash');process.exit(0);}
if(process.argv.includes('--version')){console.log('1.3.4');process.exit(0);}
if(process.argv.some(arg=>arg.startsWith('--print=')))process.exit(0);
const logAt=process.argv.indexOf('--log-file');
if(logAt<0 || !process.argv[logAt+1])process.exit(2);
fs.writeFileSync(process.argv[logAt+1],'isolated fake CLI, no Language Server');
const dir=path.join(${JSON.stringify(home)},'.gemini','antigravity-cli','brain',${JSON.stringify(conversationId)},'.system_generated','logs');
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'transcript.jsonl'),${JSON.stringify(nativeSteps.map((step) => JSON.stringify(step)).join("\n") + "\n")});
const events=${JSON.stringify(events)},emit=event=>console.log(JSON.stringify(event));
emit(events[0]);emit(events[1]);
function finish(){if(!fs.existsSync(${JSON.stringify(release)})){setTimeout(finish,10);return;}for(const event of events.slice(2))emit(event);}
finish();
`;
  const js = path.join(home, "agy.cjs");
  const command = path.join(home, process.platform === "win32" ? "agy.cmd" : "agy");
  await writeFile(js, script);
  await writeFile(
    command,
    process.platform === "win32"
      ? `@"${process.execPath}" "${js}" %*\r\n`
      : `#!${process.execPath}\n${script}`,
  );
  await chmod(command, 0o755);
  const adapter = new AntigravityAdapter({
    command,
    environment: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GEMINI_HOME: path.join(home, ".gemini"),
      CODEXHOST_DATA_DIR: path.join(home, "host"),
      CODEXHOST_THREAD_ID: "native-stream-thread",
    },
  });
  try {
    const opened = await adapter.open({ kind: "create", cwd: home });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const turnId = hostTurnIdSchema.parse("native-stream-turn");
    const projector = new CodexTurnProjector({
      threadId: "native-stream-thread",
      turnId,
      cwd: home,
      startedAtMs: 1_000,
    });
    const observed: HostEvent[] = [];
    const wire: JsonObject[] = [];
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const reader = (async () => {
      for await (const output of session.outputs) {
        if (output.kind !== "event") continue;
        const event = output.event;
        observed.push(event);
        if (
          event.type === "turn.started" ||
          event.type === "item.started" ||
          event.type === "item.completed" ||
          event.type === "turn.completed"
        )
          wire.push(...projector.project(event).messages);
        if (event.type === "item.started") resolveStarted();
        if (event.type === "turn.completed") return;
      }
    })();
    expect(
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Fixture Turn" }],
      }),
    ).toMatchObject({ ok: true });
    await started;
    await check({
      home,
      session,
      turnId,
      observed,
      wire,
      finish: async () => {
        await writeFile(release, "continue");
        await reader;
      },
    });
  } finally {
    await adapter.close();
    await rm(home, { recursive: true, force: true });
  }
}

describe("Antigravity native tool stream enrichment", () => {
  it("projects exact-step native details and applied edits into live events and saved history", async () => {
    await withNativeStream(
      (home) => {
        const target = path.join(home, "src", "app.ts");
        const logStep = (step_index: number, type: string, other: Record<string, unknown>) => ({
          step_index,
          source: "MODEL",
          type,
          status: "DONE",
          ...other,
        });
        const nativeSteps = [
          logStep(1, "PLANNER_RESPONSE", {
            thinking: "Private internal thinking",
            tool_calls: [
              {
                name: "view_file",
                args: { AbsolutePath: JSON.stringify(target), StartLine: "10", EndLine: "12" },
              },
            ],
          }),
          logStep(2, "GENERIC", {
            content: "10: full native file content\n11: more content\n12: end",
          }),
          logStep(3, "PLANNER_RESPONSE", {
            tool_calls: [
              {
                name: "replace_file_content",
                args: {
                  TargetFile: JSON.stringify(target),
                  TargetContent: '"old"',
                  ReplacementContent: '"new"',
                },
              },
            ],
          }),
          logStep(4, "GENERIC", {
            content: "[diff_block_start]\n@@ -1,1 +1,1 @@\n-old\n+new\n[diff_block_end]\n",
          }),
          logStep(5, "PLANNER_RESPONSE", {
            tool_calls: [
              {
                name: "replace_file_content",
                args: {
                  TargetFile: JSON.stringify(target),
                  TargetContent: '"new"',
                  ReplacementContent: '"newer"',
                },
              },
            ],
          }),
          logStep(6, "GENERIC", {
            content: "[diff_block_start]\n@@ -1,1 +1,1 @@\n-new\n+newer\n[diff_block_end]\n",
          }),
        ];
        const update = (step_index: number, state: string, name: string, info: unknown) => ({
          event: "step_update",
          step_update: {
            conversation_id: conversationId,
            step_index,
            state,
            step_type: "tool",
            tool_name: name,
            tool_info: info,
          },
        });
        const events = [
          { event: "init", conversation_id: conversationId },
          update(2, "ACTIVE", "view_file", { parameters: { AbsolutePath: target } }),
          update(2, "DONE", "view_file", { output: "Read 3 lines" }),
          update(4, "ACTIVE", "replace_file_content", { parameters: { TargetFile: target } }),
          update(4, "DONE", "replace_file_content", {}),
          update(6, "ACTIVE", "replace_file_content", { parameters: { TargetFile: target } }),
          update(6, "DONE", "replace_file_content", {}),
          {
            event: "result",
            result: { conversation_id: conversationId, status: "SUCCESS", num_turns: 1 },
          },
        ];
        return { nativeSteps, events };
      },
      async ({ home, session, observed, finish }) => {
        const target = path.join(home, "src", "app.ts");
        await finish();
        const completed = observed
          .filter((event) => event.type === "item.completed")
          .map((event) => event.snapshot);
        expect(completed).toMatchObject([
          {
            item: {
              type: "toolExecution",
              toolName: "view_file",
              arguments: { AbsolutePath: target, StartLine: 10, EndLine: 12 },
              activity: { type: "read", path: target },
              output: {
                content: [{ text: "10: full native file content\n11: more content\n12: end" }],
              },
            },
          },
          {
            item: {
              type: "fileChange",
              changes: [{ path: "src/app.ts", unifiedDiff: expect.stringContaining("-old\n+new") }],
            },
          },
          {
            item: {
              type: "fileChange",
              changes: [
                { path: "src/app.ts", unifiedDiff: expect.stringContaining("-new\n+newer") },
              ],
            },
          },
        ]);
        const snapshot = await session.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) expect(snapshot.value.turns[0]?.items).toEqual(completed);
        expect(JSON.stringify(observed)).not.toContain("Private internal thinking");
      },
    );
  });

  it("publishes ACTIVE before DONE and projects enriched, repeated and failed calls", async () => {
    const cases = [
      {
        name: "list_dir",
        parameters: { DirectoryPath: "/src" },
        activity: { type: "listFiles", path: "/src" },
        output: "app.ts\nutil.ts",
      },
      {
        name: "grep_search",
        parameters: { Query: " export ", SearchPath: "/src" },
        activity: { type: "search", query: " export ", path: "/src" },
        output: "matching lines",
      },
      {
        name: "view_file",
        parameters: { AbsolutePath: "/src/app.ts" },
        activity: { type: "read", path: "/src/app.ts" },
        output: "file content",
        partial: true,
      },
      {
        name: "view_file",
        parameters: { AbsolutePath: "/src/util.ts" },
        activity: { type: "read", path: "/src/util.ts" },
        output: "other content",
        doneOnly: true,
      },
      {
        name: "view_file",
        parameters: { AbsolutePath: "/src/missing.ts" },
        activity: { type: "read", path: "/src/missing.ts" },
        output: "File not found",
        failed: true,
      },
    ];
    await withNativeStream(
      () => {
        const nativeSteps = cases.flatMap((entry, index) => [
          {
            step_index: index * 2 + 1,
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            status: "DONE",
            tool_calls: [
              {
                name: entry.name,
                args: Object.fromEntries(
                  Object.entries(entry.parameters).map(([key, value]) => [
                    key,
                    JSON.stringify(value),
                  ]),
                ),
              },
            ],
          },
          {
            step_index: index * 2 + 2,
            source: "MODEL",
            type: "GENERIC",
            status: "DONE",
            content: entry.output,
          },
        ]);
        const events: unknown[] = [{ event: "init", conversation_id: conversationId }];
        for (const [index, entry] of cases.entries()) {
          const step = {
            conversation_id: conversationId,
            step_index: index * 2 + 2,
            step_type: "tool",
            tool_name: entry.name,
          };
          if (!entry.doneOnly)
            events.push({
              event: "step_update",
              step_update: {
                ...step,
                state: "ACTIVE",
                tool_info: { parameters: entry.partial ? {} : entry.parameters },
              },
            });
          events.push({
            event: "step_update",
            step_update: {
              ...step,
              state: entry.failed ? "ERROR" : "DONE",
              tool_info: entry.failed ? { error: entry.output } : {},
            },
          });
        }
        events.push({
          event: "result",
          result: { conversation_id: conversationId, status: "SUCCESS", num_turns: 1 },
        });
        return { nativeSteps, events };
      },
      async ({ home, session, turnId, observed, wire, finish }) => {
        expect(
          observed.some(
            (event) => event.type === "item.completed" || event.type === "turn.completed",
          ),
        ).toBe(false);
        expect(wire).toContainEqual(
          expect.objectContaining({
            method: "item/started",
            params: expect.objectContaining({
              item: expect.objectContaining({
                commandActions: [{ type: "listFiles", command: "list_dir /src", path: "/src" }],
                status: "inProgress",
              }),
            }),
          }),
        );
        await finish();
        const completed = observed
          .filter((event) => event.type === "item.completed")
          .map((event) => event.snapshot);
        expect(completed).toHaveLength(cases.length);
        expect(new Set(completed.map((snapshot) => snapshot.item.itemId)).size).toBe(cases.length);
        for (const [index, entry] of cases.entries()) {
          const completedCall = completed[index];
          if (!completedCall) throw new Error("Missing tool completion");
          expect(completed[index]).toMatchObject({
            item: {
              toolName: entry.name,
              arguments: entry.parameters,
              activity: entry.activity,
              output: { content: [{ text: entry.output }] },
            },
            outcome: { status: entry.failed ? "failed" : "succeeded" },
          });
          expect(wire).toContainEqual(
            expect.objectContaining({
              method: "item/completed",
              params: expect.objectContaining({
                item: expect.objectContaining({
                  id: completedCall.item.itemId,
                  type: "commandExecution",
                  commandActions: [expect.objectContaining(entry.activity)],
                  aggregatedOutput: entry.output,
                  processId: null,
                  exitCode: null,
                  status: entry.failed ? "failed" : "completed",
                }),
              }),
            }),
          );
        }
        const restored = await session.readSnapshot();
        if (!restored.ok) throw new Error(restored.error.message);
        expect(restored.value.turns[0]?.items).toEqual(completed);
        const savedTurn = restored.value.turns[0];
        if (!savedTurn) throw new Error("Missing saved Turn");
        const history = projectHistoricalTurn({
          turnId,
          cwd: home,
          snapshot: savedTurn,
        });
        expect(history).toMatchObject({
          items: expect.arrayContaining(
            completed.map((snapshot) =>
              expect.objectContaining({ id: snapshot.item.itemId, type: "commandExecution" }),
            ),
          ),
        });
        expect(
          observed.some(
            (event) =>
              event.type === "item.started" &&
              (event.item.type === "agentMessage" || event.item.type === "reasoning"),
          ),
        ).toBe(false);
      },
    );
  });
});
