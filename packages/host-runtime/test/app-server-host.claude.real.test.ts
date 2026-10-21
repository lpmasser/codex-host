import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { MappingStore } from "@codexhost/mapping-store";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  type ExternalHarnessId,
  type JsonObject,
} from "@codexhost/protocol-core";

import { AppServerHost } from "../src/index.js";

type ClaudeAdapterDependencies = NonNullable<ConstructorParameters<typeof ClaudeCodeAdapter>[1]>;
type ClaudeNativeHandler = Parameters<
  ReturnType<ClaudeAdapterDependencies["createTransport"]>["setEventHandler"]
>[0];
type ClaudeNativeEvent = Parameters<ClaudeNativeHandler>[0];

const RUN_REAL = process.env.CODEXHOST_RUN_CLAUDE_HOST_REAL === "1";
const REAL_TIMEOUT_MS = 180_000;

class OfficialProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdin.once("finish", () => {
      this.exitCode = 0;
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", 0, null);
    });
  }

  kill(): boolean {
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0, null);
    return true;
  }
}

class JsonCollector {
  readonly messages: JsonObject[] = [];
  readonly #waiters: Array<{
    predicate: (message: JsonObject) => boolean;
    resolve(message: JsonObject): void;
  }> = [];
  #buffer = "";

  constructor(stream: PassThrough) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as JsonObject;
        this.messages.push(message);
        for (const waiter of [...this.#waiters]) {
          if (!waiter.predicate(message)) continue;
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
  }

  waitFor(predicate: (message: JsonObject) => boolean): Promise<JsonObject> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return Promise.race([
      new Promise<JsonObject>((resolve) => this.#waiters.push({ predicate, resolve })),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Timed out waiting for real Claude Host output")),
          120_000,
        ),
      ),
    ]);
  }
}

function requestId(message: JsonObject, id: number): boolean {
  return message.id === id;
}

function method(message: JsonObject, name: string): boolean {
  return message.method === name;
}

function writeRequest(input: PassThrough, request: JsonObject): void {
  input.write(`${JSON.stringify(request)}\n`);
}

describe("AppServerHost hermetic Claude projection", () => {
  it("keeps native Turn ownership through pending input, autonomous execution, history and cancellation", async () => {
    const mappingStoreDirectory = await fs.mkdtemp(
      path.join(tmpdir(), "codexhost-host-claude-hermetic-"),
    );
    let uuid = 0;
    let nativeSessionId: string | undefined;
    let nativeTurnKey: string | undefined;
    let nativeHandler: ClaudeNativeHandler = () => undefined;
    let nativeFault: (error: unknown) => void = () => undefined;
    let deferredInput: string | undefined;
    let steeredInput: string | undefined;
    let deferInput = false;
    let nativeRunning = false;
    const laterHistory: unknown[] = [];
    const dependencies: ClaudeAdapterDependencies = {
      randomUUID: () => `claude-hermetic-${++uuid}`,
      bypassPermissionsAvailable: () => true,
      inspectInstallation: () => undefined,
      createInspector: () => ({
        inspect: async () => ({
          models: [{ value: "default", displayName: "Default" }],
          canSelectModel: true,
          canSelectPermissionMode: true,
        }),
        close: async () => undefined,
      }),
      deleteSession: async () => undefined,
      forkSession: async () => ({ sessionId: "claude-hermetic-derived" }),
      getSessionInfo: async () => ({ cwd: "/synthetic" }),
      readSessionMessages: async ({ sessionId }) => {
        if (sessionId !== nativeSessionId || !nativeTurnKey) return [];
        return [
          {
            type: "user",
            uuid: nativeTurnKey,
            session_id: sessionId,
            message: { role: "user", content: "hermetic prompt" },
          },
          {
            type: "assistant",
            uuid: "claude-hermetic-assistant",
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hermetic response" }],
              stop_reason: "end_turn",
            },
          },
          ...laterHistory,
        ];
      },
      readSubagentMessages: async () => [],
      createTransport: (input) => {
        nativeSessionId = input.sessionId;
        nativeFault = input.onFault;
        let permissionMode = input.permissionMode;
        let handler: ClaudeNativeHandler = () => undefined;
        let ordinal = 0;
        return {
          sessionId: input.sessionId,
          setEventHandler: (next) => {
            handler = (event) => {
              if (event.type === "activity.changed") nativeRunning = event.activity !== "idle";
              return next(event);
            };
            nativeHandler = handler;
          },
          cancelInput: async (messageId) => {
            await handler({ type: "input.terminated", messageId, state: "cancelled" });
            return true;
          },
          hasBackgroundTasks: () => false,
          stopBackgroundTask: async () => undefined,
          isRunning: () => nativeRunning,
          stopTasks: async () => undefined,
          start: async () => undefined,
          getContextUsage: async () => ({
            usedTokens: 30,
            maxTokens: 200,
            model: "hermetic-model",
          }),
          getPermissionMode: () => permissionMode,
          setModel: async () => undefined,
          setThinkingOption: async () => undefined,
          setPermissionMode: async (mode) => {
            permissionMode = mode;
          },
          submitInput: async (_text, userMessageId, priority) => {
            if (priority === "next") {
              steeredInput = userMessageId;
              return;
            }
            if (deferInput) {
              deferredInput = userMessageId;
              return;
            }
            const segmentId = ++ordinal;
            await handler({ type: "segment.started", segmentId, inputIds: [userMessageId] });
            const onEvent = (
              event: Extract<ClaudeNativeEvent, { type: "segment.event" }>["event"],
            ) => handler({ type: "segment.event", segmentId, event });
            nativeTurnKey = userMessageId;
            onEvent({
              type: "text.delta",
              messageId: "hermetic-assistant",
              delta: "hermetic response",
            });
            onEvent({
              type: "message.completed",
              messageId: "hermetic-assistant",
              checkpointId: "claude-hermetic-assistant",
            });
            await handler({
              type: "segment.completed",
              segmentId,
              result: { status: "succeeded" },
            });
          },
          respondToInteraction: async () => undefined,
          abort: async () => ({ stillQueued: [] }),
          close: async () => undefined,
        };
      },
    };
    const desktopInput = new PassThrough();
    const desktopOutput = new PassThrough();
    const diagnosticOutput = new PassThrough();
    const collector = new JsonCollector(desktopOutput);
    const official = new OfficialProcess();
    const claudeAdapter = new ClaudeCodeAdapter({ closeTimeoutMs: 50 }, dependencies);
    const mappingStore = new MappingStore({ directory: mappingStoreDirectory });
    const host = new AppServerHost({
      stockCodexPath: "/synthetic/codex",
      arguments: [],
      desktopInput,
      desktopOutput,
      diagnosticOutput,
      environment: { CODEXHOST_DATA_DIR: mappingStoreDirectory },
      externalAdapters: new Map([["claude-code", claudeAdapter]]),
      mappingStore,
      spawnOfficial: (() =>
        official as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn,
    });
    const running = host.run();

    try {
      writeRequest(desktopInput, {
        id: 1,
        method: "thread/start",
        params: { model: CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, cwd: "/synthetic" },
      });
      const startResponse = await collector.waitFor((message) => requestId(message, 1));
      const threadId = ((startResponse.result as JsonObject).thread as JsonObject).id;
      if (typeof threadId !== "string") throw new Error("Host returned no Thread ID");

      writeRequest(desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "hermetic prompt" }] },
      });
      await collector.waitFor((message) => requestId(message, 2));
      const completed = await collector.waitFor((message) => method(message, "turn/completed"));

      expect(JSON.stringify(completed)).not.toContain(
        "External Turn identity could not be persisted",
      );
      expect(completed).toMatchObject({ params: { turn: { status: "completed" } } });
      await expect(
        mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
      ).resolves.toMatchObject({
        turnMappings: [
          {
            nativeTurnRef: {
              harnessId: "claude-code",
              nativeSessionId,
              nativeTurnKey,
            },
            nativeCheckpointRef: {
              harnessId: "claude-code",
              nativeSessionId,
              checkpointId: "claude-hermetic-assistant",
            },
          },
        ],
      });

      writeRequest(desktopInput, {
        id: 3,
        method: "thread/read",
        params: { threadId, includeTurns: true },
      });
      await expect(collector.waitFor((message) => requestId(message, 3))).resolves.toMatchObject({
        result: {
          thread: {
            id: threadId,
            turns: [
              {
                status: "completed",
                items: [
                  { type: "userMessage", content: [{ type: "text", text: "hermetic prompt" }] },
                  { type: "agentMessage", text: "hermetic response" },
                ],
              },
            ],
          },
        },
      });

      // A background Agent keeps the Session running after its parent Turn completes.
      // That activity must not reserve the next foreground input slot.
      await nativeHandler({ type: "activity.changed", activity: "running" });
      await collector.waitFor(
        (m) =>
          method(m, "thread/status/changed") &&
          ((m.params as JsonObject).status as JsonObject).type === "active",
      );
      // B is accepted while an earlier native continuation has not yet reached the Host.
      deferInput = true;
      writeRequest(desktopInput, {
        id: 4,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "input B" }] },
      });
      const pending = await collector.waitFor((message) => requestId(message, 4));
      expect(pending.error).toBeUndefined();
      const pendingId = ((pending.result as JsonObject).turn as JsonObject).id;
      expect(deferredInput).toBeDefined();
      expect(
        collector.messages.some(
          (m) =>
            method(m, "turn/started") &&
            (m.params as JsonObject).turn &&
            ((m.params as JsonObject).turn as JsonObject).id === pendingId,
        ),
      ).toBe(false);
      const user = (id: string, text: string, autonomous = false) => ({
        type: "user",
        uuid: id,
        session_id: nativeSessionId,
        ...(autonomous ? { origin: { kind: "task-notification" } } : {}),
        message: { role: "user", content: text },
      });
      const reply = (id: string, text: string) => ({
        type: "assistant",
        uuid: id,
        session_id: nativeSessionId,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      const emitReply = async (segmentId: number, id: string, text: string) => {
        await nativeHandler({
          type: "segment.event",
          segmentId,
          event: { type: "text.delta", messageId: id, delta: text },
        });
        await nativeHandler({
          type: "segment.event",
          segmentId,
          event: { type: "message.completed", messageId: id, checkpointId: id },
        });
        await nativeHandler({
          type: "segment.completed",
          segmentId,
          result: { status: "succeeded" },
        });
      };
      laterHistory.push(
        user("notification-A", "notification", true),
        reply("reply-A", "earlier A"),
      );
      await nativeHandler({ type: "activity.changed", activity: "running" });
      await nativeHandler({ type: "segment.started", segmentId: 2, inputIds: [] });
      await nativeHandler({
        type: "segment.event",
        segmentId: 2,
        event: { type: "text.delta", messageId: "reply-A", delta: "earlier A" },
      });
      const startedA = await collector.waitFor(
        (m) =>
          method(m, "turn/started") &&
          ((m.params as JsonObject).turn as JsonObject).id !==
            ((completed.params as JsonObject).turn as JsonObject).id,
      );
      const activeA = ((startedA.params as JsonObject).turn as JsonObject).id;
      if (typeof activeA !== "string") throw new Error("No autonomous Turn ID");
      writeRequest(desktopInput, {
        id: 8,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: activeA,
          clientUserMessageId: "client-steer",
          input: [{ type: "text", text: "adjust A" }],
        },
      });
      expect((await collector.waitFor((m) => requestId(m, 8))).error).toBeUndefined();
      expect(
        collector.messages.some(
          (m) => method(m, "item/completed") && JSON.stringify(m).includes("client-steer"),
        ),
      ).toBe(false);
      await nativeHandler({
        type: "input.started",
        segmentId: 2,
        messageId: steeredInput as string,
      });
      const applied = await collector.waitFor(
        (m) => method(m, "item/completed") && JSON.stringify(m).includes("client-steer"),
      );
      expect((applied.params as JsonObject).turnId).toBe(activeA);
      expect(
        collector.messages.filter(
          (m) => method(m, "item/completed") && JSON.stringify(m).includes("client-steer"),
        ),
      ).toHaveLength(1);
      laterHistory.push({
        type: "attachment",
        uuid: "queued-attachment",
        session_id: nativeSessionId,
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          source_uuid: steeredInput,
          prompt: "adjust A",
        },
      });
      await nativeHandler({
        type: "segment.event",
        segmentId: 2,
        event: { type: "message.completed", messageId: "reply-A", checkpointId: "reply-A" },
      });
      await nativeHandler({
        type: "segment.completed",
        segmentId: 2,
        result: { status: "succeeded" },
      });
      const completedA = await collector.waitFor(
        (m) => method(m, "turn/completed") && JSON.stringify(m).includes("earlier A"),
      );
      const turnA = (completedA.params as JsonObject).turn as JsonObject;
      expect(turnA.id).not.toBe(pendingId);
      laterHistory.push(user(deferredInput as string, "input B"), reply("reply-B", "reply to B"));
      await nativeHandler({
        type: "segment.started",
        segmentId: 3,
        inputIds: [deferredInput as string],
      });
      await emitReply(3, "reply-B", "reply to B");
      await nativeHandler({ type: "activity.changed", activity: "idle" });
      const completedB = await collector.waitFor(
        (m) =>
          method(m, "turn/completed") &&
          ((m.params as JsonObject).turn as JsonObject).id === pendingId,
      );
      expect(JSON.stringify(completedB)).toContain("reply to B");
      expect(JSON.stringify(completedB)).not.toContain("earlier A");
      const mapped = await mappingStore.getThread(hostThreadIdSchema.parse(threadId));
      expect(mapped?.turnMappings).toHaveLength(3);
      writeRequest(desktopInput, {
        id: 5,
        method: "thread/read",
        params: { threadId, includeTurns: true },
      });
      const reread = await collector.waitFor((m) => requestId(m, 5));
      const turns = ((reread.result as JsonObject).thread as JsonObject).turns as JsonObject[];
      expect(turns.map((t) => t.id)).toEqual([
        ((completed.params as JsonObject).turn as JsonObject).id,
        turnA.id,
        pendingId,
      ]);
      expect(JSON.stringify(turns[1])).toContain("earlier A");
      expect(JSON.stringify(turns[1])).toContain("adjust A");
      expect(JSON.stringify(turns[2])).not.toContain("earlier A");

      writeRequest(desktopInput, {
        id: 6,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "withdraw before start" }] },
      });
      const submitted = await collector.waitFor((m) => requestId(m, 6));
      const withdrawnId = ((submitted.result as JsonObject).turn as JsonObject).id;
      if (typeof withdrawnId !== "string") throw new Error("No pending Turn ID");
      writeRequest(desktopInput, {
        id: 7,
        method: "turn/interrupt",
        params: { threadId, turnId: withdrawnId },
      });
      expect((await collector.waitFor((m) => requestId(m, 7))).error).toBeUndefined();
      const withdrawn = await collector.waitFor(
        (m) =>
          method(m, "turn/completed") &&
          ((m.params as JsonObject).turn as JsonObject).id === withdrawnId,
      );
      expect(withdrawn).toMatchObject({ params: { turn: { status: "interrupted" } } });
      expect(
        collector.messages.some(
          (m) =>
            method(m, "turn/started") &&
            ((m.params as JsonObject).turn as JsonObject).id === withdrawnId,
        ),
      ).toBe(false);
      const beforeFault = collector.messages.length;
      await nativeHandler({ type: "activity.changed", activity: "running" });
      nativeFault(new Error("synthetic native failure after a Turn"));
      await collector.waitFor(
        (m) =>
          collector.messages.indexOf(m) >= beforeFault &&
          method(m, "thread/status/changed") &&
          ((m.params as JsonObject).status as JsonObject).type === "idle",
      );
    } finally {
      desktopInput.end();
      await running;
      await claudeAdapter.close();
      await fs.rm(mappingStoreDirectory, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!RUN_REAL)("AppServerHost real Claude projection", () => {
  it(
    "projects one real Claude text Turn through the registered external Harness path",
    async () => {
      const workspace = path.resolve(".codexhost", "claude-host-real", "workspace");
      await fs.mkdir(workspace, { recursive: true });
      const prompt = "Reply with exactly CODEXHOST_CLAUDE_HOST_OK.";
      await fs.writeFile(path.join(workspace, "prompt.local.txt"), `${prompt}\n`, "utf8");

      const desktopInput = new PassThrough();
      const desktopOutput = new PassThrough();
      const diagnosticOutput = new PassThrough();
      const collector = new JsonCollector(desktopOutput);
      const official = new OfficialProcess();
      const claudeAdapter = new ClaudeCodeAdapter({ closeTimeoutMs: 10_000 });
      const externalAdapters = new Map<ExternalHarnessId, ClaudeCodeAdapter>([
        ["claude-code", claudeAdapter],
      ]);
      const host = new AppServerHost({
        stockCodexPath: "/synthetic/codex",
        arguments: [],
        desktopInput,
        desktopOutput,
        diagnosticOutput,
        externalAdapters,
        spawnOfficial: (() =>
          official as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn,
      });
      const running = host.run();

      try {
        writeRequest(desktopInput, {
          id: 1,
          method: "thread/start",
          params: { model: CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, cwd: workspace },
        });
        const startResponse = await collector.waitFor((message) => requestId(message, 1));
        const result = startResponse.result as JsonObject;
        const thread = result.thread as JsonObject;
        expect(result.model).toBe(CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID);
        const threadId = thread.id;
        if (typeof threadId !== "string") throw new Error("Host returned no Thread ID");

        writeRequest(desktopInput, {
          id: 2,
          method: "turn/start",
          params: { threadId, input: [{ type: "text", text: prompt }] },
        });
        await collector.waitFor((message) => requestId(message, 2));
        await expect(
          collector.waitFor((message) => method(message, "item/agentMessage/delta")),
        ).resolves.toMatchObject({ params: { delta: expect.any(String) } });
        await expect(
          collector.waitFor((message) => method(message, "turn/completed")),
        ).resolves.toMatchObject({ params: { turn: { status: "completed" } } });

        const responseIndex = collector.messages.findIndex((message) => requestId(message, 2));
        const turnStartedIndex = collector.messages.findIndex((message) =>
          method(message, "turn/started"),
        );
        expect(turnStartedIndex).toBeGreaterThan(responseIndex);
      } finally {
        desktopInput.end();
        await running;
        await claudeAdapter.close();
      }
    },
    REAL_TIMEOUT_MS,
  );
});
