import path from "node:path";
import type * as FsPromises from "node:fs/promises";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";

import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from "../src/index.js";
import { projectClaudePlanLimitToCredits } from "../src/claude-code-adapter.js";
import { ClaudeCodeExecutableError } from "../src/command.js";
import { ClaudeUltracodeUnavailableError } from "../src/ultracode.js";
import { CLAUDE_DEFAULT_MODEL_REF, encodeClaudeModelRef } from "../src/model-catalog.js";
import {
  claudeBypassPermissionsAvailable,
  type ClaudePermissionMode,
} from "../src/permission-modes.js";
import {
  type ClaudeAdapterDependencies,
  type ClaudeApprovalRequest,
  type ClaudeInteractionResponse,
  type ClaudePlanLimitEvent,
  type ClaudeQuestionRequest,
  type ClaudeTransportContextUsage,
  type ClaudeTransportTurnResult,
  type ClaudeTurnEvent,
  type ClaudeSessionEvent,
  type ClaudeTurnTransport,
} from "../src/transport.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, open: vi.fn(actual.open) };
});

class FakeClaudeTransport implements ClaudeTurnTransport {
  handler: (event: ClaudeSessionEvent) => void | Promise<void> = () => undefined;
  setEventHandler(handler: (event: ClaudeSessionEvent) => void | Promise<void>): void {
    this.handler = handler;
  }
  readonly backgroundTaskIds = new Set<string>();
  readonly stopBackgroundTaskCalls: string[] = [];
  hasBackgroundTasks(): boolean {
    return this.backgroundTaskIds.size > 0;
  }
  async stopBackgroundTask(id: string): Promise<void> {
    this.stopBackgroundTaskCalls.push(id);
  }
  readonly stopTasks = vi.fn(async (taskIds: readonly string[]): Promise<void> => {
    for (const taskId of taskIds) this.backgroundTaskIds.delete(taskId);
  });
  segmentId = 0;
  running = false;
  activeSegment: number | undefined;
  #assistantMessageId: string | null = null;
  readonly abort = vi.fn(async () => ({ stillQueued: [] as string[] }));
  readonly close = vi.fn(async () => undefined);
  readonly start = vi.fn(async () => undefined);
  readonly cancelInput = vi.fn(async (messageId: string) => {
    await this.handler({ type: "input.cancelled", messageId });
    return true;
  });
  contextUsage: ClaudeTransportContextUsage | null = null;
  readonly getContextUsage = vi.fn(async () => this.contextUsage);
  readonly setModel = vi.fn(async () => undefined);
  readonly setThinkingOption = vi.fn(async () => undefined);
  readonly getPermissionMode = vi.fn(() => this.permissionMode);
  readonly setPermissionMode = vi.fn(async (mode: ClaudePermissionMode) => {
    this.permissionMode = mode;
  });
  readonly respondToInteraction = vi.fn(async (response: ClaudeInteractionResponse) => {
    this.event({
      type: "interaction.closed",
      requestId: response.requestId,
      reason: "cancelled" in response ? "cancelled" : "responded",
    });
  });
  readonly compactCalls: Array<{ userMessageId: string; customInstructions: string | undefined }> =
    [];
  readonly initCalls: string[] = [];
  readonly recapCalls: string[] = [];
  readonly turns: Array<{ text: string; userMessageId: string }> = [];
  readonly steers: Array<{ text: string; messageId: string; priority: "next" }> = [];
  readonly pendingSteers = new Map<string, { resolve(): void; reject(error: Error): void }>();
  constructor(
    readonly sessionId: string,
    public permissionMode: ClaudePermissionMode,
    readonly onPermissionModeChanged: (mode: ClaudePermissionMode) => void,
    readonly onPlanLimit: (plan: ClaudePlanLimitEvent) => void,
    readonly onFault: (error: unknown) => void,
  ) {}
  changePermissionMode(mode: ClaudePermissionMode): void {
    this.permissionMode = mode;
    this.onPermissionModeChanged(mode);
  }
  planLimit(plan: ClaudePlanLimitEvent): void {
    this.onPlanLimit(plan);
  }
  isRunning(): boolean {
    return this.running || this.activeSegment !== undefined;
  }
  begin(inputIds: string[] = []): number {
    const id = ++this.segmentId;
    this.activeSegment = id;
    void this.handler({ type: "segment.started", segmentId: id, inputIds });
    return id;
  }
  submitInput(text: string, messageId: string, priority: "later" | "next"): Promise<void> {
    if (priority === "next") {
      this.steers.push({ text, messageId, priority });
      return new Promise((resolve, reject) => {
        this.pendingSteers.set(messageId, { resolve, reject });
      });
    }
    if (text.startsWith("/compact"))
      this.compactCalls.push({
        userMessageId: messageId,
        customInstructions: text.slice(9) || undefined,
      });
    else if (text === "/init") this.initCalls.push(messageId);
    else if (text === "/recap") this.recapCalls.push(messageId);
    else this.turns.push({ text, userMessageId: messageId });
    this.#assistantMessageId = null;
    this.begin([messageId]);
    return Promise.resolve();
  }
  recordSteer(messageId: string): void {
    const pending = this.pendingSteers.get(messageId);
    if (!pending) throw new Error("No queued steer");
    this.pendingSteers.delete(messageId);
    pending.resolve();
    if (this.activeSegment === undefined) this.begin([messageId]);
    else void this.handler({ type: "input.started", segmentId: this.activeSegment, messageId });
  }
  beginContinuation = (nativeTurnKey?: string) => {
    const id = this.begin(nativeTurnKey ? [nativeTurnKey] : []);
    return {
      onEvent: (event: ClaudeTurnEvent) => this.event(event),
      onTerminal: async (result: ClaudeTransportTurnResult) => {
        this.activeSegment = undefined;
        await this.handler({ type: "segment.completed", segmentId: id, result });
      },
    };
  };
  async emitAutonomousTurn(turn: {
    nativeTurnKey?: string;
    events: ClaudeTurnEvent[];
    result: ClaudeTransportTurnResult;
  }): Promise<void> {
    const observer = this.beginContinuation(turn.nativeTurnKey);
    for (const event of turn.events) this.event(event);
    await observer.onTerminal(turn.result);
  }
  autonomousTurnHandler = (turn: {
    nativeTurnKey?: string;
    events: ClaudeTurnEvent[];
    result: ClaudeTransportTurnResult;
  }): void => {
    void this.emitAutonomousTurn(turn);
  };
  event(event: ClaudeTurnEvent): void {
    if (
      event.type === "subagent.settled" ||
      event.type === "subagents.live" ||
      event.type === "workflow.updated" ||
      event.type === "workflow.activity" ||
      event.type === "usage.request"
    ) {
      this.threadEvent(event);
      return;
    }
    if (event.type === "segment.started") {
      if (this.activeSegment === undefined) this.begin();
      return;
    }
    const id = this.activeSegment ?? this.begin();
    void this.handler({ type: "segment.event", segmentId: id, event });
  }
  threadEvent(event: ClaudeTurnEvent): void {
    void this.handler({ type: "thread.event", event });
  }
  approval(request: ClaudeApprovalRequest): void {
    this.event({ type: "interaction.requested", request });
  }
  question(request: ClaudeQuestionRequest): void {
    this.event({ type: "interaction.requested", request });
  }
  delta(text: string, messageId = this.#assistantMessageId ?? "synthetic-assistant"): void {
    this.#assistantMessageId = messageId;
    this.event({ type: "text.delta", messageId, delta: text });
  }
  reasoning(messageId: string, delta: string): void {
    this.#assistantMessageId = messageId;
    this.event({ type: "reasoning.delta", messageId, delta });
  }
  completeReasoning(messageId: string): void {
    this.event({ type: "reasoning.completed", messageId });
  }
  finish(result: ClaudeTransportTurnResult): void {
    if (this.activeSegment === undefined) throw new Error("No active native segment");
    const id = this.activeSegment;
    this.activeSegment = undefined;
    this.#assistantMessageId = null;
    void this.handler({ type: "segment.completed", segmentId: id, result });
  }
  fault(error: unknown): void {
    this.activeSegment = undefined;
    this.onFault(error);
  }
}

function fixture(
  options: ClaudeCodeAdapterOptions = {},
  { bypassPermissionsAvailable = true }: { bypassPermissionsAvailable?: boolean } = {},
) {
  const history: unknown[] = [];
  const transports: FakeClaudeTransport[] = [];
  const inspectors: Array<{
    close: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
  }> = [];
  const inspectInstallation = vi.fn();
  let uuid = 0;
  const dependencies: ClaudeAdapterDependencies = {
    randomUUID: () => `claude-id-${++uuid}`,
    bypassPermissionsAvailable: vi.fn(() => bypassPermissionsAvailable),
    inspectInstallation,
    createInspector: vi.fn(() => {
      const inspector = {
        close: vi.fn(async () => undefined),
        inspect: vi.fn(async () => ({
          models: [
            {
              value: "default",
              displayName: "Default",
              description: "ignored",
              resolvedModel: "runtime-default",
              supportsAutoMode: true,
            },
            {
              value: "sonnet",
              displayName: "Family alias",
              description: "ignored",
              resolvedModel: "runtime-custom",
              supportedEffortLevels: ["low", "adaptive-v2", "high"],
            },
          ],
          canSelectModel: true,
          canSelectPermissionMode: true,
        })),
      };
      inspectors.push(inspector);
      return inspector;
    }),
    deleteSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => ({ sessionId: "derived-session" })),
    getSessionInfo: vi.fn(async () => ({ cwd: "/synthetic" })),
    readSessionMessages: vi.fn(async () => structuredClone(history)),
    readSubagentMessages: vi.fn(async () => []),
    createTransport: vi.fn((input) => {
      const transport = new FakeClaudeTransport(
        input.sessionId,
        input.permissionMode,
        input.onPermissionModeChanged,
        input.onPlanLimit,
        input.onFault,
      );
      transports.push(transport);
      return transport;
    }),
  };
  const adapter = new ClaudeCodeAdapter(
    { closeTimeoutMs: 50, cancelTimeoutMs: 5_000, ...options },
    dependencies,
  );
  return { adapter, dependencies, history, inspectors, inspectInstallation, transports };
}

async function openSession(
  adapter: ClaudeCodeAdapter,
  environment?: NodeJS.ProcessEnv,
): Promise<HarnessSession> {
  const opened = await adapter.open({
    kind: "create",
    cwd: "/synthetic",
    ...(environment ? { environment } : {}),
  });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function textTurn(id: string) {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(id),
    input: [{ type: "text" as const, text: id }],
  };
}

/** Lifecycle assertions skip Host usage metering events, which have their own tests. */
async function nextOutput(iterator: AsyncIterator<HarnessOutput>) {
  for (;;) {
    const output = await iterator.next();
    if (
      output.done ||
      output.value.kind !== "event" ||
      (output.value.event.type !== "usage.request" && output.value.event.type !== "usage.history")
    ) {
      return output;
    }
  }
}

function hasUserMessageItem(output: HarnessOutput): boolean {
  if (output.kind !== "event") return false;
  if (output.event.type === "item.started") return output.event.item.type === "userMessage";
  if (output.event.type === "item.completed")
    return output.event.snapshot.item.type === "userMessage";
  return false;
}

async function nextEvent(iterator: AsyncIterator<HarnessOutput>) {
  const output = await nextOutput(iterator);
  if (output.done) throw new Error("Harness output ended unexpectedly");
  if (output.value.kind !== "event") throw new Error("Expected a Harness event output");
  return output.value.event;
}

async function nextInteraction(iterator: AsyncIterator<HarnessOutput>) {
  const output = await nextOutput(iterator);
  if (output.done) throw new Error("Harness output ended unexpectedly");
  if (output.value.kind !== "interaction") throw new Error("Expected a Harness Interaction");
  return output.value.interaction;
}

describe("Claude Code usage metering", () => {
  const usage = {
    input_tokens: 10,
    cache_creation_input_tokens: 8643,
    cache_read_input_tokens: 21000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 8643 },
    output_tokens: 247,
  };

  it.each([false, true])(
    "distinguishes a missing transcript from an empty one (exists: %s)",
    async (exists) => {
      const directory = await mkdtemp(path.join(tmpdir(), "claude-metering-history-"));
      const adapter = new ClaudeCodeAdapter({ environment: { CLAUDE_CONFIG_DIR: directory } });
      try {
        if (exists) {
          const project = path.join(
            directory,
            "projects",
            directory.replace(/[^A-Za-z0-9]/gu, "-"),
          );
          await mkdir(project, { recursive: true });
          await writeFile(path.join(project, "source-session.jsonl"), "");
        }
        // Opening is lazy: exercise the real transcript reader without launching a model request.
        const opened = await adapter.open({
          kind: "resume",
          cwd: directory,
          nativeRef: nativeSessionRefSchema.parse({
            harnessId: "claude-code",
            nativeSessionId: "source-session",
            formatVersion: 1,
          }),
        });
        if (!opened.ok) throw new Error(opened.error.message);
        const iterator = opened.value.outputs[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toEqual({
          kind: "event",
          event: { type: "usage.history", complete: exists },
        });
      } finally {
        await adapter.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("replays the transcript on resume, then meters live requests", async () => {
    const { adapter, history, transports } = fixture();
    history.push(
      { type: "user", uuid: "u1", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        uuid: "a1",
        message: { id: "msg_old", model: "claude-opus-5-5", usage, content: [] },
      },
    );
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/synthetic",
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "claude-code",
        nativeSessionId: "source-session",
        formatVersion: 1,
      }),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const iterator = opened.value.outputs[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({
      kind: "event",
      event: {
        type: "usage.request",
        request: {
          requestId: "msg_old",
          historical: true,
          model: "claude-opus-5-5",
          inputTokens: 29653,
          cachedInputTokens: 21000,
          cacheWriteInputTokens: 8643,
          cacheWrite1hInputTokens: 8643,
          outputTokens: 247,
        },
      },
    });
    expect((await iterator.next()).value).toEqual({
      kind: "event",
      event: { type: "usage.history", complete: true },
    });

    await opened.value.execute(textTurn("turn-1"));
    const transport = transports[0];
    if (!transport) throw new Error("Claude transport was not created");
    const live = {
      requestId: "msg_live",
      model: "claude-opus-5-5",
      inputTokens: 5,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 3,
      startedAtMs: 10,
      completedAtMs: 20,
    };
    transport.event({ type: "usage.request", record: { kind: "request", request: live } });
    transport.event({ type: "usage.request", record: { kind: "missing" } });
    const metered = [];
    while (metered.length < 2) {
      const next = await iterator.next();
      if (next.done) throw new Error("Harness output ended unexpectedly");
      if (
        next.value.kind === "event" &&
        (next.value.event.type === "usage.request" || next.value.event.type === "usage.history")
      )
        metered.push(next.value.event);
    }
    expect(metered).toEqual([
      { type: "usage.request", request: live },
      { type: "usage.history", complete: false },
    ]);

    // A request settling while no Turn is active, such as a background continuation.
    transport.finish({ status: "succeeded" });
    const idle = { ...live, requestId: "msg_idle" };
    transport.threadEvent({
      type: "usage.request",
      record: { kind: "request", request: idle },
    });
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("Harness output ended unexpectedly");
      if (next.value.kind === "event" && next.value.event.type === "usage.request") {
        expect(next.value.event.request).toEqual(idle);
        break;
      }
    }
    await opened.value.close();
    await adapter.close();
  });
});

describe("projectClaudePlanLimitToCredits", () => {
  it("returns null when nothing has been observed", () => {
    expect(projectClaudePlanLimitToCredits(null)).toBeNull();
    expect(projectClaudePlanLimitToCredits({})).toBeNull();
  });

  it("leads with the five-hour window and folds the seven-day window into productUsage", () => {
    expect(
      projectClaudePlanLimitToCredits({
        fiveHour: { utilizationPercent: 62, resetsAtUnix: 1_756_130_400 },
        sevenDay: { utilizationPercent: 18, resetsAtUnix: 1_756_648_800 },
      }),
    ).toEqual({
      usedPercent: 62,
      periodType: "five_hour",
      resetsAt: new Date(1_756_130_400 * 1000).toISOString(),
      productUsage: [
        {
          product: "7-day window",
          periodType: "seven_day",
          usagePercent: 18,
          resetsAt: new Date(1_756_648_800 * 1000).toISOString(),
        },
      ],
    });
  });

  it("omits resetsAt and productUsage when neither is available", () => {
    expect(projectClaudePlanLimitToCredits({ fiveHour: { utilizationPercent: 8 } })).toEqual({
      usedPercent: 8,
      periodType: "five_hour",
    });
  });

  it("falls back to the seven-day window alone", () => {
    expect(
      projectClaudePlanLimitToCredits({
        sevenDay: { utilizationPercent: 41, resetsAtUnix: 1_756_648_800 },
      }),
    ).toEqual({
      usedPercent: 41,
      periodType: "seven_day",
      resetsAt: new Date(1_756_648_800 * 1000).toISOString(),
    });
  });
});

describe("Claude Code HarnessAdapter", () => {
  it("reports background work while its native process has background tasks", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    expect(session.hasBackgroundWork?.()).toBe(false);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("background-work"));
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.backgroundTaskIds.add("bash-task");
    expect(session.hasBackgroundWork?.()).toBe(true);
    transport.backgroundTaskIds.delete("bash-task");
    expect(session.hasBackgroundWork?.()).toBe(false);
    await session.close();
  });

  it("passes per-Session delegation environment to the SDK transport", async () => {
    const { adapter, dependencies } = fixture();
    const session = await openSession(adapter, {
      CODEXHOST_CLI_PATH: "/opt/codexhost",
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
      CODEXHOST_RUNTIME_TOKEN: "token",
      CODEXHOST_THREAD_ID: "thread-1",
    });
    await session.execute(textTurn("environment-turn"));
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          CODEXHOST_CLI_PATH: "/opt/codexhost",
          CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
          CODEXHOST_RUNTIME_TOKEN: "token",
          CODEXHOST_THREAD_ID: "thread-1",
        }),
      }),
    );
    await adapter.close();
  });
  it.each(["create", "resume"] as const)(
    "preserves native environment with scoped delegation on %s",
    async (kind) => {
      const nativeEnvironment = {
        HOME: "/native-user",
        PATH: "/usr/bin:/bin:/native-tools",
        HTTPS_PROXY: "http://127.0.0.1:2080",
        CLAUDE_CONFIG_DIR: "/native-user/claude-config",
      };
      const { adapter, dependencies } = fixture({ environment: nativeEnvironment });
      try {
        for (const threadId of ["first-thread", "second-thread"]) {
          const environment = {
            CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
            CODEXHOST_RUNTIME_TOKEN: `synthetic-${threadId}`,
            CODEXHOST_THREAD_ID: threadId,
          };
          const opened = await adapter.open({
            cwd: "/synthetic",
            environment,
            ...(kind === "resume"
              ? {
                  kind,
                  nativeRef: nativeSessionRefSchema.parse({
                    harnessId: "claude-code",
                    nativeSessionId: `native-${threadId}`,
                    formatVersion: 1,
                  }),
                }
              : { kind }),
          });
          if (!opened.ok) throw new Error(opened.error.message);
          await opened.value.execute(textTurn(`environment-${threadId}`));
          expect(dependencies.createTransport).toHaveBeenLastCalledWith(
            expect.objectContaining({ environment: { ...nativeEnvironment, ...environment } }),
          );
          expect(environment).not.toHaveProperty("HOME");
          await opened.value.close();
        }
        expect(nativeEnvironment).not.toHaveProperty("CODEXHOST_THREAD_ID");
      } finally {
        await adapter.close();
      }
    },
  );

  it.each(["create", "resume"] as const)(
    "uses the native sandbox declaration for scoped %s permission checks and transport",
    async (kind) => {
      const nativeEnvironment = { HOME: "/native-user", IS_SANDBOX: "1" };
      const scoped = { CODEXHOST_THREAD_ID: "root-caller" };
      const expected = { ...nativeEnvironment, ...scoped };
      const { adapter, dependencies } = fixture({ environment: nativeEnvironment });
      vi.spyOn(dependencies, "bypassPermissionsAvailable").mockImplementation((environment) =>
        claudeBypassPermissionsAvailable(environment ?? nativeEnvironment, { getuid: () => 0 }),
      );
      try {
        const opened = await adapter.open({
          cwd: "/synthetic",
          environment: scoped,
          permissionModeId: harnessPermissionModeIdSchema.parse("bypassPermissions"),
          ...(kind === "resume"
            ? {
                kind,
                nativeRef: nativeSessionRefSchema.parse({
                  harnessId: "claude-code",
                  nativeSessionId: "native-root",
                  formatVersion: 1,
                }),
              }
            : { kind }),
        });
        expect(opened.ok).toBe(true);
        if (!opened.ok) throw new Error(opened.error.message);
        await opened.value.execute(textTurn(`sandbox-${kind}`));
        expect(dependencies.bypassPermissionsAvailable).toHaveBeenLastCalledWith(expected);
        expect(dependencies.createTransport).toHaveBeenLastCalledWith(
          expect.objectContaining({
            environment: expected,
            permissionMode: "bypassPermissions",
          }),
        );
        await opened.value.close();
      } finally {
        await adapter.close();
      }
    },
  );

  it.each([false, true])(
    "still rejects root without an effective sandbox (explicit override=%s)",
    async (override) => {
      const nativeEnvironment = { HOME: "/native-user", ...(override ? { IS_SANDBOX: "1" } : {}) };
      const scoped = {
        CODEXHOST_THREAD_ID: "root-caller",
        ...(override ? { IS_SANDBOX: "0" } : {}),
      };
      const { adapter, dependencies } = fixture({ environment: nativeEnvironment });
      vi.spyOn(dependencies, "bypassPermissionsAvailable").mockImplementation((environment) =>
        claudeBypassPermissionsAvailable(environment ?? nativeEnvironment, { getuid: () => 0 }),
      );
      try {
        expect(
          await adapter.open({
            kind: "create",
            cwd: "/synthetic",
            environment: scoped,
            permissionModeId: harnessPermissionModeIdSchema.parse("bypassPermissions"),
          }),
        ).toMatchObject({ ok: false, error: { code: "unsupported" } });
        expect(dependencies.createTransport).not.toHaveBeenCalled();
      } finally {
        await adapter.close();
      }
    },
  );

  it("opens and closes unused Sessions without creating a Transport", async () => {
    const { adapter, dependencies } = fixture();
    const session = await openSession(adapter);
    const other = await openSession(adapter);

    expect(session.initialState.nativeRef).toBeUndefined();
    expect(session.nativeWriterRef).toEqual({
      harnessId: "claude-code",
      nativeSessionId: "claude-id-1",
      formatVersion: 1,
    });
    expect(other.nativeWriterRef?.nativeSessionId).not.toBe(
      session.nativeWriterRef?.nativeSessionId,
    );
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await session.close();
    await other.close();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("rolls back the last Turn through Claude's Native Fork", async () => {
    const { adapter, dependencies, history } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    history.push(
      {
        type: "user",
        uuid: "user-1",
        session_id: "source-session",
        message: { role: "user", content: "first" },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      },
      {
        type: "user",
        uuid: "user-2",
        session_id: "source-session",
        message: { role: "user", content: "second" },
      },
      {
        type: "assistant",
        uuid: "assistant-2",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      },
    );
    vi.mocked(dependencies.readSessionMessages).mockImplementation(async ({ sessionId }) =>
      sessionId === "derived-session"
        ? [
            {
              type: "user",
              uuid: "derived-user-1",
              session_id: "derived-session",
              message: { role: "user", content: "first" },
            },
            {
              type: "assistant",
              uuid: "derived-assistant-1",
              session_id: "derived-session",
              message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
            },
          ]
        : structuredClone(history),
    );

    const opened = await adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(dependencies.forkSession).toHaveBeenCalledWith({
      checkpointId: "assistant-1",
      cwd: path.resolve("/synthetic"),
      sourceSessionId: "source-session",
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{ nativeTurnRef: { nativeSessionId: "derived-session" } }] },
    });
    await opened.value.close();
    await adapter.close();
  });

  it("rejects an empty last-Turn rollback without creating a Transport", async () => {
    const { adapter, dependencies, transports } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });

    await expect(
      adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd: "/synthetic" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionNotFound" } });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    expect(transports).toHaveLength(0);
    await adapter.close();
  });

  it("inspects the runtime Model catalog and publishes Claude Code Thinking control", async () => {
    const { adapter, dependencies, inspectors } = fixture();

    const first = await adapter.inspect({ cwd: "/synthetic" });
    expect(first).toMatchObject({
      status: "ready",
      catalog: {
        models: [
          {
            ref: CLAUDE_DEFAULT_MODEL_REF,
            label: "Default",
            resolvedModelLabel: "runtime-default",
          },
          { label: "Family alias", resolvedModelLabel: "runtime-custom" },
        ],
        defaultModel: CLAUDE_DEFAULT_MODEL_REF,
        thinkingOptions: [
          { id: "off", label: "Off" },
          { id: "auto", label: "Auto" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
          { id: "ultracode", label: "Ultracode" },
        ],
        defaultThinkingOptionId: "auto",
      },
      permissionModes: {
        defaultModeId: "default",
        modes: [
          { id: "plan" },
          { id: "default" },
          { id: "acceptEdits" },
          { id: "auto" },
          { id: "bypassPermissions", dangerous: true },
        ],
      },
      capabilities: {
        configuration: {
          selectModel: true,
          selectThinkingOption: true,
          selectPermissionMode: true,
        },
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        subagents: { observe: true, readTranscript: true },
      },
    });
    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toEqual(first);
    expect(dependencies.inspectInstallation).toHaveBeenCalledOnce();
    expect(dependencies.createInspector).toHaveBeenCalledOnce();
    expect(inspectors[0]?.close).toHaveBeenCalledOnce();

    await adapter.inspect({ cwd: "/synthetic", refresh: true });
    expect(dependencies.createInspector).toHaveBeenCalledTimes(2);
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    const session = await openSession(adapter);
    expect(session.capabilities).toEqual({
      configuration: {
        selectModel: true,
        selectThinkingOption: true,
        selectPermissionMode: true,
        permissionModeScope: "live",
      },
      history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
      subagents: { observe: true, readTranscript: true },
      steer: true,
    });
    const iterator = session.outputs[Symbol.asyncIterator]();
    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: {
        effectiveThinkingOptionId: "high",
        availableThinkingOptions: [
          { id: "off" },
          { id: "auto" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          { id: "xhigh" },
          { id: "max" },
          { id: "ultracode" },
        ],
      },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    const configured = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model: encodeClaudeModelRef("sonnet"),
    });
    expect(configured.ok).toBe(true);
    if (configured.ok) await configured.value.close();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await session.close();
  });

  it("projects a steer in the Turn that consumes it", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const outputs: HarnessOutput[] = [];
    const consuming = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    const started = session.execute(textTurn("turn-1"));
    await vi.waitFor(() => expect(transports[0]?.turns).toHaveLength(1));
    await started;
    const steer = session.execute({
      type: "turn.steer",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "steer this" }],
    });
    await vi.waitFor(() => expect(transports[0]?.steers).toHaveLength(1));
    expect(transports[0]?.steers).toEqual([
      { text: "steer this", messageId: "claude-id-3", priority: "next" },
    ]);
    transports[0]?.recordSteer("claude-id-3");
    await expect(steer).resolves.toEqual({
      ok: true,
      value: { accepted: true, inputProjection: "adapter" },
    });
    await vi.waitFor(() => expect(outputs.filter(hasUserMessageItem)).toHaveLength(2));
    await expect(session.execute(textTurn("turn-2"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(transports[0]?.turns).toHaveLength(1);
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: hostTurnIdSchema.parse("turn-2"),
        input: [{ type: "text", text: "other" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: hostTurnIdSchema.parse("turn-1"),
        input: [{ type: "text", text: "" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(transports[0]?.steers).toHaveLength(1);
    const missed = session.execute({
      type: "turn.steer",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "late" }],
    });
    await vi.waitFor(() => expect(transports[0]?.steers).toHaveLength(2));
    transports[0]?.finish({ status: "succeeded" });
    const lateId = transports[0]?.steers[1]?.messageId;
    if (!lateId) throw new Error("No delayed input");
    transports[0]?.recordSteer(lateId);
    await expect(missed).resolves.toMatchObject({
      ok: true,
      value: { inputProjection: "adapter" },
    });
    transports[0]?.finish({ status: "succeeded" });
    await vi.waitFor(() =>
      expect(
        outputs.some((output) => output.kind === "event" && output.event.type === "turn.completed"),
      ).toBe(true),
    );
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: hostTurnIdSchema.parse("turn-1"),
        input: [{ type: "text", text: "idle" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    await session.close();
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: hostTurnIdSchema.parse("turn-1"),
        input: [{ type: "text", text: "closed" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(outputs.filter(hasUserMessageItem)).toHaveLength(4);
    const inputs = outputs.filter(
      (o) =>
        o.kind === "event" &&
        o.event.type === "item.started" &&
        o.event.item.type === "userMessage",
    );
    expect(
      new Set(
        inputs.map((o) => (o.kind === "event" && "turnId" in o.event ? o.event.turnId : null)),
      ).size,
    ).toBe(2);
    await consuming;
    await adapter.close();
  });

  it("omits Auto when no runtime Model explicitly supports it", async () => {
    const { adapter, dependencies } = fixture();
    vi.mocked(dependencies.createInspector).mockReturnValueOnce({
      inspect: vi.fn(async () => ({
        models: [{ value: "default", displayName: "Custom Model" }],
        canSelectModel: true,
        canSelectPermissionMode: true,
      })),
      close: vi.fn(async () => undefined),
    });

    await expect(adapter.inspect({ cwd: "/no-auto" })).resolves.toMatchObject({
      status: "ready",
      permissionModes: {
        defaultModeId: "default",
        modes: [
          { id: "plan" },
          { id: "default" },
          { id: "acceptEdits" },
          { id: "bypassPermissions" },
        ],
      },
      capabilities: { configuration: { selectPermissionMode: true } },
    });
  });

  it("coalesces concurrent inspection and does not cache failures or unsupported capability", async () => {
    const { adapter, dependencies } = fixture();
    const pending = deferred<{
      models: unknown[];
      canSelectModel: boolean;
      canSelectPermissionMode: boolean;
    }>();
    const close = vi.fn(async () => undefined);
    vi.mocked(dependencies.createInspector)
      .mockReturnValueOnce({ inspect: () => pending.promise, close })
      .mockReturnValueOnce({
        inspect: async () => {
          throw new Error("synthetic startup failure");
        },
        close,
      })
      .mockReturnValueOnce({
        inspect: async () => ({
          models: [],
          canSelectModel: false,
          canSelectPermissionMode: false,
        }),
        close,
      })
      .mockReturnValueOnce({
        inspect: async () => ({
          models: [],
          canSelectModel: false,
          canSelectPermissionMode: false,
        }),
        close,
      });

    const first = adapter.inspect({ cwd: "/coalesced" });
    const second = adapter.inspect({ cwd: "/coalesced" });
    expect(dependencies.createInspector).toHaveBeenCalledOnce();
    pending.resolve({
      models: [{ value: "default", displayName: "Default" }],
      canSelectModel: true,
      canSelectPermissionMode: true,
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    await expect(adapter.inspect({ cwd: "/failure" })).resolves.toMatchObject({
      status: "error",
    });
    await expect(adapter.inspect({ cwd: "/failure" })).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "unavailable", retryable: false },
    });
    await expect(adapter.inspect({ cwd: "/unsupported" })).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "unavailable", retryable: false },
    });
    expect(dependencies.createInspector).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledTimes(4);
  });

  it("reports a missing installation without starting a Transport", async () => {
    const { adapter, dependencies, inspectInstallation } = fixture();
    inspectInstallation.mockImplementationOnce(() => {
      throw new ClaudeCodeExecutableError("Claude Code is not installed");
    });

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled", retryable: false },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("restores a Subagent prompt from Parent history when native Child history omits it", async () => {
    const { adapter, dependencies, history } = fixture();
    history.push(
      {
        type: "assistant",
        uuid: "root-agent",
        session_id: "source-session",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "agent-call",
              name: "Agent",
              input: { prompt: "inspect files", description: "Inspect files" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "root-agent-result",
        session_id: "source-session",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "agent-call",
              content: "done\nagentId: native-agent-1 (use SendMessage to continue)",
            },
          ],
        },
      },
    );
    vi.mocked(dependencies.readSubagentMessages).mockResolvedValueOnce([
      {
        type: "assistant",
        uuid: "subagent-answer",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "Inspection done" }] },
      },
    ]);

    await expect(
      adapter.subagents.readSnapshot({
        parent: nativeSessionRefSchema.parse({
          harnessId: "claude-code",
          nativeSessionId: "source-session",
          formatVersion: 1,
        }),
        nativeSubagentId: "native-agent-1",
        cwd: "/synthetic",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [{ type: "text", text: "inspect files" }],
            items: [{ item: { type: "agentMessage", text: "Inspection done" } }],
          },
        ],
      },
    });
    expect(dependencies.readSessionMessages).toHaveBeenCalledWith({
      cwd: "/synthetic",
      sessionId: "source-session",
    });
  });

  it("reads and resumes Native history without starting a Transport until the next Turn", async () => {
    const { adapter, dependencies, history, transports } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    history.push(
      {
        type: "user",
        uuid: "source-user",
        session_id: "source-session",
        message: { role: "user", content: "source prompt" },
      },
      {
        type: "assistant",
        uuid: "source-assistant",
        session_id: "source-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "source response" }],
          stop_reason: "end_turn",
        },
      },
    );

    const opened = await adapter.open({ kind: "resume", cwd: "/synthetic", nativeRef: sourceRef });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.initialState).toEqual({ nativeRef: sourceRef });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: { nativeTurnKey: "source-user" },
            input: [{ type: "text", text: "source prompt" }],
            items: [{ item: { type: "agentMessage", text: "source response" } }],
          },
        ],
      },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    const iterator = opened.value.outputs[Symbol.asyncIterator]();
    await expect(opened.value.execute(textTurn("continued"))).resolves.toMatchObject({ ok: true });
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: path.resolve("/synthetic"),
        sessionId: "source-session",
        openMode: "resume",
      }),
    );
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { nativeRef: sourceRef },
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await opened.value.close();
  });

  it("defers resumed Query startup until the next Turn and applies the final configuration", async () => {
    const { adapter, dependencies, transports } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "resume-for-selection",
      formatVersion: 1,
    });
    const opened = await adapter.open({ kind: "resume", cwd: "/synthetic", nativeRef: sourceRef });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const iterator = session.outputs[Symbol.asyncIterator]();
    const alias = encodeClaudeModelRef("sonnet");

    await expect(session.execute({ type: "model.select", model: alias })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { nativeRef: sourceRef, effectiveModel: alias },
    });
    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await nextEvent(iterator);
    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("auto"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await nextEvent(iterator);
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    await expect(session.execute(textTurn("configured-turn"))).resolves.toMatchObject({ ok: true });
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "sonnet",
        openMode: "resume",
        sessionId: "resume-for-selection",
        thinkingOptionId: "high",
        permissionMode: "auto",
      }),
    );
    expect(transports[0]?.setModel).not.toHaveBeenCalled();
    expect(transports[0]?.setThinkingOption).not.toHaveBeenCalled();
    expect(transports[0]?.setPermissionMode).not.toHaveBeenCalled();
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("forks an exact Native prefix while later source history continues", async () => {
    const { adapter, dependencies } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      checkpointId: "source-assistant-1",
      formatVersion: 1,
    });
    const histories = new Map<string, unknown[]>([
      [
        "source-session",
        [
          {
            type: "user",
            uuid: "source-user-1",
            session_id: "source-session",
            message: { role: "user", content: "first prompt" },
          },
          {
            type: "assistant",
            uuid: "source-assistant-1",
            session_id: "source-session",
            message: { role: "assistant", content: [{ type: "text", text: "first response" }] },
          },
          {
            type: "user",
            uuid: "source-user-2",
            session_id: "source-session",
            message: { role: "user", content: "second prompt" },
          },
          {
            type: "assistant",
            uuid: "source-assistant-2",
            session_id: "source-session",
            message: { role: "assistant", content: [{ type: "text", text: "second response" }] },
          },
        ],
      ],
    ]);
    vi.mocked(dependencies.readSessionMessages).mockImplementation(async ({ sessionId }) =>
      structuredClone(histories.get(sessionId) ?? []),
    );
    vi.mocked(dependencies.forkSession).mockImplementationOnce(async () => {
      histories.get("source-session")?.push(
        {
          type: "user",
          uuid: "source-user-3",
          session_id: "source-session",
          message: { role: "user", content: "active prompt" },
        },
        {
          type: "assistant",
          uuid: "source-assistant-3",
          session_id: "source-session",
          message: { role: "assistant", content: [{ type: "text", text: "active response" }] },
        },
      );
      histories.set("derived-session", [
        {
          type: "user",
          uuid: "derived-user-1",
          session_id: "derived-session",
          message: { role: "user", content: "first prompt" },
        },
        {
          type: "assistant",
          uuid: "derived-assistant-1",
          session_id: "derived-session",
          message: { role: "assistant", content: [{ type: "text", text: "first response" }] },
        },
      ]);
      return { sessionId: "derived-session" };
    });

    const opened = await adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.initialState).toMatchObject({
      nativeRef: { nativeSessionId: "derived-session" },
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: { nativeTurnKey: "derived-user-1" },
            checkpoint: { checkpointId: "derived-assistant-1" },
            input: [{ text: "first prompt" }],
          },
        ],
      },
    });
    expect(dependencies.forkSession).toHaveBeenCalledWith({
      checkpointId: "source-assistant-1",
      cwd: path.resolve("/synthetic"),
      sourceSessionId: "source-session",
    });
    expect(dependencies.deleteSession).not.toHaveBeenCalled();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await opened.value.close();
  });

  it("rejects missing resumed history and stale Fork Checkpoints without a Native Fork", async () => {
    const { adapter, dependencies, history } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      checkpointId: "stale-checkpoint",
      formatVersion: 1,
    });

    const resumed = await adapter.open({ kind: "resume", cwd: "/synthetic", nativeRef: sourceRef });
    if (!resumed.ok) throw new Error(resumed.error.message);
    await expect(resumed.value.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    const foreignCheckpoint = nativeCheckpointRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "other-session",
      checkpointId: "foreign-checkpoint",
      formatVersion: 1,
    });
    await expect(
      adapter.open({
        kind: "fork",
        cwd: "/synthetic",
        sourceRef,
        checkpoint: foreignCheckpoint,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    vi.mocked(dependencies.getSessionInfo).mockResolvedValueOnce({ cwd: "/other-workspace" });
    await expect(
      adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    history.push(
      {
        type: "user",
        uuid: "source-user",
        session_id: "source-session",
        message: { role: "user", content: "source prompt" },
      },
      {
        type: "assistant",
        uuid: "source-assistant",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "source response" }] },
      },
    );
    await expect(
      adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint }),
    ).resolves.toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(dependencies.forkSession).not.toHaveBeenCalled();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await resumed.value.close();
  });

  it("deletes a Native Fork whose remapped history is not the requested prefix", async () => {
    const { adapter, dependencies } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      checkpointId: "source-assistant",
      formatVersion: 1,
    });
    const sourceHistory = [
      {
        type: "user",
        uuid: "source-user",
        session_id: "source-session",
        message: { role: "user", content: "source prompt" },
      },
      {
        type: "assistant",
        uuid: "source-assistant",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "source response" }] },
      },
    ];
    const derivedHistory = [
      {
        type: "user",
        uuid: "derived-user",
        session_id: "derived-session",
        message: { role: "user", content: "wrong prompt" },
      },
      {
        type: "assistant",
        uuid: "derived-assistant",
        session_id: "derived-session",
        message: { role: "assistant", content: [{ type: "text", text: "wrong response" }] },
      },
    ];
    vi.mocked(dependencies.readSessionMessages).mockImplementation(async ({ sessionId }) =>
      structuredClone(sessionId === "derived-session" ? derivedHistory : sourceHistory),
    );

    await expect(
      adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint }),
    ).resolves.toMatchObject({ ok: false, error: { code: "protocolError" } });
    expect(dependencies.deleteSession).toHaveBeenCalledWith({
      cwd: path.resolve("/synthetic"),
      sessionId: "derived-session",
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("starts lazily and emits a complete text lifecycle", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(session.execute(textTurn("turn-1"))).resolves.toEqual({
      ok: true,
      value: { turnId: "turn-1" },
    });
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: CLAUDE_DEFAULT_MODEL_REF },
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.delta("hello");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "hello" },
    });
    transports[0]?.event({
      type: "message.completed",
      messageId: "synthetic-assistant",
      checkpointId: "native-assistant",
    });
    transports[0]?.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "hello" }, outcome: { status: "succeeded" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      nativeTurnRef: {
        harnessId: "claude-code",
        nativeSessionId: transports[0]?.sessionId,
        nativeTurnKey: transports[0]?.turns[0]?.userMessageId,
        formatVersion: 1,
      },
      outcome: {
        status: "succeeded",
        checkpoint: {
          harnessId: "claude-code",
          nativeSessionId: transports[0]?.sessionId,
          checkpointId: "native-assistant",
          formatVersion: 1,
        },
      },
    });
    await session.close();
  });

  it("exposes Claude compact as a command whose native events drive the standard UI lifecycle", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");

    await expect(commands.list()).resolves.toMatchObject({
      ok: true,
      value: {
        commands: [
          { id: "claude.compact", invocation: "/compact" },
          { id: "claude.init", invocation: "/init", argumentMode: "none" },
          { id: "claude.recap", invocation: "/recap", argumentMode: "none" },
        ],
      },
    });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("manual-compact"),
        commandId: "claude.compact",
        arguments: { text: "Keep implementation details" },
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: "manual-compact" } });

    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.started",
      turnId: "manual-compact",
    });
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.contextUsage = { usedTokens: 30, maxTokens: 200, model: "runtime-default" };
    transport.event({ type: "compaction.started" });
    const started = await nextEvent(iterator);
    if (started.type !== "item.started" || started.item.type !== "contextCompaction") {
      throw new Error("Manual compaction did not start a Context Compaction Item");
    }
    expect(started).toMatchObject({
      type: "item.started",
      turnId: "manual-compact",
      item: { type: "contextCompaction" },
    });
    transport.event({ type: "compaction.completed", outcome: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      turnId: "manual-compact",
      snapshot: {
        item: { type: "contextCompaction", itemId: started.item.itemId },
        outcome: { status: "succeeded" },
      },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.completed",
      turnId: "manual-compact",
      outcome: { status: "succeeded" },
    });
    expect(transport.compactCalls).toEqual([
      {
        userMessageId: expect.any(String),
        customInstructions: "Keep implementation details",
      },
    ]);
    expect(transport.turns).toEqual([]);
    await session.close();
  });

  it("validates Claude compact arguments and rejects it while busy", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");

    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("invalid-compact"),
        commandId: "claude.compact",
        arguments: { text: 1 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("unknown-argument"),
        commandId: "claude.compact",
        arguments: { text: "ok", extra: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("init-with-args"),
        commandId: "claude.init",
        arguments: { text: "nope" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("unknown-command"),
        commandId: "claude.unknown",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });

    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("busy"));
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("rejected-compact"),
        commandId: "claude.compact",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    transports[0]?.finish({ status: "succeeded" });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await session.close();
  });

  it("cancels a running Claude compact temporary Turn", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");
    const turnId = hostTurnIdSchema.parse("cancel-compact");

    await commands.execute({ turnId, commandId: "claude.compact" });
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toEqual({ type: "turn.started", turnId });
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({ type: "compaction.started" });
    await nextEvent(iterator);

    await expect(session.execute({ type: "turn.cancel", turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    transport.finish({ status: "cancelled", reason: "aborted_streaming" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "contextCompaction" },
        outcome: { status: "cancelled" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      turnId,
      outcome: { status: "cancelled" },
    });
    expect(transport.abort).toHaveBeenCalledOnce();
    await session.close();
  });

  it("runs Claude init as a command Turn that writes through native tools", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");
    const turnId = hostTurnIdSchema.parse("manual-init");

    await expect(commands.execute({ turnId, commandId: "claude.init" })).resolves.toEqual({
      ok: true,
      value: { turnId },
    });
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toEqual({ type: "turn.started", turnId });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      turnId,
      item: { type: "agentMessage", text: "" },
    });
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Created CLAUDE.md", "init-assistant");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Created CLAUDE.md" },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Created CLAUDE.md" } },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(transport.initCalls).toEqual([expect.any(String)]);
    expect(transport.turns).toEqual([]);
    expect(transport.compactCalls).toEqual([]);
    await session.close();
  });

  it("projects Claude recap local output as a one-line Agent Message", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");
    const turnId = hostTurnIdSchema.parse("manual-recap");

    await expect(commands.execute({ turnId, commandId: "claude.recap" })).resolves.toEqual({
      ok: true,
      value: { turnId },
    });
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toEqual({ type: "turn.started", turnId });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Built compact command and subagent projection.", "recap-assistant");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Built compact command and subagent projection." },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "agentMessage",
          text: "Built compact command and subagent projection.",
        },
      },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(transport.recapCalls).toEqual([expect.any(String)]);
    expect(transport.turns).toEqual([]);
    await session.close();
  });

  it("uses one Item identity for a live response and its native history snapshot", async () => {
    const { adapter, history, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("stable-live-history-item"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    const liveStarted = await nextEvent(iterator);
    if (liveStarted.type !== "item.started" || liveStarted.item.type !== "agentMessage") {
      throw new Error("Claude live Agent Message did not start");
    }
    const transport = transports[0];
    const nativeTurnKey = transport?.turns[0]?.userMessageId;
    if (!transport || !nativeTurnKey) throw new Error("Fake Claude Turn did not start");

    transport.reasoning("native-message", "one thought");
    const liveReasoningStarted = await nextEvent(iterator);
    if (
      liveReasoningStarted.type !== "item.started" ||
      liveReasoningStarted.item.type !== "reasoning"
    ) {
      throw new Error("Claude live Reasoning did not start");
    }
    await nextEvent(iterator);
    transport.completeReasoning("native-message");
    await nextEvent(iterator);
    transport.delta("one response", "native-message");
    await nextEvent(iterator);
    transport.event({
      type: "message.completed",
      messageId: "native-message",
      checkpointId: "native-assistant",
    });
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    history.push(
      {
        type: "user",
        uuid: nativeTurnKey,
        session_id: transport.sessionId,
        message: { role: "user", content: "stable-live-history-item" },
      },
      {
        type: "assistant",
        uuid: "native-thinking",
        session_id: transport.sessionId,
        message: {
          id: "native-message",
          role: "assistant",
          content: [{ type: "thinking", thinking: "one thought" }],
          stop_reason: "end_turn",
        },
      },
      {
        type: "assistant",
        uuid: "native-assistant",
        session_id: transport.sessionId,
        message: {
          id: "native-message",
          role: "assistant",
          content: [{ type: "text", text: "one response" }],
          stop_reason: "end_turn",
        },
      },
    );

    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.turns[0]?.items.map(({ item }) => item.itemId)).toEqual([
      liveReasoningStarted.item.itemId,
      liveStarted.item.itemId,
    ]);
    await session.close();
  });

  it("uses one Tool Item identity for a live Turn and its native history snapshot", async () => {
    const { adapter, history, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("stable-live-tool-items"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    const nativeTurnKey = transport?.turns[0]?.userMessageId;
    if (!transport || !nativeTurnKey) throw new Error("Fake Claude Turn did not start");

    transport.event({
      type: "tool.started",
      callId: "bash-live-1",
      toolName: "Bash",
      arguments: { command: "npm run dev" },
    });
    const firstStarted = await nextEvent(iterator);
    if (firstStarted.type !== "item.started" || firstStarted.item.type !== "commandExecution") {
      throw new Error("Claude live Bash command did not start");
    }
    transport.event({
      type: "tool.started",
      callId: "bash-live-2",
      toolName: "Bash",
      arguments: { command: "npm run build" },
    });
    const secondStarted = await nextEvent(iterator);
    if (secondStarted.type !== "item.started" || secondStarted.item.type !== "commandExecution") {
      throw new Error("Claude live background Bash did not start");
    }
    transport.event({
      type: "tool.completed",
      callId: "bash-live-1",
      toolName: "Bash",
      outputText: "built",
      isError: false,
    });
    await nextEvent(iterator);
    transport.event({
      type: "tool.completed",
      callId: "bash-live-2",
      toolName: "Bash",
      outputText: "Command running in background with ID: bash-task-1.",
      isError: false,
      backgroundTaskId: "bash-task-1",
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.detached" });
    transport.event({
      type: "message.completed",
      messageId: "native-assistant",
      checkpointId: "native-assistant",
    });
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    history.push(
      {
        type: "user",
        uuid: nativeTurnKey,
        session_id: transport.sessionId,
        message: { role: "user", content: "stable-live-tool-items" },
      },
      {
        type: "assistant",
        uuid: "native-assistant",
        session_id: transport.sessionId,
        message: {
          id: "native-message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "bash-live-1",
              name: "Bash",
              input: { command: "npm run dev" },
            },
            {
              type: "tool_use",
              id: "bash-live-2",
              name: "Bash",
              input: { command: "npm run build" },
            },
          ],
          stop_reason: "end_turn",
        },
      },
      {
        type: "user",
        uuid: "native-tool-results",
        session_id: transport.sessionId,
        toolUseResult: { stdout: "built" },
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "bash-live-1", content: "built" },
            {
              type: "tool_result",
              tool_use_id: "bash-live-2",
              content: "Command running in background with ID: bash-task-1.",
            },
          ],
        },
      },
    );

    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    const commands = snapshot.value.turns[0]?.items.filter(
      ({ item }) => item.type === "commandExecution",
    );
    expect(commands?.map(({ item }) => item.itemId)).toEqual([
      firstStarted.type === "item.started" ? firstStarted.item.itemId : "",
      secondStarted.type === "item.started" ? secondStarted.item.itemId : "",
    ]);
    await session.close();
  });

  it("settles a detached background command from its task notification, not as a Subagent", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const directory = await mkdtemp(path.join(tmpdir(), "claude-live-bg-"));
    try {
      const outputFile = path.join(directory, "task-1.output");
      await writeFile(outputFile, "ticked\n");
      const iterator = session.outputs[Symbol.asyncIterator]();
      await session.execute(textTurn("background-command"));
      await nextEvent(iterator);
      await nextEvent(iterator);
      await nextEvent(iterator);
      const transport = transports[0];
      if (!transport) throw new Error("Fake Claude transport was not created");

      transport.event({
        type: "tool.started",
        callId: "bash-call",
        toolName: "Bash",
        arguments: { command: "sleep 3" },
      });
      await nextEvent(iterator);
      transport.event({
        type: "tool.completed",
        callId: "bash-call",
        toolName: "Bash",
        outputText: "Command running in background with ID: bash-task.",
        isError: false,
        backgroundTaskId: "bash-task",
      });
      expect(await nextEvent(iterator)).toMatchObject({ type: "item.detached" });

      // Desktop's "stop all background terminals" stops the detached command's task.
      await session.stopBackgroundWork?.();
      expect(transport.stopBackgroundTaskCalls).toEqual(["bash-task"]);

      // Its native notification completes the command with the task's output file.
      transport.threadEvent({
        type: "subagent.settled",
        nativeSubagentId: "bash-task",
        callId: "bash-call",
        status: "interrupted",
        outputFile,
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "item.updated",
        update: { type: "output.append", text: "ticked\n" },
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "item.completed",
        snapshot: {
          item: { output: "ticked\n" },
          outcome: { status: "cancelled", reason: "Background command stopped" },
        },
      });

      // The same notification shape still settles Subagents it does not name.
      transport.threadEvent({
        type: "subagent.settled",
        nativeSubagentId: "agent-task",
        callId: "agent-call",
        status: "completed",
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "subagent.state.changed",
        nativeSubagentId: "agent-task",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await adapter.close();
    }
  });

  it.each(["close", "fault"] as const)(
    "completes notified background commands before the output channel ends on Session %s",
    async (ending) => {
      const { adapter, transports } = fixture();
      const session = await openSession(adapter);
      const outputs: HarnessOutput[] = [];
      const consuming = (async () => {
        for await (const output of session.outputs) outputs.push(output);
      })();
      const pendingOpen = Promise.withResolvers<FsPromises.FileHandle>();
      void pendingOpen.promise.catch(() => undefined);
      let opening = false;
      try {
        await session.execute(textTurn("closing-background-command"));
        const transport = transports[0];
        if (!transport) throw new Error("Fake Claude transport was not created");
        transport.event({
          type: "tool.started",
          callId: "bash-call",
          toolName: "Bash",
          arguments: { command: "sleep 3" },
        });
        transport.event({
          type: "tool.completed",
          callId: "bash-call",
          toolName: "Bash",
          outputText: "Command running in background with ID: bash-task.",
          isError: false,
          backgroundTaskId: "bash-task",
        });
        vi.mocked(open).mockImplementationOnce(() => {
          opening = true;
          return pendingOpen.promise;
        });
        transport.threadEvent({
          type: "subagent.settled",
          nativeSubagentId: "bash-task",
          callId: "bash-call",
          status: "completed",
          outputFile: path.join(tmpdir(), "claude-pending-output"),
        });
        await vi.waitFor(() => expect(opening).toBe(true));
        if (ending === "close") await session.close();
        else transport.fault(new Error("synthetic Query fault"));
        await consuming;
        const commands = outputs.flatMap((output) =>
          output.kind === "event" &&
          output.event.type === "item.completed" &&
          output.event.snapshot.item.type === "commandExecution"
            ? [output.event]
            : [],
        );
        expect(commands).toMatchObject([{ snapshot: { outcome: { status: "succeeded" } } }]);
      } finally {
        pendingOpen.reject(Object.assign(new Error("Output unavailable"), { code: "ENOENT" }));
        await adapter.close();
        await consuming;
        vi.mocked(open).mockReset();
      }
    },
  );

  it.each([false, true])("waits for transcript persistence (timeout: %s)", async (timeout) => {
    const { adapter, transports, history, dependencies } = fixture();
    const session = await openSession(adapter);
    try {
      await session.execute(textTurn("delayed-history"));
      const transport = transports[0];
      if (!transport) throw new Error("Fake Claude transport was not created");
      transport.event({ type: "message.completed", messageId: "answer", checkpointId: "answer" });
      transport.finish({ status: "succeeded" });
      await Promise.resolve();
      const sent = transport.turns[0];
      if (!sent) throw new Error("Fake Claude Turn was not submitted");
      const persisted = [
        {
          type: "user",
          uuid: sent.userMessageId,
          session_id: transport.sessionId,
          message: { role: "user", content: "delayed-history" },
        },
        {
          type: "assistant",
          uuid: "answer",
          session_id: transport.sessionId,
          message: { role: "assistant", content: "done" },
        },
      ];
      vi.mocked(dependencies.readSessionMessages).mockClear();
      if (!timeout)
        vi.mocked(dependencies.readSessionMessages)
          .mockResolvedValueOnce([])
          .mockResolvedValue(persisted);
      const result = await session.readSnapshot();
      if (timeout) {
        expect(result).toMatchObject({
          ok: false,
          error: { code: "sessionBusy", retryable: true },
        });
        history.push(...persisted);
        await expect(session.readSnapshot()).resolves.toMatchObject({
          ok: true,
          value: { turns: [{ input: [{ text: "delayed-history" }] }] },
        });
      } else {
        expect(result).toMatchObject({
          ok: true,
          value: { turns: [{ input: [{ text: "delayed-history" }] }] },
        });
        expect(dependencies.readSessionMessages).toHaveBeenCalledTimes(2);
      }
    } finally {
      await adapter.close();
    }
  });

  it("projects automatic Compaction and defers Usage refresh until Turn completion", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("automatic-compaction"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.event({ type: "compaction.started" });
    const started = await nextEvent(iterator);
    if (started.type !== "item.started" || started.item.type !== "contextCompaction") {
      throw new Error("Claude Context Compaction Item did not start");
    }

    transport.contextUsage = { usedTokens: 30, maxTokens: 200, model: "runtime-default" };
    transport.event({ type: "compaction.completed", outcome: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "contextCompaction", itemId: started.item.itemId },
        outcome: { status: "succeeded" },
      },
    });
    expect(transport.getContextUsage).not.toHaveBeenCalled();

    transport.delta("continued", "assistant-after-compaction");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "continued" },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "continued" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    expect(transport.getContextUsage).not.toHaveBeenCalled();
    await session.close();
  });

  it("closes an active Compaction Item when the Turn is cancelled", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("cancel-compaction"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({ type: "compaction.started" });
    await nextEvent(iterator);

    await session.execute({ type: "turn.cancel", turnId: textTurn("cancel-compaction").turnId });
    transport.finish({ status: "cancelled", reason: "aborted_streaming" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "contextCompaction" },
        outcome: { status: "cancelled" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" }, outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    await session.close();
  });

  it("keeps native Assistant responses in separate Agent Items", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("message-boundaries"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    const firstStarted = await nextEvent(iterator);
    const transport = transports[0];
    if (!transport || firstStarted.type !== "item.started") {
      throw new Error("Fake Claude transport or first Agent Item was not created");
    }

    transport.delta("first", "assistant-1");
    await nextEvent(iterator);
    transport.delta("second", "assistant-2");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { itemId: firstStarted.item.itemId, text: "first" } },
    });
    const secondStarted = await nextEvent(iterator);
    expect(secondStarted).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    await nextEvent(iterator);

    transport.delta("third", "assistant-3");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "second" } },
    });
    const thirdStarted = await nextEvent(iterator);
    await nextEvent(iterator);
    if (secondStarted.type !== "item.started" || thirdStarted.type !== "item.started") {
      throw new Error("Expected Agent Item starts");
    }
    expect(
      new Set([firstStarted.item.itemId, secondStarted.item.itemId, thirdStarted.item.itemId]).size,
    ).toBe(3);

    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { itemId: thirdStarted.item.itemId, text: "third" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("projects distinct visible Reasoning lifecycles before final text", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("reasoning"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.reasoning("assistant-1", "first ");
    const firstStarted = await nextEvent(iterator);
    expect(firstStarted).toMatchObject({ type: "item.started", item: { type: "reasoning" } });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "first " },
    });
    transport.reasoning("assistant-1", "analysis");
    await nextEvent(iterator);
    transport.completeReasoning("assistant-1");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "reasoning", text: "first analysis" } },
    });

    transport.reasoning("assistant-2", "second analysis");
    const secondStarted = await nextEvent(iterator);
    expect(secondStarted).toMatchObject({ type: "item.started", item: { type: "reasoning" } });
    if (firstStarted.type !== "item.started" || secondStarted.type !== "item.started") {
      throw new Error("Expected Reasoning Item starts");
    }
    expect(secondStarted.item.itemId).not.toBe(firstStarted.item.itemId);
    await nextEvent(iterator);
    transport.completeReasoning("assistant-2");
    await nextEvent(iterator);
    transport.delta("answer");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "answer" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("projects bounded Bash and failed Generic Tool lifecycles in native order", async () => {
    const { adapter, transports } = fixture({ toolOutputLimit: 4 });
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("tools"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.delta("before", "assistant-before-tool");
    await nextEvent(iterator);
    transport.event({
      type: "tool.started",
      callId: "bash-1",
      toolName: "Bash",
      arguments: { command: "printf complete" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "before" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "commandExecution",
        command: "printf complete",
        cwd: path.resolve("/synthetic"),
      },
    });
    transport.event({ type: "tool.progress", callId: "bash-1", elapsedMs: 20 });
    transport.event({
      type: "tool.completed",
      callId: "bash-1",
      toolName: "Bash",
      outputText: "complete",
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "commandExecution",
          output: "comp",
          outputTruncated: true,
          durationMs: expect.any(Number),
        },
        outcome: { status: "succeeded" },
      },
    });

    transport.event({
      type: "tool.started",
      callId: "read-1",
      toolName: "Read",
      arguments: { file_path: "sample.txt" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "Read" },
    });
    transport.event({
      type: "tool.completed",
      callId: "read-1",
      toolName: "Read",
      outputText: "failed output",
      isError: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "toolExecution",
          output: { content: [{ type: "text", text: "fail" }], truncated: true },
        },
        outcome: { status: "failed", error: { code: "nativeFailure" } },
      },
    });

    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("projects Claude Task tools as accumulated Todo snapshots", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("tasks"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.event({
      type: "tool.started",
      callId: "create-1",
      toolName: "TaskCreate",
      arguments: {
        subject: "Run tests",
        description: "Run focused tests",
        activeForm: "Running tests",
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "Todo", arguments: {} },
    });
    transport.event({
      type: "tool.completed",
      callId: "create-1",
      toolName: "TaskCreate",
      structuredResult: { task: { id: "1", subject: "Run tests" } },
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "toolExecution",
          toolName: "Todo",
          arguments: { todos: [{ id: "1", content: "Run tests", status: "pending" }] },
        },
      },
    });

    transport.event({
      type: "tool.started",
      callId: "update-1",
      toolName: "TaskUpdate",
      arguments: { taskId: "1", status: "in_progress" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "Todo", arguments: {} },
    });
    transport.event({
      type: "tool.completed",
      callId: "update-1",
      toolName: "TaskUpdate",
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "toolExecution",
          toolName: "Todo",
          arguments: { todos: [{ id: "1", content: "Run tests", status: "in_progress" }] },
        },
      },
    });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await session.close();
  });

  it("projects Claude Agent delegation as one common Subagent Item", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("delegate"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.delta("delegating", "assistant-before-agent");
    await nextEvent(iterator);
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "agent-1",
      description: "Inspect implementation",
      role: "Explore",
      background: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "delegating" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "subagentDelegation",
        operation: "spawn",
        subagents: [
          {
            subagentId: "agent-1",
            description: "Inspect implementation",
            role: "Explore",
            background: true,
            status: "running",
          },
        ],
      },
    });
    transport.event({ type: "subagent.transcript.changed", callId: "agent-1" });
    transport.event({
      type: "subagent.updated",
      callId: "agent-1",
      status: "running",
      nativeSubagentId: "native-agent-1",
      resultSummary: "Reading files",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "subagents.replace",
        subagents: [
          {
            status: "running",
            nativeSubagentId: "native-agent-1",
            resultSummary: "Reading files",
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.transcript.changed",
      nativeSubagentId: "native-agent-1",
    });
    transport.event({ type: "subagent.transcript.changed", callId: "agent-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.transcript.changed",
      nativeSubagentId: "native-agent-1",
    });
    transport.event({
      type: "subagent.completed",
      callId: "agent-1",
      isError: false,
      resultSummary: "Agent launched successfully",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "subagents.replace",
        subagents: [{ status: "completed", resultSummary: "Agent launched successfully" }],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "subagentDelegation", subagents: [{ status: "completed" }] },
        outcome: { status: "succeeded" },
      },
    });

    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("keeps an async Agent spawn running after its launch Tool Result", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("delegate in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "agent-1",
      description: "Inspect implementation",
      background: true,
    });
    await nextEvent(iterator);
    transport.event({
      type: "subagent.completed",
      callId: "agent-1",
      isError: false,
      continuesInBackground: true,
      nativeSubagentId: "native-agent-1",
      resultSummary: "Async agent launched successfully",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "subagents.replace",
        subagents: [
          {
            status: "running",
            nativeSubagentId: "native-agent-1",
            resultSummary: "Async agent launched successfully",
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "subagentDelegation", subagents: [{ status: "running" }] },
        outcome: { status: "succeeded" },
      },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });
    transport.running = true;
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.completed" });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });
    transport.autonomousTurnHandler?.({
      nativeTurnKey: "task-notification-1",
      events: [
        {
          type: "subagent.settled",
          nativeSubagentId: "native-agent-1",
          status: "completed",
          resultSummary: "Inspection complete",
        },
        {
          type: "text.delta",
          messageId: "continuation-assistant",
          delta: "Inspection complete",
        },
        {
          type: "message.completed",
          messageId: "continuation-assistant",
          checkpointId: "continuation-checkpoint",
        },
      ],
      result: { status: "succeeded" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-1",
      status: "completed",
      resultSummary: "Inspection complete",
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.autonomous.started" });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Inspection complete" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Inspection complete" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
      nativeTurnRef: { nativeTurnKey: "task-notification-1" },
    });
    await session.close();
  });

  it("keeps an existing Agent running when SendMessage returns", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("send"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "send",
      callId: "send-1",
      nativeSubagentId: "native-agent-1",
      description: "Analyze directory",
      background: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "subagentDelegation", operation: "send" },
    });
    transport.event({
      type: "subagent.completed",
      callId: "send-1",
      isError: false,
      resultSummary: "Message sent successfully",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "subagents.replace", subagents: [{ status: "running" }] },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "subagentDelegation", subagents: [{ status: "running" }] },
        outcome: { status: "succeeded" },
      },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });
    transport.running = true;
    transport.autonomousTurnHandler?.({
      nativeTurnKey: "task-notification-send",
      events: [
        {
          type: "subagent.settled",
          nativeSubagentId: "native-agent-1",
          status: "completed",
          resultSummary: "Directory analyzed",
        },
        {
          type: "text.delta",
          messageId: "send-continuation",
          delta: "Directory analyzed",
        },
        { type: "message.completed", messageId: "send-continuation" },
      ],
      result: { status: "succeeded" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-1",
      status: "completed",
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.autonomous.started" });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Directory analyzed" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Directory analyzed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });
    await session.close();
  });

  it("publishes an autonomous Root Turn after background task completion", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Background task launched");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    transport.autonomousTurnHandler?.({
      nativeTurnKey: "task-notification-1",
      events: [
        {
          type: "subagent.settled",
          nativeSubagentId: "native-agent-1",
          status: "completed",
          resultSummary: "Analysis complete",
        },
        {
          type: "text.delta",
          messageId: "autonomous-assistant",
          delta: "Background analysis result",
        },
        {
          type: "message.completed",
          messageId: "autonomous-assistant",
          checkpointId: "autonomous-checkpoint",
        },
      ],
      result: { status: "succeeded" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-1",
      status: "completed",
      resultSummary: "Analysis complete",
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.autonomous.started", input: [] });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Background analysis result" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Background analysis result" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
      nativeTurnRef: { nativeTurnKey: "task-notification-1" },
    });
    await session.close();
  });

  async function launchBackgroundAgent() {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("delegate in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "agent-1",
      description: "Inspect implementation",
      background: true,
    });
    await nextEvent(iterator);
    transport.event({
      type: "subagent.completed",
      callId: "agent-1",
      isError: false,
      continuesInBackground: true,
      nativeSubagentId: "native-agent-1",
      resultSummary: "Async agent launched successfully",
    });
    await nextEvent(iterator);
    await nextEvent(iterator);
    return { iterator, session, transport, transports };
  }

  const cancelDelegation = {
    type: "turn.cancel",
    turnId: hostTurnIdSchema.parse("delegate in background"),
  } as const;

  it("stops the background Subagents a cancelled Turn launched and confirms the stop", async () => {
    const { iterator, session, transport } = await launchBackgroundAgent();
    await expect(session.execute(cancelDelegation)).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transport.stopTasks).toHaveBeenCalledWith(["native-agent-1"]);
    expect(transport.abort).toHaveBeenCalledWith(1);
    expect(transport.stopTasks.mock.invocationCallOrder[0]).toBeLessThan(
      transport.abort.mock.invocationCallOrder[0] ?? 0,
    );
    // Claude Code reports the stopped task and the interrupted Root Segment natively.
    transport.threadEvent({
      type: "subagent.settled",
      nativeSubagentId: "native-agent-1",
      callId: "agent-1",
      status: "interrupted",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-1",
      status: "interrupted",
    });
    transport.finish({ status: "cancelled", reason: "Cancelled by user" });
    const outputs = eventOutputs(
      await nextOutputMatching(
        iterator,
        (output) => output.kind === "event" && output.event.type === "turn.completed",
      ),
    );
    expect(outputs.at(-1)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    await session.close();
  });

  it("closes Claude Code when it does not confirm a background stop", async () => {
    const { iterator, session, transport, transports } = await launchBackgroundAgent();
    transport.stopTasks.mockRejectedValueOnce(
      new Error("Claude background task stop was not confirmed"),
    );
    await expect(session.execute(cancelDelegation)).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    const outputs = eventOutputs(
      await nextOutputMatching(
        iterator,
        (output) => output.kind === "event" && output.event.type === "turn.completed",
      ),
    );
    expect(transport.abort).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalled();
    expect(outputs.at(-1)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });

    // The next Turn resumes the native Session on a new process.
    await session.execute(textTurn("next"));
    expect(transports).toHaveLength(2);
    await session.close();
  });

  it("does not stop background work launched by an earlier Turn", async () => {
    const { iterator, session, transport } = await launchBackgroundAgent();
    transport.finish({ status: "succeeded" });
    await nextOutputMatching(
      iterator,
      (output) => output.kind === "event" && output.event.type === "turn.completed",
    );
    await session.execute(textTurn("next"));
    await expect(
      session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("next") }),
    ).resolves.toEqual({ ok: true, value: { cancellationRequested: true } });
    expect(transport.stopTasks).not.toHaveBeenCalled();
    expect(transport.abort).toHaveBeenCalledWith(2);
    await session.close();
  });

  it.each(["prompt", "command"] as const)(
    "preserves an autonomous Turn starting during %s admission",
    async (kind) => {
      const { adapter, transports } = fixture();
      const session = await openSession(adapter);
      const events: Array<Extract<HarnessOutput, { kind: "event" }>["event"]> = [];
      const drain = (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "event") events.push(output.event);
        }
      })();
      try {
        await session.execute(textTurn("warmup"));
        const transport = transports[0];
        if (!transport || !session.commands) throw new Error("Missing test transport");
        transport.finish({ status: "succeeded" });
        await vi.waitFor(() =>
          expect(events.some((event) => event.type === "turn.completed")).toBe(true),
        );
        events.length = 0;
        // Even a warm transport yields at await: native Root output can arrive
        // after the admission check but before the request installs its Turn.
        const admission =
          kind === "prompt"
            ? session.execute(textTurn("racing-request"))
            : session.commands.execute({
                turnId: hostTurnIdSchema.parse("racing-request"),
                commandId: "claude.compact",
              });
        const continuation = transport.beginContinuation("racing-continuation");
        await expect(admission).resolves.toMatchObject({
          ok: false,
          error: { code: "sessionBusy", retryable: true },
        });
        continuation.onEvent({ type: "text.delta", messageId: "continuation", delta: "PRESERVED" });
        await continuation.onTerminal({ status: "succeeded" });
        await vi.waitFor(() =>
          expect(events.some((event) => event.type === "turn.completed")).toBe(true),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "item.updated",
            update: { type: "text.append", text: "PRESERVED" },
          }),
        );
        expect(events.filter((event) => event.type === "turn.completed")).toEqual([
          expect.objectContaining({
            nativeTurnRef: {
              harnessId: "claude-code",
              nativeSessionId: transport.sessionId,
              nativeTurnKey: "racing-continuation",
              formatVersion: 1,
            },
            outcome: { status: "succeeded" },
          }),
        ]);
        expect(transport.turns).toHaveLength(1);
        expect(transport.compactCalls).toHaveLength(0);
        await expect(session.execute(textTurn("after-continuation"))).resolves.toMatchObject({
          ok: true,
        });
        transport.finish({ status: "succeeded" });
      } finally {
        await session.close();
        await drain;
      }
    },
  );

  it.each(["completed", "failed", "interrupted"] as const)(
    "finishes an autonomous Turn after its newly created child is %s",
    async (status) => {
      const { adapter, transports } = fixture();
      const session = await openSession(adapter);
      const events: Array<Extract<HarnessOutput, { kind: "event" }>["event"]> = [];
      const drain = (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "event") events.push(output.event);
        }
      })();
      try {
        await session.execute(textTurn("initial"));
        const transport = transports[0];
        if (!transport) throw new Error("Fake Claude transport was not created");
        transport.finish({ status: "succeeded" });
        await vi.waitFor(() =>
          expect(events.some((event) => event.type === "turn.completed")).toBe(true),
        );
        events.length = 0;
        transport.autonomousTurnHandler?.({
          nativeTurnKey: "continuation-with-child",
          events: [
            {
              type: "subagent.started",
              operation: "spawn",
              callId: "spawn-child",
              description: "Inspect",
              background: true,
            },
            {
              type: "subagent.completed",
              callId: "spawn-child",
              isError: false,
              continuesInBackground: true,
              nativeSubagentId: "fast-child",
            },
            {
              type: "subagent.settled",
              nativeSubagentId: "fast-child",
              status,
              resultSummary: "Child finished",
            },
          ],
          result: { status: "succeeded" },
        });
        await vi.waitFor(() =>
          expect(events.some((event) => event.type === "turn.completed")).toBe(true),
        );
        expect(events.filter((event) => event.type === "subagent.state.changed")).toEqual([
          {
            type: "subagent.state.changed",
            nativeSubagentId: "fast-child",
            status,
            resultSummary: "Child finished",
          },
        ]);
        const creation = events.findIndex(
          (event) =>
            event.type === "item.completed" && event.snapshot.item.type === "subagentDelegation",
        );
        const settlement = events.findIndex((event) => event.type === "subagent.state.changed");
        expect(creation).toBeGreaterThanOrEqual(0);
        expect(settlement).toBeGreaterThan(creation);
        expect(await session.execute(textTurn("next-user-turn"))).toMatchObject({ ok: true });
        transport.finish({ status: "succeeded" });
      } finally {
        await session.close();
        await drain;
      }
    },
  );

  it("publishes a background Subagent settlement that arrives outside any Turn", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("delegate in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Background task launched");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    // The Turn is complete and idle. Claude may enqueue the task notification
    // without a continuation, so the settlement no longer rides a Turn.
    transport.threadEvent({
      type: "subagent.settled",
      nativeSubagentId: "native-agent-late",
      status: "completed",
      resultSummary: "Analysis complete",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-late",
      status: "completed",
      resultSummary: "Analysis complete",
    });
    await session.close();
  });

  it("ends each native Turn while Session activity and background tasks remain independent", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const outputs: HarnessOutput[] = [];
    const drain = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    await session.execute(textTurn("background"));
    const transport = transports[0];
    if (!transport) throw new Error("Missing transport");
    await transport.handler({ type: "activity.changed", activity: "running" });
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "child",
      description: "inspect",
      background: true,
    });
    transport.event({
      type: "subagent.completed",
      callId: "child",
      isError: false,
      continuesInBackground: true,
      nativeSubagentId: "native-child",
    });
    transport.finish({ status: "succeeded" });
    const terminals = () =>
      outputs.filter((o) => o.kind === "event" && o.event.type === "turn.completed");
    await vi.waitFor(() => expect(terminals()).toHaveLength(1));
    transport.threadEvent({
      type: "subagent.settled",
      nativeSubagentId: "native-child",
      status: "completed",
    });
    await transport.emitAutonomousTurn({
      nativeTurnKey: "notification",
      events: [{ type: "text.delta", messageId: "reply", delta: "done" }],
      result: { status: "succeeded" },
    });
    await transport.handler({ type: "activity.changed", activity: "idle" });
    await vi.waitFor(() => expect(terminals()).toHaveLength(2));
    expect(
      outputs.filter((o) => o.kind === "event" && o.event.type === "turn.autonomous.started"),
    ).toHaveLength(1);
    expect(
      outputs
        .filter((o) => o.kind === "event" && o.event.type === "session.activity.changed")
        .map((o) =>
          o.kind === "event" && o.event.type === "session.activity.changed"
            ? o.event.activity
            : null,
        ),
    ).toEqual(["running", "idle"]);
    await session.close();
    await drain;
  });

  it("omits an empty successful autonomous segment but shows its failure", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const outputs: HarnessOutput[] = [];
    const drain = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    await session.execute(textTurn("seed"));
    const transport = transports[0];
    if (!transport) throw new Error("Missing transport");
    transport.finish({ status: "succeeded" });
    await transport.emitAutonomousTurn({ events: [], result: { status: "succeeded" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      outputs.filter((o) => o.kind === "event" && o.event.type === "turn.autonomous.started"),
    ).toHaveLength(0);
    await transport.emitAutonomousTurn({
      events: [],
      result: { status: "failed", kind: "native" },
    });
    await vi.waitFor(() =>
      expect(
        outputs.filter((o) => o.kind === "event" && o.event.type === "turn.autonomous.started"),
      ).toHaveLength(1),
    );
    expect(
      outputs.filter((o) => o.kind === "event" && o.event.type === "turn.completed").at(-1),
    ).toMatchObject({ event: { outcome: { status: "failed" } } });
    await session.close();
    await drain;
  });

  it("emits a reliable File Change immediately after a successful Edit", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("edit"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.event({
      type: "tool.started",
      callId: "edit-1",
      toolName: "Edit",
      arguments: { file_path: "/synthetic/sample.txt" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "Edit" },
    });
    transport.event({
      type: "tool.completed",
      callId: "edit-1",
      toolName: "Edit",
      outputText: "edited",
      isError: false,
      fileChange: {
        path: "/synthetic/sample.txt",
        kind: "update",
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old", "+new"],
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "toolExecution", toolName: "Edit" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "fileChange",
        changes: [
          {
            path: "sample.txt",
            kind: "update",
            unifiedDiff: "--- a/sample.txt\n+++ b/sample.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "fileChange" }, outcome: { status: "succeeded" } },
    });

    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("keeps successful Edit without native patch evidence Tool-only", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("edit-no-patch"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "tool.started",
      callId: "edit-1",
      toolName: "Edit",
      arguments: { file_path: "sample.txt" },
    });
    await nextEvent(iterator);
    transport.event({
      type: "tool.completed",
      callId: "edit-1",
      toolName: "Edit",
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "toolExecution" } },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });
    await session.close();
  });

  it("closes active Tools before cancellation and continues on the same Session", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("cancel-tool"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "tool.started",
      callId: "bash-1",
      toolName: "Bash",
      arguments: { command: "sleep 10" },
    });
    await nextEvent(iterator);
    await expect(
      session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("cancel-tool") }),
    ).resolves.toEqual({ ok: true, value: { cancellationRequested: true } });
    transport.finish({ status: "cancelled", reason: "aborted_tools" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "commandExecution" },
        outcome: { status: "cancelled" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" }, outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });

    await expect(session.execute(textTurn("after-cancel-tool"))).resolves.toMatchObject({
      ok: true,
    });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transport.delta("continued");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    expect(transports).toHaveLength(1);
    await session.close();
  });

  it("fails a successful native result that leaves a Tool unresolved", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("unresolved-tool"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "tool.started",
      callId: "read-1",
      toolName: "Read",
      arguments: {},
    });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "toolExecution" }, outcome: { status: "failed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" }, outcome: { status: "failed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed", error: { code: "protocolError" } },
    });
    await session.close();
  });

  it("applies a create-time alias lazily and publishes the configured Model before the Turn", async () => {
    const { adapter, dependencies, transports } = fixture();
    const selected = encodeClaudeModelRef("sonnet");
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("max");
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model: selected,
      thinkingOptionId,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(session.execute(textTurn("selected-first"))).resolves.toMatchObject({ ok: true });
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "sonnet",
        openMode: "create",
        thinkingOptionId: "max",
      }),
    );
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: {
        effectiveModel: selected,
        effectiveThinkingOptionId: "max",
      },
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("selects an Idle alias and restores default without Model readback", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("initialize-selection"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    const contextReadsBeforeSelection = transport.getContextUsage.mock.calls.length;
    const alias = encodeClaudeModelRef("sonnet");
    const selectingAlias = session.execute({ type: "model.select", model: alias });
    const aliasState = await nextEvent(iterator);
    expect(aliasState).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: alias },
    });
    expect(aliasState).not.toHaveProperty("state.resolvedModelLabel");
    await expect(selectingAlias).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transport.setModel).toHaveBeenLastCalledWith("sonnet");

    const resetting = session.execute({ type: "model.select", model: CLAUDE_DEFAULT_MODEL_REF });
    const defaultState = await nextEvent(iterator);
    expect(defaultState).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: CLAUDE_DEFAULT_MODEL_REF },
    });
    expect(defaultState).not.toHaveProperty("state.resolvedModelLabel");
    await expect(resetting).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transport.setModel).toHaveBeenLastCalledWith(undefined);
    expect(transport.getContextUsage).toHaveBeenCalledTimes(contextReadsBeforeSelection);
    await session.close();
  });

  it("dynamically switches Thinking on an Idle Query", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("initialize-thinking"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectiveThinkingOptionId: "high" },
    });
    expect(transport.setThinkingOption).toHaveBeenCalledWith("high");
    await session.close();
  });

  it("uses auto Permission Mode for unattended delegation sessions", async () => {
    const { adapter, dependencies } = fixture();
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      executionPolicy: "unattended-full-access",
    });
    if (!opened.ok) throw new Error(opened.error.message);

    await opened.value.execute(textTurn("unattended"));
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "auto" }),
    );
    await opened.value.close();
  });

  it("defers cold Permission Mode selection and dynamically switches a started Query", async () => {
    const { adapter, dependencies, transports } = fixture();
    const plan = harnessPermissionModeIdSchema.parse("plan");
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: plan,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const iterator = session.outputs[Symbol.asyncIterator]();
    const auto = harnessPermissionModeIdSchema.parse("auto");

    await expect(
      session.execute({ type: "permissionMode.select", permissionModeId: auto }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectivePermissionModeId: "auto" },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    await session.execute(textTurn("permission-start"));
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "auto" }),
    );
    expect(transports[0]?.setPermissionMode).not.toHaveBeenCalled();
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    transports[0]?.changePermissionMode("acceptEdits");
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectivePermissionModeId: "acceptEdits" },
    });

    transports[0]?.setPermissionMode.mockRejectedValueOnce(new Error("policy rejected"));
    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("bypassPermissions"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    expect(transports[0]?.permissionMode).toBe("acceptEdits");
    transports[0]?.setPermissionMode.mockRejectedValueOnce(
      new Error("Cannot set permission mode to auto: auto mode unavailable for this model"),
    );
    await expect(
      session.execute({ type: "permissionMode.select", permissionModeId: auto }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "nativeFailure",
        message: "Auto mode is unavailable for the current Claude Code Model",
      },
    });
    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("dontAsk"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await session.close();
  });

  it("switches Permission Mode on the current Session while a Turn is active", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    await session.execute(textTurn("permission-active"));

    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("auto"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transports[0]?.setPermissionMode).toHaveBeenCalledWith("auto");
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("passes the native bypass prerequisite from the Session environment", async () => {
    const available = fixture();
    const sandboxed = { IS_SANDBOX: "1" };
    const session = await openSession(available.adapter, sandboxed);
    await session.execute(textTurn("bypass-prerequisite"));
    expect(available.dependencies.bypassPermissionsAvailable).toHaveBeenCalledWith(
      expect.objectContaining(sandboxed),
    );
    expect(available.dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ allowDangerouslySkipPermissions: true }),
    );
    available.transports[0]?.finish({ status: "succeeded" });
    await session.close();

    const unavailable = fixture({}, { bypassPermissionsAvailable: false });
    const rootSession = await openSession(unavailable.adapter);
    await rootSession.execute(textTurn("root-prerequisite"));
    expect(unavailable.dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ allowDangerouslySkipPermissions: false }),
    );
    unavailable.transports[0]?.finish({ status: "succeeded" });
    await rootSession.close();
  });

  it("omits bypass permissions from the catalog when Claude Code cannot use it", async () => {
    const { adapter } = fixture({}, { bypassPermissionsAvailable: false });

    const inspection = await adapter.inspect({ cwd: "/synthetic" });
    expect(inspection).toMatchObject({
      status: "ready",
      permissionModes: {
        defaultModeId: "default",
        modes: [{ id: "plan" }, { id: "default" }, { id: "acceptEdits" }, { id: "auto" }],
      },
    });
  });

  it("rejects unavailable bypass permissions for create and live selection", async () => {
    const { adapter, dependencies, transports } = fixture(
      {},
      { bypassPermissionsAvailable: false },
    );
    const bypass = harnessPermissionModeIdSchema.parse("bypassPermissions");
    const unavailable = {
      ok: false,
      error: {
        code: "unsupported",
        message: expect.stringContaining("IS_SANDBOX=1"),
        retryable: false,
      },
    };

    await expect(
      adapter.open({ kind: "create", cwd: "/synthetic", permissionModeId: bypass }),
    ).resolves.toMatchObject(unavailable);
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    const session = await openSession(adapter);
    await session.execute(textTurn("root-live-selection"));
    await expect(
      session.execute({ type: "permissionMode.select", permissionModeId: bypass }),
    ).resolves.toMatchObject(unavailable);
    expect(transports[0]?.setPermissionMode).not.toHaveBeenCalled();
    expect(transports[0]?.permissionMode).toBe("default");
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("keeps a restored Thread usable when its saved bypass mode is unavailable", async () => {
    const { adapter, dependencies, transports } = fixture(
      {},
      { bypassPermissionsAvailable: false },
    );
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/synthetic",
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "claude-code",
        nativeSessionId: "restored-bypass-session",
        formatVersion: 1,
      }),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const iterator = session.outputs[Symbol.asyncIterator]();

    // Host restores a saved Thread mode through a cold selection before the first Turn.
    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("bypassPermissions"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectivePermissionModeId: "default" },
    });

    await session.execute(textTurn("restored-cold-selection"));
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: "default",
        allowDangerouslySkipPermissions: false,
      }),
    );
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("restores an unavailable bypass Permission Mode as the native default", async () => {
    const { adapter, dependencies, transports } = fixture(
      {},
      { bypassPermissionsAvailable: false },
    );
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/synthetic",
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "claude-code",
        nativeSessionId: "bypass-session",
        formatVersion: 1,
      }),
      permissionModeId: harnessPermissionModeIdSchema.parse("bypassPermissions"),
    });
    if (!opened.ok) throw new Error(opened.error.message);

    await opened.value.execute(textTurn("restored-bypass"));
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        openMode: "resume",
        permissionMode: "default",
        allowDangerouslySkipPermissions: false,
      }),
    );
    transports[0]?.finish({ status: "succeeded" });
    await opened.value.close();
  });

  it("explains native bypass permission rejections", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    await session.execute(textTurn("native-bypass-rejection"));
    const bypass = harnessPermissionModeIdSchema.parse("bypassPermissions");

    transports[0]?.setPermissionMode.mockRejectedValueOnce(
      new Error(
        "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions",
      ),
    );
    await expect(
      session.execute({ type: "permissionMode.select", permissionModeId: bypass }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "nativeFailure",
        message: expect.stringContaining("started this Session without bypass permissions"),
        retryable: false,
      },
    });

    transports[0]?.setPermissionMode.mockRejectedValueOnce(
      new Error(
        "Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration",
      ),
    );
    await expect(
      session.execute({ type: "permissionMode.select", permissionModeId: bypass }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "nativeFailure",
        message: expect.stringContaining("permissions.disableBypassPermissionsMode"),
        retryable: false,
      },
    });

    transports[0]?.setPermissionMode.mockRejectedValueOnce(new Error("connection closed"));
    await expect(
      session.execute({ type: "permissionMode.select", permissionModeId: bypass }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "nativeFailure",
        message: "Claude Code rejected the Permission Mode selection: connection closed",
        retryable: true,
      },
    });
    expect(transports[0]?.permissionMode).toBe("default");
    transports[0]?.setPermissionMode.mockRejectedValueOnce(
      new Error("new policy refusal api_key=secret-value"),
    );
    await expect(
      session.execute({ type: "permissionMode.select", permissionModeId: bypass }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        message:
          "Claude Code rejected the Permission Mode selection: new policy refusal api_key=[redacted]",
      },
    });
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("selects Model and Thinking during a Turn and preserves native Model rejection", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("initialize-failure"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    const alias = encodeClaudeModelRef("sonnet");
    await expect(session.execute({ type: "model.select", model: alias })).resolves.toMatchObject({
      ok: true,
    });
    expect(transport.setModel).toHaveBeenCalledWith("sonnet");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: alias },
    });
    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(transport.setThinkingOption).toHaveBeenCalledWith("high");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveThinkingOptionId: "high" },
    });
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    transport.setModel.mockRejectedValueOnce(new Error("policy rejected"));
    await expect(session.execute({ type: "model.select", model: alias })).resolves.toMatchObject({
      ok: false,
      error: { code: "nativeFailure" },
    });

    const contextReadsBeforeSelection = transport.getContextUsage.mock.calls.length;
    await expect(session.execute({ type: "model.select", model: alias })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: alias },
    });
    expect(transport.getContextUsage).toHaveBeenCalledTimes(contextReadsBeforeSelection);
    await session.close();
  });

  it("does not query Context automatically at Assistant, Tool, or Turn boundaries", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("passive-usage"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.event({
      type: "message.completed",
      messageId: "assistant-usage",
      lastRequestUsage: {
        requestId: "request-usage",
        model: "claude-sonnet-4-6",
        provider: "firstParty",
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 70,
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      usage: { cacheHitRatePercent: 70, inputTokens: 100, outputTokens: 5 },
    });

    transport.event({
      type: "tool.started",
      callId: "tool-1",
      toolName: "Read",
      arguments: {},
    });
    await nextEvent(iterator);
    transport.event({
      type: "tool.completed",
      callId: "tool-1",
      toolName: "Read",
      isError: false,
    });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    expect(transport.getContextUsage).not.toHaveBeenCalled();
    await session.close();
  });

  it("deduplicates completed requests and calibrates estimates with Result totals", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("usage-result"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    const request = {
      requestId: "request-1",
      model: "claude-sonnet-4-6",
      provider: "firstParty",
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 70,
    } as const;

    transport.event({
      type: "message.completed",
      messageId: "assistant-1",
      lastRequestUsage: request,
    });
    const estimate = await nextEvent(iterator);
    expect(estimate).toMatchObject({
      type: "session.usage.changed",
      usage: { inputTokens: 100, outputTokens: 5, cacheHitRatePercent: 70 },
    });
    transport.event({
      type: "message.completed",
      messageId: "assistant-1",
      lastRequestUsage: request,
    });
    await Promise.resolve();

    transport.event({
      type: "usage.result",
      totalCostUsd: 1.373,
      modelUsage: [
        { inputTokens: 100, outputTokens: 40 },
        { inputTokens: 20, outputTokens: 5 },
      ],
      lastRequestUsage: {
        inputTokens: 10,
        outputTokens: 45,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 990,
      },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "usage-result",
      usage: {
        totalCostUsd: 1.373,
        inputTokens: 120,
        outputTokens: 45,
        cacheHitRatePercent: 99,
      },
    });
    transport.finish({ status: "succeeded" });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    expect(transport.getContextUsage).not.toHaveBeenCalled();
    await session.close();
  });

  it("keeps passive Usage isolated across concurrent Claude Sessions", async () => {
    const { adapter, transports } = fixture();
    const sessionA = await openSession(adapter);
    const iteratorA = sessionA.outputs[Symbol.asyncIterator]();
    await sessionA.execute(textTurn("session-a"));
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);

    const sessionB = await openSession(adapter);
    const iteratorB = sessionB.outputs[Symbol.asyncIterator]();
    await sessionB.execute(textTurn("session-b"));
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    const transportA = transports[0];
    const transportB = transports[1];
    if (!transportA || !transportB) throw new Error("Fake Claude transports were not created");

    transportA.event({
      type: "message.completed",
      messageId: "assistant-a",
      lastRequestUsage: {
        requestId: "shared-looking-id",
        inputTokens: 10,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 90,
      },
    });
    transportB.event({
      type: "message.completed",
      messageId: "assistant-b",
      lastRequestUsage: {
        requestId: "shared-looking-id",
        inputTokens: 80,
        outputTokens: 7,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 20,
      },
    });
    expect(await nextEvent(iteratorA)).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 1, cacheHitRatePercent: 90 },
    });
    expect(await nextEvent(iteratorB)).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 7, cacheHitRatePercent: 20 },
    });

    transportA.finish({ status: "succeeded" });
    transportB.finish({ status: "succeeded" });
    for (;;) if ((await nextEvent(iteratorA)).type === "turn.completed") break;
    for (;;) if ((await nextEvent(iteratorB)).type === "turn.completed") break;
    await sessionA.close();
    await sessionB.close();
  });

  it("refreshes exact Context on demand, stops after success, and reuses the TTL", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("exact-context"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.contextUsage = { usedTokens: 80, maxTokens: 200, model: "runtime-default" };

    await session.refreshUsage?.();
    expect(transport.getContextUsage).toHaveBeenCalledOnce();
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "exact-context",
      usage: { contextUsedTokens: 80, contextWindowTokens: 200 },
    });
    await session.refreshUsage?.();
    expect(transport.getContextUsage).toHaveBeenCalledOnce();

    transport.finish({ status: "succeeded" });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await session.close();
  });

  it("keeps concurrent exact Context refreshes isolated between Sessions", async () => {
    const { adapter, transports } = fixture();
    const sessionA = await openSession(adapter);
    const iteratorA = sessionA.outputs[Symbol.asyncIterator]();
    await sessionA.execute(textTurn("context-a"));
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    const sessionB = await openSession(adapter);
    const iteratorB = sessionB.outputs[Symbol.asyncIterator]();
    await sessionB.execute(textTurn("context-b"));
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    const transportA = transports[0];
    const transportB = transports[1];
    if (!transportA || !transportB) throw new Error("Fake Claude transports were not created");
    transportA.contextUsage = { usedTokens: 30, maxTokens: 100, model: "a" };
    transportB.contextUsage = { usedTokens: 90, maxTokens: 200, model: "b" };

    await Promise.all([sessionA.refreshUsage?.(), sessionB.refreshUsage?.()]);
    expect(transportA.getContextUsage).toHaveBeenCalledOnce();
    expect(transportB.getContextUsage).toHaveBeenCalledOnce();
    expect(await nextEvent(iteratorA)).toMatchObject({
      usage: { contextUsedTokens: 30, contextWindowTokens: 100 },
    });
    expect(await nextEvent(iteratorB)).toMatchObject({
      usage: { contextUsedTokens: 90, contextWindowTokens: 200 },
    });

    transportA.finish({ status: "succeeded" });
    transportB.finish({ status: "succeeded" });
    for (;;) if ((await nextEvent(iteratorA)).type === "turn.completed") break;
    for (;;) if ((await nextEvent(iteratorB)).type === "turn.completed") break;
    await sessionA.close();
    await sessionB.close();
  });

  it("deduplicates concurrent exact Context reads and applies failure cooldown", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, transports } = fixture();
      const session = await openSession(adapter);
      const iterator = session.outputs[Symbol.asyncIterator]();
      await session.execute(textTurn("exact-context-failure"));
      await nextEvent(iterator);
      await nextEvent(iterator);
      await nextEvent(iterator);
      const transport = transports[0];
      if (!transport) throw new Error("Fake Claude transport was not created");
      transport.getContextUsage.mockResolvedValue(null);

      const first = session.refreshUsage?.();
      const second = session.refreshUsage?.();
      await vi.advanceTimersByTimeAsync(3_000);
      await Promise.all([first, second]);
      expect(transport.getContextUsage).toHaveBeenCalledTimes(3);
      await session.refreshUsage?.();
      expect(transport.getContextUsage).toHaveBeenCalledTimes(3);

      transport.finish({ status: "succeeded" });
      for (;;) {
        if ((await nextEvent(iterator)).type === "turn.completed") break;
      }
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards exact Context that resolves after the Model generation changes", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("stale-context"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    const pending = deferred<ClaudeTransportContextUsage | null>();
    transport.getContextUsage.mockImplementationOnce(() => pending.promise);
    const refresh = session.refreshUsage?.();
    const alias = encodeClaudeModelRef("sonnet");
    await expect(session.execute({ type: "model.select", model: alias })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    await nextEvent(iterator);
    pending.resolve({ usedTokens: 10, maxTokens: 100, model: "old" });
    await refresh;
    expect(transport.getContextUsage).toHaveBeenCalledOnce();
    await session.close();
  });

  it("recovers request Usage from the transcript when the live Assistant Usage is sparse", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, history, transports } = fixture();
      const session = await openSession(adapter);
      const iterator = session.outputs[Symbol.asyncIterator]();
      await session.execute(textTurn("transcript-cache-hit"));
      await nextEvent(iterator);
      await nextEvent(iterator);
      await nextEvent(iterator);
      const transport = transports[0];
      if (!transport) throw new Error("Fake Claude transport was not created");

      transport.event({ type: "message.completed", messageId: "native-request-1" });
      await vi.advanceTimersByTimeAsync(0);
      history.push({
        type: "assistant",
        request_id: "request-1",
        uuid: "assistant-checkpoint-1",
        session_id: "claude-id-1",
        parent_tool_use_id: null,
        provider: "firstParty",
        message: {
          id: "native-request-1",
          model: "claude-sonnet-4-6",
          role: "assistant",
          content: [{ type: "text", text: "working" }],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 70,
          },
        },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await nextEvent(iterator)).toMatchObject({
        type: "session.usage.changed",
        usage: { cacheHitRatePercent: 70, inputTokens: 100, outputTokens: 2 },
      });
      transport.finish({ status: "succeeded" });
      for (;;) {
        if ((await nextEvent(iterator)).type === "turn.completed") break;
      }
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits cache hit rate when last-request cache fields are incomplete", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("usage-incomplete-cache"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "usage.result",
      totalCostUsd: 0.5,
      modelUsage: [{ inputTokens: 10, outputTokens: 2 }],
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "usage-incomplete-cache",
      usage: { totalCostUsd: 0.5, inputTokens: 10, outputTokens: 2 },
    });
    transport.finish({ status: "succeeded" });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    await session.close();
  });

  it("publishes a Claude.ai five-hour plan window and preserves it across a later seven-day window", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("plan-turn"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({
      fiveHour: { utilizationPercent: 45, resetsAtUnix: 1_756_130_400 },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "plan-turn",
      usage: { planFiveHourUsedPercent: 45, planFiveHourResetsAtUnix: 1_756_130_400 },
    });

    transport.planLimit({ sevenDay: { utilizationPercent: 12 } });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "plan-turn",
      usage: {
        planFiveHourUsedPercent: 45,
        planFiveHourResetsAtUnix: 1_756_130_400,
        planSevenDayUsedPercent: 12,
      },
    });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("publishes both plan windows from a single rate-limit event", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("plan-both-windows"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({
      fiveHour: { utilizationPercent: 28, resetsAtUnix: 1_787_674_200 },
      sevenDay: { utilizationPercent: 10, resetsAtUnix: 1_787_940_000 },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "plan-both-windows",
      usage: {
        planFiveHourUsedPercent: 28,
        planFiveHourResetsAtUnix: 1_787_674_200,
        planSevenDayUsedPercent: 10,
        planSevenDayResetsAtUnix: 1_787_940_000,
      },
    });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("never publishes plan-window fields for an API-key Session that receives no rate-limit event", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("api-key-turn"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({ type: "usage.result", totalCostUsd: 0.2 });
    const resultUsage = await nextEvent(iterator);
    transport.finish({ status: "succeeded" });

    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    for (const event of [resultUsage]) {
      if (event.type !== "session.usage.changed" || event.usage === null) {
        throw new Error("Expected a Session Usage snapshot");
      }
      expect(event.usage).not.toHaveProperty("planFiveHourUsedPercent");
      expect(event.usage).not.toHaveProperty("planSevenDayUsedPercent");
    }
    await session.close();
  });

  it("drops a malformed plan-limit observation without touching the latest still-applicable Usage", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("plan-malformed"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({ fiveHour: { utilizationPercent: 30 } });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "plan-malformed",
      usage: { planFiveHourUsedPercent: 30 },
    });

    transport.planLimit({ fiveHour: { utilizationPercent: Number.NaN } });
    transport.finish({ status: "succeeded" });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    await session.close();
  });

  it("has no plan usage on the Adapter before any rate-limit event is observed", () => {
    const { adapter } = fixture();
    expect(adapter.credits()).toBeNull();
  });

  it("projects the five-hour window as the primary credits pill, with the seven-day window riding along", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("credits-turn"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({
      fiveHour: { utilizationPercent: 62, resetsAtUnix: 1_756_130_400 },
      sevenDay: { utilizationPercent: 18, resetsAtUnix: 1_756_648_800 },
    });
    await nextEvent(iterator);

    expect(adapter.credits()).toEqual({
      usedPercent: 62,
      periodType: "five_hour",
      resetsAt: new Date(1_756_130_400 * 1000).toISOString(),
      productUsage: [
        {
          product: "7-day window",
          periodType: "seven_day",
          usagePercent: 18,
          resetsAt: new Date(1_756_648_800 * 1000).toISOString(),
        },
      ],
    });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("falls back to the seven-day window alone when no five-hour observation has arrived", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("seven-day-only"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({ sevenDay: { utilizationPercent: 41 } });
    await nextEvent(iterator);

    expect(adapter.credits()).toEqual({ usedPercent: 41, periodType: "seven_day" });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("shares one account-wide plan-limit cache across concurrent Sessions", async () => {
    const { adapter, transports } = fixture();
    const sessionA = await openSession(adapter);
    const iteratorA = sessionA.outputs[Symbol.asyncIterator]();
    await sessionA.execute(textTurn("session-a"));
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    const transportA = transports[0];
    if (!transportA) throw new Error("Fake Claude transport was not created");

    const sessionB = await openSession(adapter);
    const iteratorB = sessionB.outputs[Symbol.asyncIterator]();
    await sessionB.execute(textTurn("session-b"));
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    const transportB = transports[1];
    if (!transportB) throw new Error("Fake Claude transport was not created");

    transportA.planLimit({ fiveHour: { utilizationPercent: 33 } });
    await nextEvent(iteratorA);

    // Session B never observed a rate-limit event itself, but reads the same account-wide value.
    expect(adapter.credits()).toEqual({ usedPercent: 33, periodType: "five_hour" });

    transportA.finish({ status: "succeeded" });
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    transportB.finish({ status: "succeeded" });
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    await sessionA.close();
    await sessionB.close();
  });

  it("reuses one Transport and Native Session for sequential Turns", async () => {
    const { adapter, dependencies, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("turn-1"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    await session.execute(textTurn("turn-2"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    expect(dependencies.createTransport).toHaveBeenCalledOnce();
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    expect(transports[0]?.turns.map(({ text }) => text)).toEqual(["turn-1", "turn-2"]);
    expect(new Set(transports[0]?.turns.map(({ userMessageId }) => userMessageId)).size).toBe(2);
    await session.close();
  });

  it("rejects a concurrent Turn without disturbing the active Turn", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);

    await session.execute(textTurn("turn-1"));
    await expect(session.execute(textTurn("turn-2"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it.each(["approve", "stay", "cancel"] as const)(
    "presents ExitPlanMode as an explicit plan review and maps %s to the native permission decision",
    async (choice) => {
      const { adapter, transports } = fixture();
      const session = await openSession(adapter);
      const iterator = session.outputs[Symbol.asyncIterator]();
      await session.execute(textTurn("plan-review"));
      await nextEvent(iterator);
      await nextEvent(iterator);
      await nextEvent(iterator);
      const transport = transports[0];
      if (!transport) throw new Error("Fake Claude transport was not created");
      transport.changePermissionMode("plan");
      await nextEvent(iterator);
      const plan = `# Implementation plan\n${"Read, edit, verify.\n".repeat(100)}`;
      transport.event({
        type: "interaction.requested",
        request: { type: "planApproval", requestId: "exit-plan", plan },
      });
      const interaction = await nextInteraction(iterator);
      expect(interaction).toMatchObject({
        type: "question",
        title: "Review plan",
        questions: [
          {
            id: "plan-decision",
            type: "choice",
            multiple: false,
            allowOther: false,
            optional: false,
            options: [
              { value: "stay", label: "Stay in plan mode" },
              { value: "approve", label: "Approve plan and exit plan mode" },
            ],
          },
        ],
      });
      if (interaction.type !== "question") throw new Error("Expected a plan review Question");
      expect(interaction.questions[0]?.prompt).toContain(plan);
      expect(interaction.questions[0]?.prompt).toContain(
        "restore the permission mode used before planning",
      );
      for (const response of [
        { type: "approval" as const, actionId: "allowOnce" },
        { type: "question" as const, answers: { "plan-decision": ["allowOnce"] } },
        { type: "question" as const, answers: { "plan-decision": ["approve", "stay"] } },
        { type: "question" as const, answers: {} },
      ]) {
        await expect(
          session.execute({
            type: "interaction.respond",
            interactionId: interaction.interactionId,
            response,
          }),
        ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      }
      expect(transport.respondToInteraction).not.toHaveBeenCalled();
      await expect(
        session.execute({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response:
            choice === "cancel"
              ? { type: "question", answers: {}, cancelled: true }
              : { type: "question", answers: { "plan-decision": [choice] } },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(transport.respondToInteraction).toHaveBeenLastCalledWith({
        type: "approval",
        requestId: "exit-plan",
        decision: choice === "approve" ? "allowOnce" : "deny",
      });
      expect(transport.setPermissionMode).not.toHaveBeenCalled();
      expect(await nextEvent(iterator)).toMatchObject({
        type: "interaction.closed",
        interactionId: interaction.interactionId,
      });
      await expect(
        session.execute({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response: { type: "question", answers: { "plan-decision": ["approve"] } },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
      transport.finish({ status: "succeeded" });
      await session.close();
    },
  );

  it("does not offer plan approval when Claude provides no plan text", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("missing-plan"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.event({
      type: "interaction.requested",
      request: { type: "planApproval", requestId: "exit-plan", plan: null },
    });
    const interaction = await nextInteraction(iterator);
    expect(interaction).toMatchObject({
      type: "question",
      questions: [{ options: [{ value: "stay" }] }],
    });
    if (interaction.type !== "question" || interaction.questions[0]?.type !== "choice")
      throw new Error("Expected plan choice");
    expect(interaction.questions[0].options).toHaveLength(1);
    expect(interaction.questions[0].prompt).toContain("did not provide plan text");
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { "plan-decision": ["approve"] } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(transports[0]?.respondToInteraction).not.toHaveBeenCalled();
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("maps independent native Approvals to bounded Host actions and exact responses", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("approvals"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "transport-approval-1",
      title: "Allow Edit?",
      description: "One-shot edit permission",
    });
    transports[0]?.approval({
      type: "approval",
      requestId: "transport-approval-2",
      title: "Allow Bash?",
    });
    const allowInteraction = await nextInteraction(iterator);
    const denyInteraction = await nextInteraction(iterator);
    expect(allowInteraction).toMatchObject({
      type: "approval",
      title: "Allow Edit?",
      description: "One-shot edit permission",
      subject: { type: "nativeAction" },
      actions: [
        { id: "allowOnce", label: "Allow once", effect: "allowOnce" },
        { id: "deny", label: "Deny", effect: "deny" },
      ],
    });
    expect(denyInteraction).toMatchObject({ type: "approval", title: "Allow Bash?" });
    expect(allowInteraction.interactionId).not.toBe(denyInteraction.interactionId);
    expect(JSON.stringify(allowInteraction)).not.toContain("transport-approval-1");

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowInteraction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowInteraction.interactionId,
        response: { type: "approval", actionId: "allowForSession" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: denyInteraction.interactionId,
        response: { type: "approval", actionId: "deny" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transports[0]?.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "transport-approval-2",
      decision: "deny",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: denyInteraction.interactionId,
      reason: "responded",
    });

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowInteraction.interactionId,
        response: { type: "approval", actionId: "allowOnce" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transports[0]?.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "transport-approval-1",
      decision: "allowOnce",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: allowInteraction.interactionId,
      reason: "responded",
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowInteraction.interactionId,
        response: { type: "approval", actionId: "allowOnce" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });

    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("maps declared native suggestion scopes without exposing suggestions", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("approval-scopes"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "session-approval",
      title: "Allow Edit?",
      suggestedScope: "session",
    });
    transports[0]?.approval({
      type: "approval",
      requestId: "always-approval",
      title: "Allow Bash?",
      suggestedScope: "always",
    });
    const sessionInteraction = await nextInteraction(iterator);
    const alwaysInteraction = await nextInteraction(iterator);
    expect(sessionInteraction).toMatchObject({
      type: "approval",
      actions: expect.arrayContaining([
        {
          id: "allowForSession",
          label: "Allow this conversation",
          effect: "allowForSession",
        },
      ]),
    });
    expect(alwaysInteraction).toMatchObject({
      type: "approval",
      actions: expect.arrayContaining([
        { id: "allowAlways", label: "Always allow", effect: "allowAlways" },
      ]),
    });
    expect(JSON.stringify([sessionInteraction, alwaysInteraction])).not.toContain(
      "session-approval",
    );

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: sessionInteraction.interactionId,
        response: { type: "approval", actionId: "allowAlways" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await session.execute({
      type: "interaction.respond",
      interactionId: sessionInteraction.interactionId,
      response: { type: "approval", actionId: "allowForSession" },
    });
    expect(transports[0]?.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "session-approval",
      decision: "allowForSession",
    });
    await nextEvent(iterator);
    await session.execute({
      type: "interaction.respond",
      interactionId: alwaysInteraction.interactionId,
      response: { type: "approval", actionId: "allowAlways" },
    });
    expect(transports[0]?.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "always-approval",
      decision: "allowAlways",
    });
    await nextEvent(iterator);

    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("closes a pending Approval before Session-close Turn terminals", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("close-approval"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "close-approval-request",
      title: "Allow pending action?",
    });
    const interaction = await nextInteraction(iterator);

    await session.close();
    const terminalEvents = [];
    for (;;) {
      const output = await iterator.next();
      if (output.done) break;
      if (output.value.kind === "event") terminalEvents.push(output.value.event);
    }
    const closedIndex = terminalEvents.findIndex(
      (event) =>
        event.type === "interaction.closed" && event.interactionId === interaction.interactionId,
    );
    const turnIndex = terminalEvents.findIndex((event) => event.type === "turn.completed");
    expect(closedIndex).toBeGreaterThanOrEqual(0);
    expect(closedIndex).toBeLessThan(turnIndex);
    expect(
      terminalEvents.filter(
        (event) =>
          event.type === "interaction.closed" && event.interactionId === interaction.interactionId,
      ),
    ).toHaveLength(1);
    expect(transports[0]?.close).toHaveBeenCalledOnce();
  });

  it("round-trips native multiple, multi-select, and Other Questions then continues", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("question"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.question({
      type: "question",
      requestId: "question-request",
      questions: [
        {
          question: "Which path?",
          header: "Path",
          options: [
            { label: "Alpha", description: "First" },
            { label: "Beta", description: "Second" },
          ],
          multiSelect: false,
        },
        {
          question: "Which features?",
          header: "Features",
          options: [
            { label: "Search", description: "Enable search" },
            { label: "Export", description: "Enable export" },
          ],
          multiSelect: true,
        },
      ],
    });
    const interaction = await nextInteraction(iterator);
    expect(interaction).toMatchObject({
      type: "question",
      title: "Claude Code",
      questions: [
        {
          id: "question-1",
          type: "choice",
          multiple: false,
          allowOther: true,
          options: [{ value: "Alpha", description: "First" }, { value: "Beta" }],
        },
        {
          id: "question-2",
          type: "choice",
          multiple: true,
          allowOther: true,
        },
      ],
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { "question-1": ["Alpha"] } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: {
          type: "question",
          answers: {
            "question-1": ["Alpha"],
            "question-2": ["Search", "Custom feature"],
          },
        },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transports[0]?.respondToInteraction).toHaveBeenCalledWith({
      type: "question",
      requestId: "question-request",
      answers: {
        "Which path?": "Alpha",
        "Which features?": "Search, Custom feature",
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: interaction.interactionId,
      reason: "responded",
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    await session.execute(textTurn("continued"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.delta("continued");
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    await session.close();
  });

  it("maps Desktop dismissal to native Question cancellation", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("dismissed"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.question({
      type: "question",
      requestId: "dismiss-request",
      questions: [
        {
          question: "Continue?",
          header: "Continue",
          options: [
            { label: "Yes", description: "Continue" },
            { label: "No", description: "Stop" },
          ],
          multiSelect: false,
        },
      ],
    });
    const interaction = await nextInteraction(iterator);
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transports[0]?.respondToInteraction).toHaveBeenCalledWith({
      type: "question",
      requestId: "dismiss-request",
      cancelled: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      reason: "cancelled",
    });
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("maps proven cancellation and continues on the same Transport", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("cancelled"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "cancel-request",
      title: "Allow pending native action?",
    });
    const cancelledInteraction = await nextInteraction(iterator);
    const cancel = {
      type: "turn.cancel" as const,
      turnId: hostTurnIdSchema.parse("cancelled"),
    };
    await expect(session.execute(cancel)).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    await expect(session.execute(cancel)).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transports[0]?.abort).toHaveBeenCalledOnce();
    transports[0]?.event({
      type: "interaction.closed",
      requestId: "cancel-request",
      reason: "cancelled",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: cancelledInteraction.interactionId,
      reason: "cancelled",
    });
    transports[0]?.finish({ status: "cancelled", reason: "aborted_streaming" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });

    await expect(session.execute(textTurn("continued"))).resolves.toMatchObject({ ok: true });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    expect(transports).toHaveLength(1);
    await session.close();
  });

  it("kills a hung interrupt and continues on a resumed Transport", async () => {
    const { adapter, dependencies, transports } = fixture({ cancelTimeoutMs: 20 });
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("hung"));
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.abort.mockImplementation(async () => new Promise(() => undefined));

    await expect(
      session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("hung") }),
    ).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled", reason: "Cancelled by user" },
    });
    expect(transports[0]?.close).toHaveBeenCalled();

    await expect(session.execute(textTurn("after-kill"))).resolves.toMatchObject({ ok: true });
    expect(transports).toHaveLength(2);
    expect(dependencies.createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ openMode: "resume" }),
    );
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[1]?.finish({ status: "succeeded" });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    await session.close();
  });

  it("escalates an acked interrupt that never ends the Turn", async () => {
    const { adapter, transports } = fixture({ cancelTimeoutMs: 20 });
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("acked"));
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");

    await expect(
      session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("acked") }),
    ).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transports[0]?.abort).toHaveBeenCalledOnce();
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled", reason: "Cancelled by user" },
    });
    expect(transports[0]?.close).toHaveBeenCalled();

    await expect(session.execute(textTurn("after-escalate"))).resolves.toMatchObject({ ok: true });
    expect(transports).toHaveLength(2);
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[1]?.finish({ status: "succeeded" });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    await session.close();
  });

  it("keeps an escalated cancellation busy until the old Transport closes", async () => {
    const { adapter, transports } = fixture({ cancelTimeoutMs: 10 });
    const session = await openSession(adapter);
    const events: HarnessOutput[] = [];
    const consuming = (async () => {
      for await (const output of session.outputs) events.push(output);
    })();
    await session.execute(textTurn("retiring"));
    const transport = transports[0];
    if (!transport) throw new Error("Expected an active Transport");
    const stopped = Promise.withResolvers<undefined>();
    transport.close.mockImplementation(() => stopped.promise);
    await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("retiring") });
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalled());
    // A late cancelled frame also does not prove that owned processes have exited.
    transport.finish({ status: "cancelled", reason: "aborted_streaming" });
    await Promise.resolve();
    try {
      await expect(session.readSnapshot()).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      expect(
        events.some((output) => output.kind === "event" && output.event.type === "turn.completed"),
      ).toBe(false);
      await expect(session.execute(textTurn("too-early"))).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      expect(transports).toHaveLength(1);
    } finally {
      stopped.resolve(undefined);
      await session.close();
      await consuming;
    }
  });

  it("does not confirm Session close while a hard-cancelled Transport is still stopping", async () => {
    const { adapter, transports } = fixture({ cancelTimeoutMs: 10 });
    const session = await openSession(adapter);
    await session.execute(textTurn("retiring-close"));
    const transport = transports[0];
    if (!transport) throw new Error("Expected an active Transport");
    const stopped = Promise.withResolvers<undefined>();
    transport.close.mockImplementation(() => stopped.promise);
    await session.execute({
      type: "turn.cancel",
      turnId: hostTurnIdSchema.parse("retiring-close"),
    });
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalled());
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
    } finally {
      stopped.resolve(undefined);
      await closing;
    }
  });

  it("retains a failed hard-cancel Transport and rejects reuse and confirmed close", async () => {
    const { adapter, transports } = fixture({ cancelTimeoutMs: 10 });
    const session = await openSession(adapter);
    const events: HarnessOutput[] = [];
    const consuming = (async () => {
      for await (const output of session.outputs) events.push(output);
    })();
    await session.execute(textTurn("failed-close"));
    const transport = transports[0];
    if (!transport) throw new Error("Expected an active Transport");
    transport.close.mockRejectedValue(new Error("native process remains alive"));
    await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("failed-close") });
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalled());
    await expect(session.execute(textTurn("unsafe-retry"))).resolves.toMatchObject({ ok: false });
    expect(transports).toHaveLength(1);
    await expect(session.close()).rejects.toThrow("could not stop safely");
    await consuming;
    expect(
      events.some((output) => output.kind === "event" && output.event.type === "session.faulted"),
    ).toBe(true);
  });

  it("maps failed native results without faulting a reusable Session", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("failed"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "failed", kind: "authentication" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "failed", error: { code: "authenticationRequired" } } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed", error: { code: "authenticationRequired" } },
    });
    await expect(session.execute(textTurn("retry"))).resolves.toMatchObject({ ok: true });
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("finalizes an active Turn before a Query fault", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("faulted"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "fault-request",
      title: "Allow pending native action?",
    });
    await nextInteraction(iterator);
    transports[0]?.fault(new Error("synthetic Query fault"));

    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      reason: "cancelled",
    });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.faulted",
      error: { code: "processExited" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects missing installation before acceptance without outputs", async () => {
    const dependencies: ClaudeAdapterDependencies = {
      randomUUID: () => "claude-id",
      bypassPermissionsAvailable: () => true,
      inspectInstallation: () => undefined,
      createInspector: () => ({
        inspect: async () => ({
          models: [],
          canSelectModel: false,
          canSelectPermissionMode: false,
        }),
        close: async () => undefined,
      }),
      deleteSession: async () => undefined,
      forkSession: async () => ({ sessionId: "derived-session" }),
      getSessionInfo: async () => ({ cwd: "/synthetic" }),
      readSessionMessages: async () => [],
      readSubagentMessages: async () => [],
      createTransport: () => ({
        sessionId: "claude-id",
        hasBackgroundTasks: () => false,
        stopBackgroundTask: async () => undefined,
        stopTasks: async () => undefined,
        setEventHandler: () => undefined,
        submitInput: async () => undefined,
        cancelInput: async () => false,
        isRunning: () => false,
        start: async () => {
          throw new ClaudeCodeExecutableError("Claude Code is not installed");
        },
        getContextUsage: async () => null,
        getPermissionMode: () => "default",
        setModel: async () => undefined,
        setThinkingOption: async () => undefined,
        setPermissionMode: async () => undefined,
        respondToInteraction: async () => undefined,
        abort: async () => ({ stillQueued: [] }),
        close: async () => undefined,
      }),
    };
    const adapter = new ClaudeCodeAdapter({}, dependencies);
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(session.execute(textTurn("missing"))).resolves.toMatchObject({
      ok: false,
      error: { code: "notInstalled" },
    });
    await session.close();
    // Only the empty usage history of the new Session precedes the end of outputs.
    await expect(nextOutput(iterator)).resolves.toEqual({ done: true, value: undefined });
  });

  it("closes an in-flight Inspector before Adapter close resolves", async () => {
    const { adapter, dependencies } = fixture();
    const pending = deferred<{
      models: unknown[];
      canSelectModel: boolean;
      canSelectPermissionMode: boolean;
    }>();
    const close = vi.fn(async () => {
      pending.resolve({
        models: [],
        canSelectModel: false,
        canSelectPermissionMode: false,
      });
    });
    vi.mocked(dependencies.createInspector).mockReturnValueOnce({
      inspect: () => pending.promise,
      close,
    });

    const inspecting = adapter.inspect({ cwd: "/closing" });
    await expect(adapter.close()).resolves.toBeUndefined();
    await expect(inspecting).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "unavailable", retryable: false },
    });
    expect(close).toHaveBeenCalled();
    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "invalidState" },
    });
  });

  it("closes all Sessions idempotently", async () => {
    const { adapter } = fixture();
    await openSession(adapter);
    await openSession(adapter);

    await expect(Promise.all([adapter.close(), adapter.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
  it.each([true, false])(
    "uses the continuation checkpoint without faulting the Session (history available: %s)",
    async (available) => {
      const { adapter, transports, dependencies } = fixture();
      const session = await openSession(adapter);
      const outputs: HarnessOutput[] = [];
      const drain = (async () => {
        for await (const output of session.outputs) outputs.push(output);
      })();
      await session.execute(textTurn("identity-seed"));
      const transport = transports[0];
      if (!transport) throw new Error("Transport missing");
      transport.finish({ status: "succeeded" });
      const terminals = () =>
        outputs.filter((o) => o.kind === "event" && o.event.type === "turn.completed");
      await vi.waitFor(() => expect(terminals()).toHaveLength(1));
      const input = (uuid: string) => ({
        type: "user",
        uuid,
        session_id: transport.sessionId,
        origin: { kind: "task-notification" },
        message: { role: "user", content: "notification" },
      });
      vi.mocked(dependencies.readSessionMessages).mockResolvedValue(
        available
          ? [
              input("notification-with-no-output"),
              input("correct-notification"),
              {
                type: "assistant",
                uuid: "checkpoint",
                session_id: transport.sessionId,
                message: { role: "assistant", content: [{ type: "text", text: "continued" }] },
              },
              input("later-notification"),
            ]
          : [],
      );
      const handler = transport.beginContinuation?.();
      if (!handler) throw new Error("Handler missing");
      handler.onEvent({ type: "text.delta", messageId: "reply", delta: "continued" });
      handler.onEvent({
        type: "message.completed",
        messageId: "reply",
        checkpointId: "checkpoint",
      });
      await handler.onTerminal({ status: "succeeded" });
      await vi.waitFor(() => expect(terminals()).toHaveLength(2));
      expect(terminals().at(-1)).toMatchObject({
        event: available
          ? {
              nativeTurnRef: { nativeTurnKey: "correct-notification" },
              outcome: { status: "succeeded" },
            }
          : {
              outcome: {
                status: "failed",
                error: { message: "Claude continuation native identity is unavailable" },
              },
            },
      });
      expect(outputs.some((o) => o.kind === "event" && o.event.type === "session.faulted")).toBe(
        false,
      );
      await expect(session.execute(textTurn("next"))).resolves.toMatchObject({ ok: true });
      transport.finish({ status: "succeeded" });
      await session.close();
      await drain;
    },
  );
});

async function nextOutputMatching(
  iterator: AsyncIterator<HarnessOutput>,
  predicate: (output: HarnessOutput) => boolean,
): Promise<HarnessOutput[]> {
  const outputs: HarnessOutput[] = [];
  for (;;) {
    const output = await iterator.next();
    if (output.done) throw new Error("Harness output ended unexpectedly");
    outputs.push(output.value);
    if (predicate(output.value)) return outputs;
  }
}

const eventOutputs = (outputs: HarnessOutput[]) =>
  outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));

describe("Claude Code Ultracode selection", () => {
  const ultracode = harnessThinkingOptionIdSchema.parse("ultracode");

  it("aborts the message and keeps Ultracode selected when Claude Code rejects it at startup", async () => {
    const { adapter, dependencies, transports } = fixture();
    const createTransport = dependencies.createTransport;
    vi.mocked(createTransport).mockImplementation((input) => {
      const transport = new FakeClaudeTransport(
        input.sessionId,
        input.permissionMode,
        input.onPermissionModeChanged,
        input.onPlanLimit,
        input.onFault,
      );
      transport.start.mockRejectedValueOnce(
        new ClaudeUltracodeUnavailableError("workflowsDisabled"),
      );
      transports.push(transport);
      return transport;
    });
    const session = await openSession(adapter);
    await expect(
      session.execute({ type: "thinking.select", thinkingOptionId: ultracode }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });

    for (const turn of ["first", "second"]) {
      await expect(session.execute(textTurn(turn))).resolves.toEqual({
        ok: false,
        error: {
          code: "configurationRequired",
          message: expect.stringContaining("Dynamic workflows"),
          retryable: true,
        },
      });
    }
    expect(vi.mocked(createTransport).mock.calls.map(([input]) => input.thinkingOptionId)).toEqual([
      ultracode,
      ultracode,
    ]);
    expect(transports.every((transport) => transport.turns.length === 0)).toBe(true);
    await session.close();
  });

  it("keeps the confirmed option when a live switch to Ultracode is rejected", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("start"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    transport.setThinkingOption.mockRejectedValueOnce(
      new ClaudeUltracodeUnavailableError("unsupportedVersion"),
    );
    await expect(
      session.execute({ type: "thinking.select", thinkingOptionId: ultracode }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "unsupported",
        message: expect.stringContaining("2.1.154"),
        retryable: false,
      },
    });
    transport.setModel.mockRejectedValueOnce(
      new ClaudeUltracodeUnavailableError("modelUnsupported"),
    );
    await expect(
      session.execute({ type: "model.select", model: encodeClaudeModelRef("haiku") }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    // Neither rejected selection was published.
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveThinkingOptionId: "high", effectiveModel: CLAUDE_DEFAULT_MODEL_REF },
    });
    await session.close();
  });
});

describe("Claude Code Workflow runs", () => {
  async function launchWorkflow(options: ClaudeCodeAdapterOptions = {}) {
    const { adapter, transports } = fixture(options);
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("run a workflow"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({ type: "workflow.started", callId: "workflow-call" });
    transport.event({
      type: "workflow.updated",
      callId: "workflow-call",
      taskId: "workflow-task",
      description: "Count lines",
    });
    const started = eventOutputs(
      await nextOutputMatching(
        iterator,
        (output) =>
          output.kind === "event" &&
          output.event.type === "item.started" &&
          output.event.item.type === "subagentDelegation",
      ),
    ).at(-1);
    expect(started).toMatchObject({
      type: "item.started",
      item: {
        type: "subagentDelegation",
        operation: "spawn",
        prompt: "Count lines",
        subagents: [],
      },
    });
    transport.event({
      type: "workflow.launched",
      callId: "workflow-call",
      isError: false,
      background: true,
      taskId: "workflow-task",
    });
    transport.event({
      type: "workflow.updated",
      callId: "workflow-call",
      agents: [
        {
          index: 1,
          label: "count:a.txt",
          state: "running",
          agentId: "agent-a",
          phaseTitle: "Count",
        },
      ],
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "subagents.replace",
        subagents: [
          {
            subagentId: "workflow-call:1",
            nativeSubagentId: "agent-a",
            description: "count:a.txt",
            role: "Count",
            status: "running",
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "subagent.transcript.changed",
      nativeSubagentId: "agent-a",
    });
    return { iterator, session, transport };
  }

  it("keeps a launched run working after its Turn and settles it at Session level", async () => {
    const { iterator, session, transport } = await launchWorkflow();
    // An agent approval is answerable while the Root Segment that owns its run is live.
    transport.approval({
      type: "approval",
      requestId: "agent-approval",
      title: "count:a.txt: Bash",
    });
    const interaction = await nextInteraction(iterator);
    expect(interaction).toMatchObject({ type: "approval", title: "count:a.txt: Bash" });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "approval", actionId: "allowOnce" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(transport.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "agent-approval",
      decision: "allowOnce",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: interaction.interactionId,
      reason: "responded",
    });

    transport.delta("The workflow is running", "root-1");
    transport.event({ type: "message.completed", messageId: "root-1" });
    transport.finish({ status: "succeeded" });
    const rootOutputs = eventOutputs(
      await nextOutputMatching(
        iterator,
        (output) => output.kind === "event" && output.event.type === "turn.completed",
      ),
    );
    // Like a background Subagent, the launch completes with the Turn while its agents run on.
    expect(rootOutputs).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        snapshot: expect.objectContaining({
          outcome: { status: "succeeded" },
          item: expect.objectContaining({
            type: "subagentDelegation",
            subagents: [
              expect.objectContaining({ nativeSubagentId: "agent-a", status: "running" }),
            ],
          }),
        }),
      }),
    );
    expect(rootOutputs.at(-1)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    // Background work does not occupy the input entry.
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({ ok: true });
    transport.finish({ status: "succeeded" });
    await nextOutputMatching(
      iterator,
      (output) => output.kind === "event" && output.event.type === "turn.completed",
    );

    // Agent activity after the Turn still refreshes the running agent's transcript.
    transport.event({ type: "workflow.activity", callId: "workflow-call" });
    expect(await nextEvent(iterator)).toEqual({
      type: "subagent.transcript.changed",
      nativeSubagentId: "agent-a",
    });
    transport.event({
      type: "subagent.settled",
      nativeSubagentId: "workflow-task",
      callId: "workflow-call",
      status: "completed",
      resultSummary: "Count lines",
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "subagent.state.changed",
      nativeSubagentId: "agent-a",
      status: "completed",
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "subagent.transcript.changed",
      nativeSubagentId: "agent-a",
    });
    await session.close();
  });

  it("stops the Turn's launched run natively when the user cancels the Turn", async () => {
    const { iterator, session, transport } = await launchWorkflow();
    await expect(
      session.execute({
        type: "turn.cancel",
        turnId: hostTurnIdSchema.parse("run a workflow"),
      }),
    ).resolves.toEqual({ ok: true, value: { cancellationRequested: true } });
    // The stop is confirmed natively before the Root Segment is interrupted.
    expect(transport.stopTasks).toHaveBeenCalledWith(["workflow-task"]);
    expect(transport.abort).toHaveBeenCalledWith(1);
    transport.event({
      type: "subagent.settled",
      nativeSubagentId: "workflow-task",
      status: "interrupted",
    });
    transport.finish({ status: "cancelled", reason: "Cancelled by user" });
    const outputs = eventOutputs(
      await nextOutputMatching(
        iterator,
        (output) => output.kind === "event" && output.event.type === "turn.completed",
      ),
    );
    expect(outputs).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        snapshot: expect.objectContaining({
          outcome: { status: "cancelled", reason: "Workflow stopped" },
          item: expect.objectContaining({
            type: "subagentDelegation",
            subagents: [expect.objectContaining({ status: "interrupted" })],
          }),
        }),
      }),
    );
    expect(outputs.at(-1)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    await session.close();
  });

  it("fails a successful Root result that leaves the Workflow tool unanswered", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("broken workflow"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({ type: "workflow.started", callId: "workflow-call" });
    transport.finish({ status: "succeeded" });

    const outputs = eventOutputs(
      await nextOutputMatching(
        iterator,
        (output) => output.kind === "event" && output.event.type === "turn.completed",
      ),
    );
    expect(outputs.at(-1)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed", error: { code: "protocolError" } },
    });
    expect(outputs.some((event) => event.type === "item.started")).toBe(false);
    await session.close();
  });
});
