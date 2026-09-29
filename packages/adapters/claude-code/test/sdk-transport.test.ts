import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { PermissionUpdate, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";

import {
  ClaudeSdkModelInspector,
  ClaudeSdkTransport,
  type ClaudeSdkTransportOptions,
} from "../src/sdk-transport.js";
import {
  type ClaudeTransportTurnResult,
  type ClaudeSessionEvent,
  type ClaudeTurnEvent,
} from "../src/transport.js";
import { FakeQuery } from "./fake-sdk-query.js";

type QueryInput = Parameters<NonNullable<ClaudeSdkTransportOptions["queryFactory"]>>[0];

function fixture(
  openMode: "create" | "resume" = "create",
  permissionMode: ClaudeSdkTransportOptions["permissionMode"] = "default",
  thinkingOptionId = harnessThinkingOptionIdSchema.parse("auto"),
  environment?: NodeJS.ProcessEnv,
  allowDangerouslySkipPermissions = true,
) {
  const fakeQuery = new FakeQuery();
  let queryInput: QueryInput | undefined;
  const queryFactory: NonNullable<ClaudeSdkTransportOptions["queryFactory"]> = vi.fn((input) => {
    queryInput = input;
    return fakeQuery as unknown as Query;
  });
  const onFault = vi.fn();
  const onPermissionModeChanged = vi.fn();
  const onPlanLimit = vi.fn();
  const transport = new ClaudeSdkTransport({
    command: process.execPath,
    ...(environment ? { environment } : {}),
    cwd: process.cwd(),
    sessionId: "00000000-0000-4000-8000-000000000001",
    openMode,
    permissionMode,
    thinkingOptionId,
    allowDangerouslySkipPermissions,
    closeTimeoutMs: 100,
    onPermissionModeChanged,
    onFault,
    onPlanLimit,
    queryFactory,
  });
  let activeSegment: number | undefined;
  let continuations: ObservedTurn[] = [];
  let threadHandler: ((event: ClaudeTurnEvent) => void) | null = null;
  const pending = new Map<
    string,
    {
      onEvent(event: ClaudeTurnEvent): void;
      resolve(result: ClaudeTransportTurnResult): void;
      reject(error: unknown): void;
    }
  >();
  const segments = new Map<
    number,
    { onEvent(event: ClaudeTurnEvent): void; resolve(result: ClaudeTransportTurnResult): void }
  >();
  transport.setEventHandler((event: ClaudeSessionEvent) => {
    if (event.type === "thread.event") {
      threadHandler?.(event.event);
      return;
    }
    if (event.type === "segment.started") {
      activeSegment = event.segmentId;
      const observer = pending.get(event.inputIds[0] ?? "");
      if (observer) {
        segments.set(event.segmentId, observer);
        pending.delete(event.inputIds[0] as string);
      } else {
        const turn: ObservedTurn = {
          nativeTurnKey: event.inputIds[0],
          events: [],
          terminal: undefined,
        };
        continuations.push(turn);
        segments.set(event.segmentId, {
          onEvent: (e) => turn.events.push(e),
          resolve: (result) => {
            turn.terminal = result;
          },
        });
      }
    } else if (event.type === "segment.event") segments.get(event.segmentId)?.onEvent(event.event);
    else if (event.type === "segment.completed") {
      segments.get(event.segmentId)?.resolve(event.result);
      segments.delete(event.segmentId);
      activeSegment = undefined;
    }
  });
  const close = transport.close.bind(transport);
  transport.close = async () => {
    await close();
    for (const observer of pending.values())
      observer.reject(new Error("Claude SDK transport closed"));
    for (const observer of segments.values()) {
      if ("reject" in observer)
        (observer as { reject(error: Error): void }).reject(
          new Error("Claude SDK transport closed"),
        );
    }
  };
  function startTurn(
    text: string,
    id: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult> {
    const result = new Promise<ClaudeTransportTurnResult>((resolve, reject) => {
      pending.set(id, { onEvent, resolve, reject });
    });
    void transport
      .submitInput(text, id, "later")
      .catch((error: unknown) => pending.get(id)?.reject(error));
    fakeQuery.push({
      type: "command_lifecycle",
      state: "queued",
      command_uuid: id,
    } as unknown as SDKMessage);
    fakeQuery.push({
      type: "command_lifecycle",
      state: "started",
      command_uuid: id,
    } as unknown as SDKMessage);
    fakeQuery.push({ type: "system", subtype: "init" } as SDKMessage);
    return result;
  }
  return {
    fakeQuery,
    onFault,
    onPermissionModeChanged,
    onPlanLimit,
    queryFactory,
    transport,
    startTurn,
    compact: (
      id: string,
      instructions: string | undefined,
      onEvent: (event: ClaudeTurnEvent) => void,
    ) => startTurn(`/compact${instructions ? ` ${instructions}` : ""}`, id, onEvent),
    init: (id: string, onEvent: (event: ClaudeTurnEvent) => void) =>
      startTurn("/init", id, onEvent),
    recap: (id: string, onEvent: (event: ClaudeTurnEvent) => void) =>
      startTurn("/recap", id, onEvent),
    steer: (text: string, id: string) => transport.submitInput(text, id, "next"),
    abort: async () => {
      await vi.waitFor(() => expect(activeSegment).toBeDefined());
      await transport.abort(activeSegment as number);
    },
    observeContinuations: (turns: ObservedTurn[]) => {
      continuations = turns;
    },
    observeThreadEvents: (handler: ((event: ClaudeTurnEvent) => void) | null) => {
      threadHandler = handler;
    },
    queryInput: () => {
      if (!queryInput) throw new Error("SDK query was not created");
      return queryInput;
    },
  };
}

interface ObservedTurn {
  nativeTurnKey: string | undefined;
  events: ClaudeTurnEvent[];
  terminal: ClaudeTransportTurnResult | undefined;
}

function completeTurn(fakeQuery: FakeQuery): void {
  fakeQuery.push({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
  } as unknown as SDKMessage);
}

function pushPartialText(
  fakeQuery: FakeQuery,
  text: string,
  uuid = "00000000-0000-4000-8000-000000000020",
): void {
  fakeQuery.push({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    parent_tool_use_id: null,
    uuid,
    session_id: "00000000-0000-4000-8000-000000000001",
  } as unknown as SDKMessage);
}

function pushAssistantText(
  fakeQuery: FakeQuery,
  text: string,
  uuid = "00000000-0000-4000-8000-000000000021",
): void {
  fakeQuery.push({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid,
    session_id: "00000000-0000-4000-8000-000000000001",
  } as unknown as SDKMessage);
}

function pushToolUse(
  fakeQuery: FakeQuery,
  callId: string,
  toolName: string,
  input: Record<string, unknown>,
  uuid = "00000000-0000-4000-8000-000000000031",
): void {
  fakeQuery.push({
    type: "assistant",
    uuid,
    session_id: "00000000-0000-4000-8000-000000000001",
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: "tool_use",
          id: callId,
          name: toolName,
          input,
        },
      ],
    },
  } as unknown as SDKMessage);
}

function completeTool(
  fakeQuery: FakeQuery,
  callId: string,
  content = "done",
  isError = false,
  uuid = "00000000-0000-4000-8000-000000000033",
): void {
  fakeQuery.push({
    type: "user",
    uuid,
    session_id: "00000000-0000-4000-8000-000000000001",
    parent_tool_use_id: callId,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: callId, content, is_error: isError }],
    },
  } as unknown as SDKMessage);
}

function options(value: ReturnType<typeof fixture>): NonNullable<QueryInput["options"]> {
  const queryOptions = value.queryInput().options;
  if (!queryOptions) throw new Error("SDK query options are missing");
  return queryOptions;
}

function questionInput() {
  return {
    questions: [
      {
        question: "Which path?",
        header: "Path",
        options: [
          { label: "Alpha", description: "First", preview: "ignored" },
          { label: "Beta", description: "Second" },
        ],
        multiSelect: false,
      },
    ],
  };
}

describe("ClaudeSdkTransport context Usage", () => {
  it("reads the stable Query context operation and rejects invalid observations", async () => {
    const value = fixture();

    await expect(value.transport.getContextUsage()).resolves.toBeNull();
    expect(value.fakeQuery.getContextUsage).not.toHaveBeenCalled();

    await value.transport.start();
    await expect(value.transport.getContextUsage()).resolves.toEqual({
      usedTokens: 40,
      maxTokens: 200,
      model: "runtime-model",
    });

    value.fakeQuery.getContextUsage.mockResolvedValueOnce({
      totalTokens: -1,
      maxTokens: 0,
      model: "",
    });
    await expect(value.transport.getContextUsage()).rejects.toThrow("invalid values");

    value.fakeQuery.getContextUsage.mockRejectedValueOnce(new Error("context unavailable"));
    await expect(value.transport.getContextUsage()).rejects.toThrow("context unavailable");
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport usage metering", () => {
  it("publishes a finished model request at Session scope outside its Segment", async () => {
    const value = fixture();
    const threadEvents: ClaudeTurnEvent[] = [];
    value.observeThreadEvents((event) => threadEvents.push(event));
    await value.transport.start();
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("hello", "00000000-0000-4000-8000-000000000010", (event) =>
      events.push(event),
    );
    for (const event of [
      {
        type: "message_start",
        message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 5 } },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "message_delta", delta: {}, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]) {
      value.fakeQuery.push({
        type: "stream_event",
        event,
        parent_tool_use_id: null,
        uuid: "00000000-0000-4000-8000-000000000011",
        session_id: "00000000-0000-4000-8000-000000000001",
      } as unknown as SDKMessage);
    }
    completeTurn(value.fakeQuery);
    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(threadEvents).toEqual([
      {
        type: "usage.request",
        record: expect.objectContaining({
          kind: "request",
          request: expect.objectContaining({ requestId: "msg_1", outputTokens: 3 }),
        }),
      },
    ]);
    expect(events.some((event) => event.type === "usage.request")).toBe(false);
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport plan-limit forwarding", () => {
  it("forwards a tracked rate-limit event regardless of active Turn state", async () => {
    const value = fixture();
    await value.transport.start();

    value.fakeQuery.push({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 0.45, resetsAt: 1_787_674_200 },
          seven_day: { utilization: 0.1, resetsAt: 1_787_940_000 },
        },
      },
      uuid: "00000000-0000-4000-8000-000000000099",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    await vi.waitFor(() => expect(value.onPlanLimit).toHaveBeenCalledOnce());
    expect(value.onPlanLimit).toHaveBeenCalledWith({
      fiveHour: { utilizationPercent: 45, resetsAtUnix: 1_787_674_200 },
      sevenDay: { utilizationPercent: 10, resetsAtUnix: 1_787_940_000 },
    });
    await value.transport.close();
  });

  it("does not forward an untracked rate-limit type", async () => {
    const value = fixture();
    await value.transport.start();

    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000023", (event) =>
      events.push(event),
    );
    value.fakeQuery.push({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "overage", utilization: 45 },
      uuid: "00000000-0000-4000-8000-000000000099",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    completeTurn(value.fakeQuery);
    await turn;
    expect(value.onPlanLimit).not.toHaveBeenCalled();
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport text reconciliation", () => {
  it("keeps a permission-denial Tool loop successful when text surrounds the callback", async () => {
    const value = fixture();
    await value.transport.start();
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000022", (event) =>
      events.push(event),
    );

    pushPartialText(value.fakeQuery, "before");
    pushAssistantText(value.fakeQuery, "before tool\n");
    await vi.waitFor(() => {
      expect(events.filter(({ type }) => type === "text.delta")).toEqual([
        {
          type: "text.delta",
          messageId: "00000000-0000-4000-8000-000000000020",
          delta: "before",
        },
        {
          type: "text.delta",
          messageId: "00000000-0000-4000-8000-000000000020",
          delta: " tool\n",
        },
      ]);
    });

    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const permission = canUseTool(
      "Edit",
      { file_path: "/synthetic/file" },
      {
        signal: new AbortController().signal,
        toolUseID: "text-loop-tool",
        requestId: "text-loop-control",
        displayName: "Edit file",
      },
    );
    pushToolUse(value.fakeQuery, "text-loop-tool", "Edit", { file_path: "/synthetic/file" });
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) => event.type === "interaction.requested" && event.request.type === "approval",
        ),
      ).toBe(true),
    );
    const approval = events.find(
      (event) => event.type === "interaction.requested" && event.request.type === "approval",
    );
    if (!approval || approval.type !== "interaction.requested") {
      throw new Error("Approval was not emitted");
    }
    await value.transport.respondToInteraction({
      type: "approval",
      requestId: approval.request.requestId,
      decision: "deny",
    });
    await expect(permission).resolves.toMatchObject({
      behavior: "deny",
      decisionClassification: "user_reject",
    });

    pushPartialText(value.fakeQuery, "after", "00000000-0000-4000-8000-000000000023");
    pushAssistantText(value.fakeQuery, "after denial", "00000000-0000-4000-8000-000000000024");
    completeTool(value.fakeQuery, "text-loop-tool", "Permission denied", true);
    completeTurn(value.fakeQuery);

    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(
      events.flatMap((event) => (event.type === "text.delta" ? [event.delta] : [])).join(""),
    ).toBe("before tool\nafter denial");
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });

  it("publishes one automatic Compaction lifecycle before continued text", async () => {
    const value = fixture();
    await value.transport.start();
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000024", (event) =>
      events.push(event),
    );

    value.fakeQuery.push({
      type: "system",
      subtype: "status",
      status: "compacting",
      uuid: "00000000-0000-4000-8000-000000000025",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "success",
      uuid: "00000000-0000-4000-8000-000000000026",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 180, post_tokens: 30 },
      uuid: "00000000-0000-4000-8000-000000000027",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    pushAssistantText(value.fakeQuery, "continued", "00000000-0000-4000-8000-000000000028");
    completeTurn(value.fakeQuery);

    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(events).toEqual([
      { type: "compaction.started" },
      { type: "compaction.completed", outcome: "succeeded" },
      {
        type: "text.delta",
        messageId: "00000000-0000-4000-8000-000000000028",
        delta: "continued",
      },
      {
        type: "message.completed",
        messageId: "00000000-0000-4000-8000-000000000028",
        checkpointId: "00000000-0000-4000-8000-000000000028",
      },
    ]);
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });

  it("sends compact as /compact on the SDK input stream", async () => {
    const value = fixture();
    await value.transport.start();
    const events: ClaudeTurnEvent[] = [];
    const compact = value.compact(
      "00000000-0000-4000-8000-000000000043",
      "Keep implementation details",
      (event) => events.push(event),
    );
    const prompt = value.queryInput().prompt;
    if (typeof prompt === "string" || prompt === undefined) {
      throw new Error("SDK compact prompt stream was not configured");
    }
    const submitted = await prompt[Symbol.asyncIterator]().next();
    expect(submitted.value).toMatchObject({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000043",
      message: { role: "user", content: "/compact Keep implementation details" },
    });

    value.fakeQuery.push({
      type: "system",
      subtype: "status",
      status: "compacting",
      uuid: "00000000-0000-4000-8000-000000000040",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "success",
      uuid: "00000000-0000-4000-8000-000000000041",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    completeTurn(value.fakeQuery);

    await expect(compact).resolves.toEqual({ status: "succeeded" });
    expect(events).toEqual([
      { type: "compaction.started" },
      { type: "compaction.completed", outcome: "succeeded" },
    ]);
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });

  it("sends init and recap as slash commands on the SDK input stream", async () => {
    const value = fixture();
    await value.transport.start();
    const prompt = value.queryInput().prompt;
    if (typeof prompt === "string" || prompt === undefined) {
      throw new Error("SDK command prompt stream was not configured");
    }
    const iterator = prompt[Symbol.asyncIterator]();

    const init = value.init("00000000-0000-4000-8000-000000000044", () => undefined);
    expect((await iterator.next()).value).toMatchObject({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000044",
      message: { role: "user", content: "/init" },
    });
    completeTurn(value.fakeQuery);
    await expect(init).resolves.toEqual({ status: "succeeded" });

    const recapEvents: ClaudeTurnEvent[] = [];
    const recap = value.recap("00000000-0000-4000-8000-000000000045", (event) =>
      recapEvents.push(event),
    );
    expect((await iterator.next()).value).toMatchObject({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000045",
      message: { role: "user", content: "/recap" },
    });
    value.fakeQuery.push({
      type: "system",
      subtype: "local_command_output",
      content: "Built compact command and subagent projection.",
      uuid: "00000000-0000-4000-8000-000000000042",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    completeTurn(value.fakeQuery);
    await expect(recap).resolves.toEqual({ status: "succeeded" });
    expect(recapEvents).toEqual([
      {
        type: "text.delta",
        messageId: "00000000-0000-4000-8000-000000000042",
        delta: "Built compact command and subagent projection.",
      },
      {
        type: "message.completed",
        messageId: "00000000-0000-4000-8000-000000000042",
        checkpointId: "00000000-0000-4000-8000-000000000042",
      },
    ]);
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport Tool interpretation", () => {
  it("publishes correlated Tool and reliable native file events before the terminal", async () => {
    const value = fixture();
    await value.transport.start();
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000030", (event) =>
      events.push(event),
    );

    value.fakeQuery.push({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000031",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_use",
            id: "edit-1",
            name: "Edit",
            input: { file_path: "/synthetic/sample.txt" },
          },
        ],
      },
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "tool_progress",
      tool_use_id: "edit-1",
      tool_name: "Edit",
      parent_tool_use_id: null,
      elapsed_time_seconds: 0.5,
      uuid: "00000000-0000-4000-8000-000000000032",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as SDKMessage);
    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000033",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: "edit-1",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "edit-1", content: "edited", is_error: false },
        ],
      },
      tool_use_result: {
        filePath: "/synthetic/sample.txt",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old", "+new"],
          },
        ],
      },
    } as unknown as SDKMessage);
    completeTurn(value.fakeQuery);

    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(events).toEqual([
      {
        type: "tool.started",
        callId: "edit-1",
        toolName: "Edit",
        arguments: { file_path: "/synthetic/sample.txt" },
      },
      {
        type: "message.completed",
        messageId: "00000000-0000-4000-8000-000000000031",
        checkpointId: "00000000-0000-4000-8000-000000000031",
      },
      { type: "tool.progress", callId: "edit-1", elapsedMs: 500 },
      {
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
      },
    ]);
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });

  it("publishes Agent delegation while hiding nested Subagent execution", async () => {
    const value = fixture();
    await value.transport.start();
    expect(options(value).forwardSubagentText).toBe(true);
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("delegate", "00000000-0000-4000-8000-000000000034", (event) =>
      events.push(event),
    );

    value.fakeQuery.push({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000035",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: null,
      message: {
        id: "root-agent-message",
        content: [
          {
            type: "tool_use",
            id: "agent-1",
            name: "Agent",
            input: {
              description: "Inspect implementation",
              subagent_type: "Explore",
              run_in_background: true,
              prompt: "private prompt",
            },
          },
        ],
      },
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "agent-1",
      description: "Inspect implementation",
      subagent_type: "Explore",
      uuid: "00000000-0000-4000-8000-000000000036",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000037",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: "agent-1",
      message: {
        id: "nested-message",
        content: [
          { type: "text", text: "nested text" },
          { type: "tool_use", id: "nested-read", name: "Read", input: {} },
        ],
      },
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000038",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: "agent-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "nested-read",
            content: "nested contents",
            is_error: false,
          },
        ],
      },
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000039",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: "agent-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "agent-1",
            content: "Agent launched successfully",
            is_error: false,
          },
        ],
      },
    } as unknown as SDKMessage);
    completeTurn(value.fakeQuery);

    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(events).toEqual([
      {
        type: "subagent.started",
        operation: "spawn",
        callId: "agent-1",
        description: "Inspect implementation",
        prompt: "private prompt",
        role: "Explore",
        background: true,
      },
      {
        type: "message.completed",
        messageId: "root-agent-message",
        checkpointId: "00000000-0000-4000-8000-000000000035",
      },
      {
        type: "subagent.updated",
        callId: "agent-1",
        status: "running",
        description: "Inspect implementation",
        role: "Explore",
        nativeSubagentId: "task-1",
      },
      { type: "subagent.transcript.changed", callId: "agent-1" },
      { type: "subagent.transcript.changed", callId: "agent-1" },
      { type: "subagent.transcript.changed", callId: "agent-1" },
      {
        type: "subagent.completed",
        callId: "agent-1",
        isError: false,
        resultSummary: "Agent launched successfully",
      },
    ]);
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport autonomous task continuation", () => {
  it("publishes Root output produced after a background task notification", async () => {
    const value = fixture();
    const turns: ObservedTurn[] = [];
    const threadEvents: ClaudeTurnEvent[] = [];
    value.observeContinuations(turns);
    value.observeThreadEvents((event) => threadEvents.push(event));
    await value.transport.start();

    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000040",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: null,
      origin: { kind: "task-notification" },
      message: {
        role: "user",
        content:
          "<task-notification><task-id>native-agent-1</task-id><tool-use-id>send-1</tool-use-id><summary>Analysis complete</summary></task-notification>",
      },
    } as unknown as SDKMessage);
    pushPartialText(
      value.fakeQuery,
      "Background analysis result",
      "00000000-0000-4000-8000-000000000041",
    );
    pushAssistantText(
      value.fakeQuery,
      "Background analysis result",
      "00000000-0000-4000-8000-000000000042",
    );
    completeTurn(value.fakeQuery);

    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(threadEvents).toEqual([
      {
        type: "subagent.settled",
        callId: "send-1",
        nativeSubagentId: "native-agent-1",
        status: "completed",
        resultSummary: "Analysis complete",
      },
    ]);
    expect(turns[0]).toMatchObject({
      nativeTurnKey: undefined,
      terminal: { status: "succeeded" },
      events: [
        { type: "text.delta", delta: "Background analysis result" },
        { type: "message.completed" },
      ],
    });
    await value.transport.close();
  });

  it("preserves a failed task-notification whose user content is text blocks", async () => {
    const value = fixture();
    const turns: ObservedTurn[] = [];
    const threadEvents: ClaudeTurnEvent[] = [];
    value.observeContinuations(turns);
    value.observeThreadEvents((event) => threadEvents.push(event));
    await value.transport.start();

    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000050",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: null,
      origin: { kind: "task-notification" },
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<task-notification><task-id>a78414260bd2f9554</task-id><status>failed</status><summary>Agent failed</summary></task-notification>",
          },
        ],
      },
    } as unknown as SDKMessage);
    pushAssistantText(value.fakeQuery, "Continuation", "00000000-0000-4000-8000-000000000051");
    completeTurn(value.fakeQuery);

    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(threadEvents).toEqual([
      {
        type: "subagent.settled",
        nativeSubagentId: "a78414260bd2f9554",
        status: "failed",
        resultSummary: "Agent failed",
      },
    ]);
    expect(turns[0]?.events.filter((event) => event.type === "subagent.settled")).toEqual([]);
    expect(turns[0]?.terminal).toEqual({ status: "succeeded" });
    await value.transport.close();
  });

  it("delivers a background task settlement whose Segment never produces a Terminal", async () => {
    const value = fixture();
    const turns: ObservedTurn[] = [];
    const threadEvents: ClaudeTurnEvent[] = [];
    value.observeContinuations(turns);
    value.observeThreadEvents((event) => threadEvents.push(event));
    await value.transport.start();

    // Claude may enqueue the notification without a continuation Turn: no
    // Assistant output and no Result follow. The settlement is Thread-level
    // and must still be delivered instead of being swallowed by Turn batching.
    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000060",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: null,
      origin: { kind: "task-notification" },
      message: {
        role: "user",
        content:
          "<task-notification><task-id>native-agent-late</task-id><summary>Late analysis</summary></task-notification>",
      },
    } as unknown as SDKMessage);

    await vi.waitFor(() =>
      expect(threadEvents).toEqual([
        {
          type: "subagent.settled",
          nativeSubagentId: "native-agent-late",
          status: "completed",
          resultSummary: "Late analysis",
        },
      ]),
    );
    expect(turns).toEqual([]);
    await value.transport.close();
  });

  it("publishes a held task-notification exactly once with its native status", async () => {
    const value = fixture();
    const turns: ObservedTurn[] = [];
    const threadEvents: ClaudeTurnEvent[] = [];
    value.observeContinuations(turns);
    value.observeThreadEvents((event) => threadEvents.push(event));
    await value.transport.start();

    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000070",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: null,
      origin: { kind: "task-notification" },
      message: {
        role: "user",
        content:
          "<task-notification><task-id>native-agent-interrupted</task-id><status>stopped</status><summary>Agent stopped</summary></task-notification>",
      },
    } as unknown as SDKMessage);
    pushAssistantText(
      value.fakeQuery,
      "Interruption reported",
      "00000000-0000-4000-8000-000000000071",
    );
    completeTurn(value.fakeQuery);

    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]?.terminal).toEqual({ status: "succeeded" });
    expect(threadEvents.filter((event) => event.type === "subagent.settled")).toEqual([
      {
        type: "subagent.settled",
        nativeSubagentId: "native-agent-interrupted",
        status: "interrupted",
        resultSummary: "Agent stopped",
      },
    ]);
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport process environment", () => {
  it("attributes persisted sessions to the CodexHost SDK entrypoint", async () => {
    const value = fixture("create", "default", harnessThinkingOptionIdSchema.parse("auto"), {
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    });

    await value.transport.start();
    expect(options(value).env).toMatchObject({
      CLAUDE_CODE_ENTRYPOINT: "codexhost-sdk",
      CLAUDE_AGENT_SDK_CLIENT_APP: "codexhost-claude-code-adapter/0.0.0",
    });
    await value.transport.close();
  });

  it("adds the Host Node runtime to the Claude process PATH", async () => {
    const value = fixture("create", "default", harnessThinkingOptionIdSchema.parse("auto"), {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });

    await value.transport.start();
    expect(options(value).env?.PATH?.split(path.delimiter)).toContain(
      path.dirname(process.execPath),
    );
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport Permission Mode control", () => {
  it("passes the initial mode once, acknowledges bypass support, and delegates later switching", async () => {
    const value = fixture("create", "auto");

    await value.transport.start();
    expect(options(value).permissionMode).toBe("auto");
    expect(options(value).allowDangerouslySkipPermissions).toBe(true);
    expect(value.fakeQuery.setPermissionMode).not.toHaveBeenCalled();
    expect(value.transport.getPermissionMode()).toBe("auto");

    await value.transport.setPermissionMode("acceptEdits");
    expect(value.fakeQuery.setPermissionMode).toHaveBeenCalledOnce();
    expect(value.fakeQuery.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    expect(value.transport.getPermissionMode()).toBe("acceptEdits");
    await value.transport.close();
  });

  it("publishes supported native status changes and ignores modes outside the catalog", async () => {
    const value = fixture();
    await value.transport.start();

    value.fakeQuery.push({
      type: "system",
      subtype: "status",
      status: null,
      permissionMode: "acceptEdits",
    } as unknown as SDKMessage);
    await vi.waitFor(() => {
      expect(value.onPermissionModeChanged).toHaveBeenCalledWith("acceptEdits");
    });
    expect(value.transport.getPermissionMode()).toBe("acceptEdits");

    value.fakeQuery.push({
      type: "system",
      subtype: "status",
      status: null,
      permissionMode: "dontAsk",
    } as unknown as SDKMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(value.onFault).not.toHaveBeenCalled();
    expect(value.transport.getPermissionMode()).toBe("acceptEdits");
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport Thinking control", () => {
  it("maps Auto, explicit effort, and Off through structured SDK settings", async () => {
    const value = fixture();

    await value.transport.start();
    expect(options(value).thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(options(value).effort).toBeUndefined();

    await value.transport.setThinkingOption(harnessThinkingOptionIdSchema.parse("high"));
    await value.transport.setThinkingOption(harnessThinkingOptionIdSchema.parse("off"));
    await value.transport.setThinkingOption(harnessThinkingOptionIdSchema.parse("auto"));
    expect(value.fakeQuery.applyFlagSettings).toHaveBeenNthCalledWith(1, {
      alwaysThinkingEnabled: true,
      effortLevel: "high",
    });
    expect(value.fakeQuery.applyFlagSettings).toHaveBeenNthCalledWith(2, {
      alwaysThinkingEnabled: false,
    });
    expect(value.fakeQuery.applyFlagSettings).toHaveBeenNthCalledWith(3, {
      alwaysThinkingEnabled: true,
      effortLevel: null,
    });
    await value.transport.close();
  });

  it("passes explicit and disabled Thinking when creating the Query", async () => {
    const explicit = fixture("create", "default", harnessThinkingOptionIdSchema.parse("xhigh"));
    await explicit.transport.start();
    expect(options(explicit).thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(options(explicit).effort).toBe("xhigh");
    await explicit.transport.close();

    const disabled = fixture("create", "default", harnessThinkingOptionIdSchema.parse("off"));
    await disabled.transport.start();
    expect(options(disabled).thinking).toEqual({ type: "disabled" });
    expect(options(disabled).effort).toBeUndefined();
    await disabled.transport.close();
  });
});

describe("ClaudeSdkTransport root safety", () => {
  it("omits the dangerous flag when the Session cannot use bypass permissions", async () => {
    const value = fixture(
      "resume",
      "auto",
      harnessThinkingOptionIdSchema.parse("auto"),
      undefined,
      false,
    );

    await value.transport.start();
    expect(options(value).permissionMode).toBe("auto");
    expect(options(value)).not.toHaveProperty("allowDangerouslySkipPermissions");
    await value.transport.close();
  });

  it("does not pass the dangerous flag unless the caller opts in", async () => {
    const fakeQuery = new FakeQuery();
    let queryInput: QueryInput | undefined;
    const transport = new ClaudeSdkTransport({
      command: process.execPath,
      cwd: process.cwd(),
      sessionId: "00000000-0000-4000-8000-000000000001",
      openMode: "create",
      permissionMode: "default",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("auto"),
      closeTimeoutMs: 100,
      onPermissionModeChanged: vi.fn(),
      onFault: vi.fn(),
      onPlanLimit: vi.fn(),
      queryFactory: vi.fn((input) => {
        queryInput = input;
        return fakeQuery as unknown as Query;
      }),
    });

    await transport.start();
    expect(queryInput?.options).not.toHaveProperty("allowDangerouslySkipPermissions");
    await transport.close();
  });
});

describe("ClaudeSdkTransport Model control", () => {
  it("passes create-time Model and delegates setter without sending input", async () => {
    const value = fixture();
    const selected = new ClaudeSdkTransport({
      command: process.execPath,
      cwd: process.cwd(),
      sessionId: "00000000-0000-4000-8000-000000000009",
      openMode: "create",
      model: "custom-model",
      permissionMode: "default",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("auto"),
      closeTimeoutMs: 100,
      onPermissionModeChanged: value.onPermissionModeChanged,
      onFault: value.onFault,
      onPlanLimit: value.onPlanLimit,
      queryFactory: value.queryFactory,
    });

    await selected.start();
    expect(options(value).model).toBe("custom-model");
    await selected.setModel("sonnet");
    await selected.setModel(undefined);
    expect(value.fakeQuery.setModel).toHaveBeenNthCalledWith(1, "sonnet");
    expect(value.fakeQuery.setModel).toHaveBeenNthCalledWith(2, undefined);
    await selected.close();
  });

  it("detects Model selection without probing Context Usage", async () => {
    const value = fixture();
    value.fakeQuery.getContextUsage.mockRejectedValueOnce(new Error("must not be called"));
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-inspect-"));
    try {
      const inspector = new ClaudeSdkModelInspector({
        command: process.execPath,
        environment: { CLAUDE_CONFIG_DIR: configDirectory, PATH: process.env.PATH },
        cwd: process.cwd(),
        closeTimeoutMs: 100,
        queryFactory: value.queryFactory,
      });

      await expect(inspector.inspect()).resolves.toMatchObject({ canSelectModel: true });
      expect(value.fakeQuery.getContextUsage).not.toHaveBeenCalled();
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  });

  it("inspects initialization Models with persistence disabled", async () => {
    const value = fixture();
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-inspect-"));
    const inspector = new ClaudeSdkModelInspector({
      command: process.execPath,
      environment: { CLAUDE_CONFIG_DIR: configDirectory, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      cwd: process.cwd(),
      closeTimeoutMs: 100,
      queryFactory: value.queryFactory,
    });

    try {
      await expect(inspector.inspect()).resolves.toEqual({
        models: [
          {
            value: "default",
            displayName: "Default",
            description: "Default",
            supportsAutoMode: true,
          },
        ],
        canSelectModel: true,
        canSelectPermissionMode: true,
      });
      expect(value.fakeQuery.getContextUsage).not.toHaveBeenCalled();
      expect(options(value)).toMatchObject({
        persistSession: false,
        includePartialMessages: false,
        tools: [],
        settingSources: ["user"],
      });
      expect(options(value).env?.PATH?.split(path.delimiter)).toContain(
        path.dirname(process.execPath),
      );
      expect(options(value)).not.toHaveProperty("sessionId");
      expect(options(value)).not.toHaveProperty("resume");
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  });

  it("merges user modelPicker.options into the inspected Model catalog", async () => {
    const value = fixture();
    value.fakeQuery.initializationResult.mockResolvedValueOnce({
      session_state: "idle",
      models: [
        {
          value: "default",
          displayName: "Default",
          description: "Default",
          supportsAutoMode: true,
        },
        {
          value: "sonnet",
          displayName: "Sonnet",
          description: "Sonnet",
          supportsAutoMode: true,
        },
        {
          value: "opus",
          displayName: "Opus",
          description: "Opus",
          supportsAutoMode: true,
        },
      ],
    });
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-picker-"));
    try {
      await writeFile(
        path.join(configDirectory, "settings.json"),
        JSON.stringify({
          modelPicker: {
            replaceBuiltInOptions: true,
            options: [
              {
                model: "glm-glm-5.3-cp[1m]",
                label: "glm-glm-5.3-cp (1M)",
                description: "custom gateway",
              },
              {
                model: "deepseek-v4-pro-saas[1m]",
                label: "deepseek-v4-pro-saas (1M)",
                description: "custom gateway",
                behavesAs: "sonnet",
              },
            ],
          },
        }),
      );
      const inspector = new ClaudeSdkModelInspector({
        command: process.execPath,
        environment: { CLAUDE_CONFIG_DIR: configDirectory, PATH: process.env.PATH },
        cwd: process.cwd(),
        closeTimeoutMs: 100,
        queryFactory: value.queryFactory,
      });
      await expect(inspector.inspect()).resolves.toEqual({
        models: [
          {
            value: "default",
            displayName: "Default",
            description: "Default",
            supportsAutoMode: true,
          },
          {
            value: "glm-glm-5.3-cp[1m]",
            displayName: "glm-glm-5.3-cp (1M)",
            description: "custom gateway",
          },
          {
            value: "deepseek-v4-pro-saas[1m]",
            displayName: "deepseek-v4-pro-saas (1M)",
            description: "custom gateway",
            resolvedModel: "sonnet",
          },
        ],
        canSelectModel: true,
        canSelectPermissionMode: true,
      });
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  });
});

describe("ClaudeSdkTransport abort", () => {
  it("interrupts the active Query without closing the transport", async () => {
    const value = fixture();
    await value.transport.start();
    const turn = value.startTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000030",
      () => undefined,
    );
    await value.abort();
    expect(value.fakeQuery.interrupt).toHaveBeenCalledOnce();
    value.fakeQuery.push({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
    } as unknown as SDKMessage);
    await expect(turn).resolves.toEqual({ status: "cancelled", reason: "aborted_streaming" });
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });

  it("closes the transport when interrupt does not settle", async () => {
    const value = fixture();
    value.fakeQuery.interrupt.mockImplementation(async () => new Promise(() => undefined));
    const transport = new ClaudeSdkTransport({
      command: process.execPath,
      cwd: process.cwd(),
      sessionId: "00000000-0000-4000-8000-000000000001",
      openMode: "create",
      permissionMode: "default",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("auto"),
      closeTimeoutMs: 20,
      abortTimeoutMs: 20,
      onPermissionModeChanged: value.onPermissionModeChanged,
      onFault: value.onFault,
      onPlanLimit: value.onPlanLimit,
      queryFactory: value.queryFactory,
    });
    await transport.start();
    let segmentId: number | undefined;
    transport.setEventHandler((event) => {
      if (event.type === "segment.started") segmentId = event.segmentId;
    });
    value.fakeQuery.push({ type: "system", subtype: "init" } as SDKMessage);
    await vi.waitFor(() => expect(segmentId).toBeDefined());
    await expect(transport.abort(segmentId as number)).rejects.toThrow(
      "Claude SDK interrupt timed out",
    );
    expect(value.onFault).not.toHaveBeenCalled();
  });
});

describe("ClaudeSdkTransport Question callbacks", () => {
  it("uses caller identity for create and the same Native Session for resume", async () => {
    const created = fixture();
    await created.transport.start();
    expect(options(created)).toMatchObject({
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    expect(options(created).resume).toBeUndefined();
    await created.transport.close();

    const resumed = fixture("resume");
    await resumed.transport.start();
    expect(options(resumed)).toMatchObject({
      resume: "00000000-0000-4000-8000-000000000001",
    });
    expect(options(resumed).sessionId).toBeUndefined();
    await resumed.transport.close();
  });

  it("forwards ordered visible reasoning and text events from SDK messages", async () => {
    const value = fixture();
    await value.transport.start();
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000002", (event) =>
      events.push(event),
    );
    const assistantId = "00000000-0000-4000-8000-000000000003";
    value.fakeQuery.push({
      type: "stream_event",
      uuid: assistantId,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "visible" },
      },
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "assistant",
      uuid: assistantId,
      message: {
        content: [
          { type: "thinking", thinking: "visible reasoning", signature: "ignored" },
          { type: "text", text: "answer" },
        ],
      },
    } as unknown as SDKMessage);
    completeTurn(value.fakeQuery);

    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(events).toEqual([
      { type: "reasoning.delta", messageId: assistantId, delta: "visible" },
      { type: "reasoning.completed", messageId: assistantId },
      { type: "text.delta", messageId: assistantId, delta: "answer" },
      { type: "message.completed", messageId: assistantId, checkpointId: assistantId },
    ]);
    await value.transport.close();
  });

  it("inherits native Tools and returns an exact AskUserQuestion PermissionResult", async () => {
    const value = fixture();
    await value.transport.start();
    const queryOptions = options(value);
    expect(queryOptions.permissionMode).toBe("default");
    expect(queryOptions).not.toHaveProperty("tools");
    expect(queryOptions.onUserDialog).toBeUndefined();
    expect(queryOptions.onElicitation).toBeUndefined();
    const canUseTool = queryOptions.canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");

    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000002", (event) =>
      events.push(event),
    );
    // Callback arrives before tool_use
    const permission = canUseTool("AskUserQuestion", questionInput(), {
      signal: new AbortController().signal,
      toolUseID: "native-tool",
      requestId: "native-request",
    });
    pushToolUse(value.fakeQuery, "native-tool", "AskUserQuestion", questionInput());
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) => event.type === "interaction.requested" && event.request.type === "question",
        ),
      ).toBe(true),
    );
    expect(events).toEqual([
      {
        type: "tool.started",
        callId: "native-tool",
        toolName: "AskUserQuestion",
        arguments: questionInput(),
      },
      {
        type: "message.completed",
        messageId: "00000000-0000-4000-8000-000000000031",
        checkpointId: "00000000-0000-4000-8000-000000000031",
      },
      {
        type: "interaction.requested",
        request: {
          type: "question",
          requestId: "claude-question-1",
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
          ],
        },
      },
    ]);
    await value.transport.respondToInteraction({
      type: "question",
      requestId: "claude-question-1",
      answers: { "Which path?": "Alpha" },
    });
    await expect(permission).resolves.toEqual({
      behavior: "allow",
      updatedInput: { ...questionInput(), answers: { "Which path?": "Alpha" } },
      toolUseID: "native-tool",
      decisionClassification: "user_temporary",
    });
    expect(events.at(-1)).toEqual({
      type: "interaction.closed",
      requestId: "claude-question-1",
      reason: "responded",
    });
    await expect(
      value.transport.respondToInteraction({
        type: "question",
        requestId: "claude-question-1",
        answers: { "Which path?": "Beta" },
      }),
    ).rejects.toThrow("not pending");

    completeTool(value.fakeQuery, "native-tool", "Alpha");
    completeTurn(value.fakeQuery);
    await expect(turn).resolves.toEqual({ status: "succeeded" });
    await value.transport.close();
    expect(value.onFault).not.toHaveBeenCalled();
  });

  it("denies out-of-Turn, malformed, and duplicate Question callbacks without leaking IDs", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");

    const outsideController = new AbortController();
    outsideController.abort();
    await expect(
      canUseTool(
        "Read",
        {},
        {
          signal: outsideController.signal,
          toolUseID: "outside-tool",
          requestId: "outside-request",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "outside-tool" });

    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000003", (event) =>
      events.push(event),
    );
    pushToolUse(value.fakeQuery, "bad-tool", "AskUserQuestion", { questions: [] });
    await expect(
      canUseTool(
        "AskUserQuestion",
        { questions: [] },
        {
          signal: new AbortController().signal,
          toolUseID: "bad-tool",
          requestId: "bad-request",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "bad-tool" });
    expect(events.filter((e) => e.type === "interaction.requested")).toEqual([]);

    pushToolUse(value.fakeQuery, "duplicate-tool", "AskUserQuestion", questionInput());
    const first = canUseTool("AskUserQuestion", questionInput(), {
      signal: new AbortController().signal,
      toolUseID: "duplicate-tool",
      requestId: "duplicate-request",
    });
    pushToolUse(value.fakeQuery, "second-tool", "AskUserQuestion", questionInput());
    await expect(
      canUseTool("AskUserQuestion", questionInput(), {
        signal: new AbortController().signal,
        toolUseID: "second-tool",
        requestId: "duplicate-request",
      }),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "second-tool" });
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) => event.type === "interaction.requested" && event.request.type === "question",
        ),
      ).toBe(true),
    );
    const requested = events.find(
      (event) => event.type === "interaction.requested" && event.request.type === "question",
    );
    if (requested?.type !== "interaction.requested") {
      throw new Error("Claude Question request was not exposed");
    }
    expect(JSON.stringify(requested)).not.toContain("duplicate-request");
    expect(JSON.stringify(requested)).not.toContain("duplicate-tool");
    await value.transport.respondToInteraction({
      type: "question",
      requestId: requested.request.requestId,
      cancelled: true,
    });
    await expect(first).resolves.toMatchObject({ behavior: "deny", toolUseID: "duplicate-tool" });
    expect(events.at(-1)).toMatchObject({ type: "interaction.closed", reason: "cancelled" });

    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });

  it("closes a pending callback and Turn when the transport closes", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000005", (event) =>
      events.push(event),
    );
    pushToolUse(value.fakeQuery, "close-tool", "AskUserQuestion", questionInput());
    const permission = canUseTool("AskUserQuestion", questionInput(), {
      signal: new AbortController().signal,
      toolUseID: "close-tool",
      requestId: "close-request",
    });
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "interaction.requested")).toBe(true),
    );

    const turnClosed = expect(turn).rejects.toThrow("transport closed");
    await value.transport.close();
    await expect(permission).resolves.toMatchObject({ behavior: "deny", toolUseID: "close-tool" });
    await turnClosed;
    expect(events.filter((e) => e.type.startsWith("interaction.")).map(({ type }) => type)).toEqual(
      ["interaction.requested", "interaction.closed"],
    );
    expect(events.at(-1)).toMatchObject({ reason: "cancelled" });
  });

  it("closes a pending callback once when its AbortSignal fires", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000004", (event) =>
      events.push(event),
    );
    pushToolUse(value.fakeQuery, "abort-tool", "AskUserQuestion", questionInput());
    const controller = new AbortController();
    const permission = canUseTool("AskUserQuestion", questionInput(), {
      signal: controller.signal,
      toolUseID: "abort-tool",
      requestId: "abort-request",
    });
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "interaction.requested")).toBe(true),
    );
    controller.abort();
    await expect(permission).resolves.toMatchObject({
      behavior: "deny",
      toolUseID: "abort-tool",
    });
    expect(events.filter((e) => e.type.startsWith("interaction.")).map(({ type }) => type)).toEqual(
      ["interaction.requested", "interaction.closed"],
    );
    expect(events.at(-1)).toMatchObject({ reason: "cancelled" });
    await expect(
      value.transport.respondToInteraction({
        type: "question",
        requestId: "claude-question-1",
        cancelled: true,
      }),
    ).rejects.toThrow("not pending");

    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport Tool Approval callbacks", () => {
  it.each(["allowOnce", "deny"] as const)(
    "separates ExitPlanMode from ordinary approvals and returns %s without permission updates",
    async (decision) => {
      const value = fixture("create", "plan");
      await value.transport.start();
      const canUseTool = options(value).canUseTool;
      if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
      const events: ClaudeTurnEvent[] = [];
      const turn = value.startTurn("synthetic", "plan-turn", (event) => events.push(event));
      const input = {
        plan: `# Plan\n${"Review the change.\n".repeat(80)}`,
        planFilePath: "/private/plan.md",
      };
      pushToolUse(value.fakeQuery, "exit-tool", "ExitPlanMode", input);
      const permission = canUseTool("ExitPlanMode", input, {
        signal: new AbortController().signal,
        toolUseID: "exit-tool",
        requestId: "exit-control",
        title: "Allow once",
        suggestions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
      });
      await vi.waitFor(() =>
        expect(
          events.some(
            (event) =>
              event.type === "interaction.requested" && event.request.type === "planApproval",
          ),
        ).toBe(true),
      );
      expect(events).toContainEqual({
        type: "interaction.requested",
        request: { type: "planApproval", requestId: "claude-approval-1", plan: input.plan },
      });
      await expect(
        value.transport.respondToInteraction({
          type: "approval",
          requestId: "claude-approval-1",
          decision: "allowForSession",
        }),
      ).rejects.toThrow("scope is not pending");
      await value.transport.respondToInteraction({
        type: "approval",
        requestId: "claude-approval-1",
        decision,
      });
      const result = await permission;
      if (!result) throw new Error("Expected an explicit permission decision");
      expect(result.behavior).toBe(decision === "allowOnce" ? "allow" : "deny");
      expect(result).not.toHaveProperty("updatedPermissions");
      if (result.behavior === "allow") expect(result.updatedInput).toBe(input);
      expect(value.fakeQuery.setPermissionMode).not.toHaveBeenCalled();
      completeTurn(value.fakeQuery);
      await turn;
      await value.transport.close();
    },
  );

  it.each([undefined, "", "   ", 42])(
    "marks unavailable ExitPlanMode plan text explicitly: %s",
    async (plan) => {
      const value = fixture("create", "plan");
      await value.transport.start();
      const canUseTool = options(value).canUseTool;
      if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
      const events: ClaudeTurnEvent[] = [];
      const turn = value.startTurn("synthetic", "plan-turn", (event) => events.push(event));
      pushToolUse(value.fakeQuery, "exit-tool", "ExitPlanMode", {
        ...(plan !== undefined ? { plan } : {}),
        planFilePath: "/must/not/read",
      });
      const signal = new AbortController();
      const permission = canUseTool(
        "ExitPlanMode",
        { plan, planFilePath: "/must/not/read" },
        {
          signal: signal.signal,
          toolUseID: "exit-tool",
          requestId: "exit-control",
        },
      );
      await vi.waitFor(() =>
        expect(
          events.some(
            (event) =>
              event.type === "interaction.requested" && event.request.type === "planApproval",
          ),
        ).toBe(true),
      );
      expect(events).toContainEqual({
        type: "interaction.requested",
        request: { type: "planApproval", requestId: "claude-approval-1", plan: null },
      });
      await expect(
        value.transport.respondToInteraction({
          type: "approval",
          requestId: "claude-approval-1",
          decision: "allowOnce",
        }),
      ).rejects.toThrow("plan text is unavailable");
      signal.abort();
      await expect(permission).resolves.toMatchObject({ behavior: "deny" });
      completeTurn(value.fakeQuery);
      await turn;
      await value.transport.close();
    },
  );

  it("resolves independent Edit and Bash callbacks with exact one-shot SDK results", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000010", (event) =>
      events.push(event),
    );
    const editInput = { file_path: "/synthetic/private", new_string: "private-content" };
    pushToolUse(value.fakeQuery, "native-edit-tool", "Edit", editInput);
    const editPermission = canUseTool("Edit", editInput, {
      signal: new AbortController().signal,
      toolUseID: "native-edit-tool",
      requestId: "native-edit-control",
      title: "Claude wants to edit a file",
      displayName: "Edit file",
      description: "One-shot file edit",
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Edit" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });
    pushToolUse(value.fakeQuery, "native-bash-tool", "Bash", { command: "synthetic-command" });
    const bashPermission = canUseTool(
      "Bash",
      { command: "synthetic-command" },
      {
        signal: new AbortController().signal,
        toolUseID: "native-bash-tool",
        requestId: "native-bash-control",
        displayName: "Run command",
      },
    );
    await vi.waitFor(() =>
      expect(
        events.filter(
          (event) => event.type === "interaction.requested" && event.request.type === "approval",
        ),
      ).toHaveLength(2),
    );

    const requests = events.flatMap((event) =>
      event.type === "interaction.requested" && event.request.type === "approval"
        ? [event.request]
        : [],
    );
    expect(requests).toEqual([
      {
        type: "approval",
        requestId: "claude-approval-1",
        title: "Claude wants to edit a file",
        description: "One-shot file edit",
        suggestedScope: "session",
      },
      {
        type: "approval",
        requestId: "claude-approval-2",
        title: "Run command",
      },
    ]);
    const exposed = JSON.stringify(requests);
    expect(exposed).not.toContain("native-edit");
    expect(exposed).not.toContain("private-content");
    expect(exposed).not.toContain("updatedPermissions");

    await expect(
      value.transport.respondToInteraction({
        type: "question",
        requestId: "claude-approval-1",
        cancelled: true,
      }),
    ).rejects.toThrow("type does not match");
    pushToolUse(value.fakeQuery, "duplicate-tool", "Bash", {});
    await expect(
      canUseTool(
        "Bash",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "duplicate-tool",
          requestId: "native-bash-control",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "duplicate-tool" });

    await value.transport.respondToInteraction({
      type: "approval",
      requestId: "claude-approval-2",
      decision: "deny",
    });
    await expect(bashPermission).resolves.toEqual({
      behavior: "deny",
      message: "User denied the Tool request",
      toolUseID: "native-bash-tool",
      decisionClassification: "user_reject",
    });
    await value.transport.respondToInteraction({
      type: "approval",
      requestId: "claude-approval-1",
      decision: "allowOnce",
    });
    const editResult = await editPermission;
    expect(editResult).toEqual({
      behavior: "allow",
      updatedInput: editInput,
      toolUseID: "native-edit-tool",
      decisionClassification: "user_temporary",
    });
    if (!editResult || editResult.behavior !== "allow") throw new Error("Edit was not allowed");
    expect(editResult.updatedInput).toBe(editInput);
    expect(editResult).not.toHaveProperty("updatedPermissions");
    expect(events.filter(({ type }) => type === "interaction.closed")).toHaveLength(2);

    completeTool(value.fakeQuery, "native-edit-tool", "edited");
    completeTool(value.fakeQuery, "native-bash-tool", "denied", true);
    completeTool(value.fakeQuery, "duplicate-tool", "denied", true);
    completeTurn(value.fakeQuery);
    await expect(turn).resolves.toEqual({ status: "succeeded" });
    await value.transport.close();
    expect(value.fakeQuery.interrupt).not.toHaveBeenCalled();
  });

  it("returns the exact native suggestions only for their declared scope", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000013", (event) =>
      events.push(event),
    );
    const sessionSuggestions = [
      {
        type: "addRules" as const,
        rules: [{ toolName: "Edit" }],
        behavior: "allow" as const,
        destination: "session" as const,
      },
      {
        type: "addDirectories" as const,
        directories: ["/synthetic"],
        destination: "cliArg" as const,
      },
    ];
    const persistentSuggestions = [
      {
        type: "addRules" as const,
        rules: [{ toolName: "Bash", ruleContent: "npm test" }],
        behavior: "allow" as const,
        destination: "projectSettings" as const,
      },
    ];
    const sessionInput = { file_path: "/synthetic/private-session" };
    const persistentInput = { command: "npm test" };
    pushToolUse(value.fakeQuery, "session-tool", "Edit", sessionInput);
    const sessionPermission = canUseTool("Edit", sessionInput, {
      signal: new AbortController().signal,
      toolUseID: "session-tool",
      requestId: "session-control",
      suggestions: sessionSuggestions,
    });
    pushToolUse(value.fakeQuery, "persistent-tool", "Bash", persistentInput);
    const persistentPermission = canUseTool("Bash", persistentInput, {
      signal: new AbortController().signal,
      toolUseID: "persistent-tool",
      requestId: "persistent-control",
      suggestions: persistentSuggestions,
    });
    await vi.waitFor(() =>
      expect(
        events.filter(
          (event) => event.type === "interaction.requested" && event.request.type === "approval",
        ),
      ).toHaveLength(2),
    );
    const approvalRequests = events.flatMap((event) =>
      event.type === "interaction.requested" && event.request.type === "approval"
        ? [event.request]
        : [],
    );
    expect(approvalRequests).toEqual([
      expect.objectContaining({ requestId: "claude-approval-1", suggestedScope: "session" }),
      expect.objectContaining({ requestId: "claude-approval-2", suggestedScope: "always" }),
    ]);
    expect(JSON.stringify(approvalRequests)).not.toContain("projectSettings");
    expect(JSON.stringify(approvalRequests)).not.toContain("private-session");

    await expect(
      value.transport.respondToInteraction({
        type: "approval",
        requestId: "claude-approval-1",
        decision: "allowAlways",
      }),
    ).rejects.toThrow("scope is not pending");
    await value.transport.respondToInteraction({
      type: "approval",
      requestId: "claude-approval-1",
      decision: "allowForSession",
    });
    await value.transport.respondToInteraction({
      type: "approval",
      requestId: "claude-approval-2",
      decision: "allowAlways",
    });
    const sessionResult = await sessionPermission;
    const persistentResult = await persistentPermission;
    expect(sessionResult).toEqual({
      behavior: "allow",
      updatedInput: sessionInput,
      toolUseID: "session-tool",
      decisionClassification: "user_permanent",
      updatedPermissions: sessionSuggestions,
    });
    expect(persistentResult).toEqual({
      behavior: "allow",
      updatedInput: persistentInput,
      toolUseID: "persistent-tool",
      decisionClassification: "user_permanent",
      updatedPermissions: persistentSuggestions,
    });
    if (
      !sessionResult ||
      sessionResult.behavior !== "allow" ||
      !persistentResult ||
      persistentResult.behavior !== "allow"
    ) {
      throw new Error("Scoped permission was not allowed");
    }
    expect(sessionResult.updatedPermissions).toBe(sessionSuggestions);
    expect(persistentResult.updatedPermissions).toBe(persistentSuggestions);

    completeTool(value.fakeQuery, "session-tool");
    completeTool(value.fakeQuery, "persistent-tool");
    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });

  it("omits broader scope for empty, malformed, and unknown suggestions", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000014", (event) =>
      events.push(event),
    );
    const suggestionCases: Array<{ name: string; suggestions: PermissionUpdate[] }> = [
      { name: "empty", suggestions: [] },
      {
        name: "malformed",
        suggestions: [
          {
            type: "addRules",
            behavior: "allow",
            destination: "session",
          } as unknown as PermissionUpdate,
        ],
      },
      {
        name: "unknown-destination",
        suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Edit" }],
            behavior: "allow",
            destination: "futureSettings",
          } as unknown as PermissionUpdate,
        ],
      },
    ];
    const permissions = suggestionCases.map(({ name, suggestions }, index) => {
      pushToolUse(value.fakeQuery, `${name}-tool`, "Edit", {});
      return canUseTool(
        "Edit",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: `${name}-tool`,
          requestId: `${name}-control`,
          suggestions,
        },
      ).then((result) => ({ index, result }));
    });
    await vi.waitFor(() =>
      expect(
        events.filter(
          (event) => event.type === "interaction.requested" && event.request.type === "approval",
        ),
      ).toHaveLength(suggestionCases.length),
    );
    const requests = events.flatMap((event) =>
      event.type === "interaction.requested" && event.request.type === "approval"
        ? [event.request]
        : [],
    );
    expect(requests).toHaveLength(suggestionCases.length);
    for (const [index, request] of requests.entries()) {
      expect(request).not.toHaveProperty("suggestedScope");
      await expect(
        value.transport.respondToInteraction({
          type: "approval",
          requestId: request.requestId,
          decision: "allowForSession",
        }),
      ).rejects.toThrow("scope is not pending");
      await value.transport.respondToInteraction({
        type: "approval",
        requestId: request.requestId,
        decision: "allowOnce",
      });
      await expect(permissions[index]).resolves.toMatchObject({
        index,
        result: { behavior: "allow", decisionClassification: "user_temporary" },
      });
      const resolved = await permissions[index];
      expect(resolved?.result).not.toHaveProperty("updatedPermissions");
    }
    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });

  it("uses bounded display fallback and denies callbacks with no valid display identity", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000011", (event) =>
      events.push(event),
    );

    pushToolUse(value.fakeQuery, "fallback-tool", "Edit", {});
    const fallback = canUseTool(
      "Edit",
      {},
      {
        signal: new AbortController().signal,
        toolUseID: "fallback-tool",
        requestId: "fallback-control",
        title: "x".repeat(121),
        displayName: "Edit file",
        description: "Bounded description",
      },
    );
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) => event.type === "interaction.requested" && event.request.type === "approval",
        ),
      ).toBe(true),
    );
    expect(events.at(-1)).toMatchObject({
      type: "interaction.requested",
      request: {
        type: "approval",
        title: "Edit file",
        description: "Bounded description",
      },
    });
    await value.transport.respondToInteraction({
      type: "approval",
      requestId: "claude-approval-1",
      decision: "deny",
    });
    await fallback;

    const exposedCount = events.filter(({ type }) => type === "interaction.requested").length;
    await expect(
      canUseTool(
        "x".repeat(121),
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "invalid-display-tool",
          requestId: "invalid-display-control",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "invalid-display-tool" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      canUseTool(
        "Bash",
        {},
        {
          signal: aborted.signal,
          toolUseID: "pre-aborted-tool",
          requestId: "pre-aborted-control",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "pre-aborted-tool" });
    expect(events.filter(({ type }) => type === "interaction.requested")).toHaveLength(
      exposedCount,
    );

    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });

  it("closes Approval callbacks once on AbortSignal and native terminal cleanup", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000012", (event) =>
      events.push(event),
    );
    const controller = new AbortController();
    // Callback arrives before tool_use:
    const abortedPermission = canUseTool(
      "Edit",
      {},
      {
        signal: controller.signal,
        toolUseID: "aborted-tool",
        requestId: "aborted-control",
      },
    );
    const terminalPermission = canUseTool(
      "Bash",
      {},
      {
        signal: new AbortController().signal,
        toolUseID: "terminal-tool",
        requestId: "terminal-control",
      },
    );
    pushToolUse(value.fakeQuery, "aborted-tool", "Edit", {});
    pushToolUse(value.fakeQuery, "terminal-tool", "Bash", {});
    await vi.waitFor(() =>
      expect(
        events.filter(
          (event) => event.type === "interaction.requested" && event.request.type === "approval",
        ),
      ).toHaveLength(2),
    );

    controller.abort();
    await expect(abortedPermission).resolves.toMatchObject({
      behavior: "deny",
      toolUseID: "aborted-tool",
    });
    completeTool(value.fakeQuery, "aborted-tool", "aborted", true);
    completeTool(value.fakeQuery, "terminal-tool", "terminal", true);
    completeTurn(value.fakeQuery);
    await expect(terminalPermission).resolves.toMatchObject({
      behavior: "deny",
      toolUseID: "terminal-tool",
    });
    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(events.filter(({ type }) => type === "interaction.closed")).toEqual([
      expect.objectContaining({ requestId: "claude-approval-1", reason: "cancelled" }),
      expect.objectContaining({ requestId: "claude-approval-2", reason: "superseded" }),
    ]);
    await expect(
      value.transport.respondToInteraction({
        type: "approval",
        requestId: "claude-approval-1",
        decision: "allowOnce",
      }),
    ).rejects.toThrow("not pending");
    await value.transport.close();
  });
});

describe("Claude history replacement fence", () => {
  it("does not accept a stop-task receipt without a native task terminal", async () => {
    const value = fixture();
    await value.transport.start();
    value.fakeQuery.stopTask.mockImplementation(async () => undefined);
    value.fakeQuery.push({
      type: "system",
      subtype: "task_started",
      task_id: "still-running",
    } as unknown as SDKMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(value.transport.close()).rejects.toThrow("shutdown could not be confirmed");
    expect(value.fakeQuery.stopTask).toHaveBeenCalledWith("still-running");
  });

  it.skipIf(process.platform === "win32")(
    "confirms forced process shutdown without a native task terminal",
    async () => {
      const value = fixture();
      await value.transport.start();
      const spawnProcess = options(value).spawnClaudeCodeProcess;
      if (!spawnProcess) throw new Error("Missing native process ownership hook");
      const child = spawnProcess({
        command: process.execPath,
        args: ["-e", "process.stdout.write('ready'); setInterval(()=>{},1000)"],
        signal: new AbortController().signal,
        cwd: process.cwd(),
        env: process.env,
      }) as ChildProcessWithoutNullStreams;
      try {
        await once(child.stdout, "data");
        value.fakeQuery.stopTask.mockImplementation(async () => undefined);
        value.fakeQuery.push({
          type: "system",
          subtype: "task_started",
          task_id: "still-running",
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(value.transport.hasBackgroundTasks()).toBe(true);
        await expect(value.transport.close()).resolves.toBeUndefined();
        expect(value.fakeQuery.stopTask).toHaveBeenCalledWith("still-running");
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      } finally {
        child.kill("SIGKILL");
        await value.transport.close().catch(() => undefined);
      }
    },
  );

  it("rejects close if native output cannot be drained", async () => {
    const value = fixture();
    await value.transport.start();
    const close = vi.spyOn(value.fakeQuery, "close").mockImplementation(() => undefined);
    try {
      await expect(value.transport.close()).rejects.toThrow("shutdown could not be confirmed");
    } finally {
      close.mockRestore();
      value.fakeQuery.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "stops wrapper children even when the wrapper has exited",
    async () => {
      const value = fixture();
      await value.transport.start();
      const spawnProcess = options(value).spawnClaudeCodeProcess;
      if (!spawnProcess) throw new Error("Missing native process ownership hook");
      const child = spawnProcess({
        command: process.execPath,
        args: [
          "-e",
          "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(c.pid)); c.unref();",
        ],
        signal: new AbortController().signal,
        cwd: process.cwd(),
        env: process.env,
      }) as ChildProcessWithoutNullStreams;
      let pid = 0;
      try {
        const [chunk] = await once(child.stdout, "data");
        pid = Number(String(chunk));
        if (child.exitCode === null) await once(child, "exit");
        expect(() => process.kill(pid, 0)).not.toThrow();
        await value.transport.close();
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        await value.transport.close().catch(() => undefined);
      }
    },
  );
});

// A native continuation may launch another child before its own result arrives.
function pushBackgroundDelegation(
  fakeQuery: FakeQuery,
  callId: string,
  nativeSubagentId: string | undefined,
  operation: "spawn" | "send" = "spawn",
): void {
  fakeQuery.push({
    type: "assistant",
    uuid: `assistant-${callId}`,
    parent_tool_use_id: null,
    message: {
      id: `message-${callId}`,
      content: [
        {
          type: "tool_use",
          id: callId,
          name: operation === "spawn" ? "Agent" : "SendMessage",
          input:
            operation === "spawn"
              ? { description: "Analyze", prompt: "Analyze", run_in_background: true }
              : { to: nativeSubagentId, summary: "Analyze", message: "Analyze" },
        },
      ],
    },
  } as unknown as SDKMessage);
  fakeQuery.push({
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: callId, content: "Launched", is_error: false }],
    },
    ...(operation === "spawn"
      ? { tool_use_result: { status: "async_launched", agentId: nativeSubagentId } }
      : {}),
  } as unknown as SDKMessage);
}

function pushSettlement(
  fakeQuery: FakeQuery,
  nativeSubagentId: string,
  status = "completed",
  callId?: string,
): void {
  fakeQuery.push({
    type: "system",
    subtype: "task_notification",
    task_id: nativeSubagentId,
    status,
    summary: "Analysis finished",
    ...(callId ? { tool_use_id: callId } : {}),
  } as unknown as SDKMessage);
}

describe("ClaudeSdkTransport autonomous Subagent settlement ordering", () => {
  it("keeps a background command settlement after the Tool result that detached it", async () => {
    const value = fixture();
    const events: ClaudeTurnEvent[] = [];
    value.transport.setEventHandler((event) => {
      if (event.type === "segment.event" || event.type === "thread.event") events.push(event.event);
    });
    await value.transport.start();
    try {
      value.fakeQuery.push({
        type: "assistant",
        uuid: "assistant-bash-1",
        parent_tool_use_id: null,
        message: {
          id: "message-bash-1",
          content: [
            {
              type: "tool_use",
              id: "bash-1",
              name: "Bash",
              input: { command: "sleep 1", run_in_background: true },
            },
          ],
        },
      } as unknown as SDKMessage);
      value.fakeQuery.push({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "bash-1",
              content:
                "Command running in background with ID: task-1. Output is being written to: /tmp/task-1.output.",
              is_error: false,
            },
          ],
        },
        tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "task-1" },
      } as unknown as SDKMessage);
      value.fakeQuery.push({
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        tool_use_id: "bash-1",
        status: "completed",
        output_file: "/tmp/task-1.output",
        summary: "Background command completed",
      } as unknown as SDKMessage);
      completeTurn(value.fakeQuery);
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === "subagent.settled")).toBe(true),
      );
      const detached = events.findIndex(
        (event) => event.type === "tool.completed" && event.callId === "bash-1",
      );
      expect(events[detached]).toMatchObject({
        backgroundTaskId: "task-1",
        backgroundOutputFile: "/tmp/task-1.output",
      });
      const settled = events.findIndex((event) => event.type === "subagent.settled");
      expect(settled).toBeGreaterThan(detached);
      expect(events[settled]).toMatchObject({
        callId: "bash-1",
        status: "completed",
        outputFile: "/tmp/task-1.output",
      });
    } finally {
      await value.transport.close();
    }
  });

  it.each(["unset", "cleared"])(
    "delivers settlements to the Thread handler when set and drops when %s",
    async (handlerState) => {
      const value = fixture();
      const turns: ObservedTurn[] = [];
      const immediate = vi.fn();
      value.observeContinuations(turns);
      if (handlerState === "cleared") {
        value.observeThreadEvents(immediate);
        value.observeThreadEvents(null);
      }
      await value.transport.start();
      try {
        pushSettlement(value.fakeQuery, "existing-child", "completed", "existing-call");
        completeTurn(value.fakeQuery);
        expect(turns).toEqual([]);
        expect(immediate).not.toHaveBeenCalled();
      } finally {
        await value.transport.close();
      }
    },
  );

  it.each(["completed", "failed", "stopped"])(
    "routes child delegation to continuation and %s settlement to Thread handler",
    async (status) => {
      const value = fixture();
      const turns: ObservedTurn[] = [];
      const immediate: ClaudeTurnEvent[] = [];
      value.observeContinuations(turns);
      value.observeThreadEvents((event) => immediate.push(event));
      await value.transport.start();
      try {
        pushBackgroundDelegation(value.fakeQuery, "spawn-1", "child-1");
        // No callId: the native ID learned from the launch result must suffice.
        pushSettlement(value.fakeQuery, "child-1", status);
        completeTurn(value.fakeQuery);
        await vi.waitFor(() => expect(turns).toHaveLength(1));
        const turn = turns[0];
        if (!turn) throw new Error("Autonomous Turn was not delivered");
        expect(turn.events.some((event) => event.type === "subagent.completed")).toBe(true);
        expect(turn.events.filter((event) => event.type === "subagent.settled")).toEqual([]);
        expect(immediate).toEqual([
          {
            type: "subagent.settled",
            nativeSubagentId: "child-1",
            status: status === "stopped" ? "interrupted" : status,
            resultSummary: "Analysis finished",
          },
        ]);
      } finally {
        await value.transport.close();
      }
    },
  );

  it("uses the call ID when the launch result has not supplied a native child ID", async () => {
    const value = fixture();
    const turns: ObservedTurn[] = [];
    const immediate: ClaudeTurnEvent[] = [];
    value.observeContinuations(turns);
    value.observeThreadEvents((event) => immediate.push(event));
    await value.transport.start();
    try {
      pushBackgroundDelegation(value.fakeQuery, "spawn-call-only", undefined);
      pushSettlement(value.fakeQuery, "child-from-notification", "completed", "spawn-call-only");
      completeTurn(value.fakeQuery);
      await vi.waitFor(() => expect(turns).toHaveLength(1));
      const turn = turns[0];
      if (!turn) throw new Error("Autonomous Turn was not delivered");
      expect(turn.events.some((event) => event.type === "subagent.completed")).toBe(true);
      expect(immediate).toEqual([
        {
          type: "subagent.settled",
          nativeSubagentId: "child-from-notification",
          callId: "spawn-call-only",
          status: "completed",
          resultSummary: "Analysis finished",
        },
      ]);
    } finally {
      await value.transport.close();
    }
  });

  it("orders repeated sends to one native child independently across batches", async () => {
    const value = fixture();
    const turns: ObservedTurn[] = [];
    const immediate: ClaudeTurnEvent[] = [];
    value.observeContinuations(turns);
    value.observeThreadEvents((event) => immediate.push(event));
    await value.transport.start();
    try {
      for (let index = 0; index < 2; index += 1) {
        pushBackgroundDelegation(value.fakeQuery, `send-${index}`, "existing-child", "send");
        pushSettlement(value.fakeQuery, "existing-child");
        completeTurn(value.fakeQuery);
        await vi.waitFor(() => expect(turns).toHaveLength(index + 1));
        const turn = turns[index];
        if (!turn) throw new Error("Autonomous Turn was not delivered");
        expect(turn.events.some((event) => event.type === "subagent.completed")).toBe(true);
      }
      expect(immediate).toHaveLength(2);
      // No creation in this new batch: do not retain a stale dependency.
      pushSettlement(value.fakeQuery, "existing-child");
      await vi.waitFor(() => expect(immediate).toHaveLength(3));
    } finally {
      await value.transport.close();
    }
  });

  it("does not make unrelated settlements wait for a buffered creation or Terminal", async () => {
    const value = fixture();
    const turns: ObservedTurn[] = [];
    const immediate: ClaudeTurnEvent[] = [];
    value.observeContinuations(turns);
    value.observeThreadEvents((event) => immediate.push(event));
    await value.transport.start();
    try {
      pushBackgroundDelegation(value.fakeQuery, "spawn-new", "new-child");
      pushSettlement(value.fakeQuery, "new-child");
      pushSettlement(value.fakeQuery, "existing-child");
      await vi.waitFor(() =>
        expect(immediate).toEqual([
          expect.objectContaining({ nativeSubagentId: "new-child" }),
          expect.objectContaining({ nativeSubagentId: "existing-child" }),
        ]),
      );
      expect(turns).toHaveLength(1);
      expect(turns[0]?.terminal).toBeUndefined();
      completeTurn(value.fakeQuery);
      await vi.waitFor(() => expect(turns[0]?.terminal).toEqual({ status: "succeeded" }));
      const turn = turns[0];
      if (!turn) throw new Error("Autonomous Turn was not delivered");
      expect(turn.events.filter((event) => event.type === "subagent.settled")).toEqual([]);
    } finally {
      await value.transport.close();
    }
  });

  it("discards unpublished lifecycle events on close without flushing orphan terminal states", async () => {
    const value = fixture();
    const turns: ObservedTurn[] = [];
    const immediate: ClaudeTurnEvent[] = [];
    value.observeContinuations(turns);
    value.observeThreadEvents((event) => immediate.push(event));
    await value.transport.start();
    pushBackgroundDelegation(value.fakeQuery, "spawn-close", "unpublished-child");
    pushSettlement(value.fakeQuery, "unpublished-child");
    pushSettlement(value.fakeQuery, "existing-child");
    try {
      await vi.waitFor(() =>
        expect(
          immediate.some(
            (event) =>
              event.type === "subagent.settled" && event.nativeSubagentId === "existing-child",
          ),
        ).toBe(true),
      );
    } finally {
      await value.transport.close();
    }
    expect(turns).toHaveLength(1);
    expect(turns[0]?.terminal).toBeUndefined();
    expect(immediate).toEqual([
      expect.objectContaining({ nativeSubagentId: "unpublished-child" }),
      expect.objectContaining({ nativeSubagentId: "existing-child" }),
    ]);
  });
});

describe("ClaudeSdkTransport native background tasks", () => {
  it("reports background tasks from the native live set", async () => {
    const value = fixture();
    await value.transport.start();
    try {
      expect(value.transport.hasBackgroundTasks()).toBe(false);
      value.fakeQuery.push({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "bash-1", task_type: "local_bash", description: "sleep 5" }],
      } as unknown as SDKMessage);
      await vi.waitFor(() => expect(value.transport.hasBackgroundTasks()).toBe(true));
      value.fakeQuery.push({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
      } as unknown as SDKMessage);
      await vi.waitFor(() => expect(value.transport.hasBackgroundTasks()).toBe(false));
    } finally {
      await value.transport.close();
    }
  });
});

describe("ClaudeSdkTransport background task stop", () => {
  it("bounds a background task stop by the abort timeout", async () => {
    const value = fixture();
    value.fakeQuery.stopTask.mockImplementation(async () => new Promise(() => undefined));
    const transport = new ClaudeSdkTransport({
      command: process.execPath,
      cwd: process.cwd(),
      sessionId: "00000000-0000-4000-8000-000000000001",
      openMode: "create",
      permissionMode: "default",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("auto"),
      closeTimeoutMs: 20,
      abortTimeoutMs: 20,
      onPermissionModeChanged: value.onPermissionModeChanged,
      onFault: value.onFault,
      onPlanLimit: value.onPlanLimit,
      queryFactory: value.queryFactory,
    });
    await transport.start();
    try {
      await expect(transport.stopBackgroundTask("bash-1")).rejects.toThrow(
        "Claude background task stop timed out",
      );
    } finally {
      value.fakeQuery.stopTask.mockImplementation(async () => undefined);
      await transport.close();
    }
  });
});

describe("ClaudeSdkTransport confirmed background stops", () => {
  function liveTasks(fakeQuery: FakeQuery, taskIds: string[]): void {
    fakeQuery.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: taskIds.map((task_id) => ({ task_id, task_type: "local_agent" })),
    } as unknown as SDKMessage);
  }

  function shortTimeoutTransport(value: ReturnType<typeof fixture>) {
    return new ClaudeSdkTransport({
      command: process.execPath,
      cwd: process.cwd(),
      sessionId: "00000000-0000-4000-8000-000000000001",
      openMode: "create",
      permissionMode: "default",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("auto"),
      closeTimeoutMs: 20,
      abortTimeoutMs: 20,
      onPermissionModeChanged: value.onPermissionModeChanged,
      onFault: value.onFault,
      onPlanLimit: value.onPlanLimit,
      queryFactory: value.queryFactory,
    });
  }

  it("resolves once Claude Code reports each stopped task", async () => {
    const value = fixture();
    await value.transport.start();
    try {
      liveTasks(value.fakeQuery, ["workflow-1", "agent-1"]);
      await vi.waitFor(() => expect(value.transport.hasBackgroundTasks()).toBe(true));

      await value.transport.stopTasks(["workflow-1", "agent-1", "workflow-1"]);

      expect(value.fakeQuery.stopTask.mock.calls).toEqual([["workflow-1"], ["agent-1"]]);
      expect(value.transport.hasBackgroundTasks()).toBe(false);
    } finally {
      await value.transport.close();
    }
  });

  it("accepts a failed stop for a task that already ended", async () => {
    const value = fixture();
    value.fakeQuery.stopTask.mockRejectedValueOnce(new Error("No task found with ID: agent-1"));
    await value.transport.start();
    try {
      await expect(value.transport.stopTasks(["agent-1"])).resolves.toBeUndefined();
    } finally {
      await value.transport.close();
    }
  });

  it("rejects a stop Claude Code acknowledges but does not carry out", async () => {
    const value = fixture();
    // The control request succeeds, but the task stays in the native live set.
    value.fakeQuery.stopTask.mockImplementation(async () => undefined);
    const transport = shortTimeoutTransport(value);
    await transport.start();
    try {
      liveTasks(value.fakeQuery, ["agent-1"]);
      await vi.waitFor(() => expect(transport.hasBackgroundTasks()).toBe(true));
      await expect(transport.stopTasks(["agent-1"])).rejects.toThrow(
        "Claude background task stop was not confirmed",
      );
    } finally {
      liveTasks(value.fakeQuery, []);
      await vi.waitFor(() => expect(transport.hasBackgroundTasks()).toBe(false));
      await transport.close();
    }
  });

  it("rejects a failed stop for a task Claude Code still runs", async () => {
    const value = fixture();
    value.fakeQuery.stopTask.mockRejectedValueOnce(new Error("stop failed"));
    await value.transport.start();
    try {
      liveTasks(value.fakeQuery, ["agent-1"]);
      await vi.waitFor(() => expect(value.transport.hasBackgroundTasks()).toBe(true));
      await expect(value.transport.stopTasks(["agent-1"])).rejects.toThrow("stop failed");
    } finally {
      await value.transport.close();
    }
  });
});

describe("ClaudeSdkTransport Ultracode", () => {
  const ultracode = harnessThinkingOptionIdSchema.parse("ultracode");
  const enter = { alwaysThinkingEnabled: true, effortLevel: "xhigh", ultracode: true };

  it("turns Ultracode on before the first message and confirms it from native settings", async () => {
    const value = fixture("create", "default", ultracode);

    await value.transport.start();

    expect(options(value).thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(options(value).effort).toBe("xhigh");
    expect(value.fakeQuery.applyFlagSettings).toHaveBeenCalledTimes(1);
    expect(value.fakeQuery.applyFlagSettings).toHaveBeenCalledWith(enter);
    expect(value.fakeQuery.getSettings).toHaveBeenCalledTimes(1);
    await value.transport.close();
  });

  it("fails startup when Claude Code does not put Ultracode into effect", async () => {
    const value = fixture("create", "default", ultracode);
    value.fakeQuery.getSettings.mockResolvedValueOnce({
      applied: { ultracode: false, ultracodeRequested: true, ultracodeAvailable: false },
      effective: {},
    });
    const close = vi.spyOn(value.fakeQuery, "close");

    await expect(value.transport.start()).rejects.toMatchObject({
      name: "ClaudeUltracodeUnavailableError",
      reason: "unavailable",
    });
    expect(close).toHaveBeenCalled();
    expect(value.transport.slashCommands()).toBeNull();
  });

  it("fails closed when the native settings cannot be read", async () => {
    const value = fixture("create", "default", ultracode);
    value.fakeQuery.getSettings.mockRejectedValueOnce(new Error("unknown control request"));

    await expect(value.transport.start()).rejects.toMatchObject({ reason: "unverifiable" });
  });

  it("restores the confirmed selection when a live switch to Ultracode is not honored", async () => {
    const value = fixture("create", "default", harnessThinkingOptionIdSchema.parse("high"));
    await value.transport.start();
    // Claude Code before 2.1.154 merges the unknown key and reports no Ultracode state.
    value.fakeQuery.getSettings
      .mockResolvedValueOnce({ applied: { effort: "xhigh" } })
      .mockResolvedValueOnce({ applied: { effort: "high" } });

    await expect(value.transport.setThinkingOption(ultracode)).rejects.toMatchObject({
      reason: "unsupportedVersion",
    });
    // The restored selection is read back as well.
    expect(value.fakeQuery.getSettings).toHaveBeenCalledTimes(2);
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.setThinkingOption(harnessThinkingOptionIdSchema.parse("medium"));

    expect(value.fakeQuery.applyFlagSettings.mock.calls).toEqual([
      [enter],
      [{ alwaysThinkingEnabled: true, effortLevel: "high", ultracode: false }],
      // The rejected selection never took effect, so leaving it sends no Ultracode key.
      [{ alwaysThinkingEnabled: true, effortLevel: "medium" }],
    ]);
    await value.transport.close();
  });

  it("clears Ultracode explicitly when leaving it", async () => {
    const value = fixture("create", "default", ultracode);
    await value.transport.start();

    await value.transport.setThinkingOption(harnessThinkingOptionIdSchema.parse("xhigh"));
    await value.transport.setThinkingOption(harnessThinkingOptionIdSchema.parse("off"));
    await value.transport.setThinkingOption(ultracode);
    await value.transport.setThinkingOption(harnessThinkingOptionIdSchema.parse("off"));

    expect(value.fakeQuery.applyFlagSettings.mock.calls).toEqual([
      [enter],
      [{ alwaysThinkingEnabled: true, effortLevel: "xhigh", ultracode: false }],
      [{ alwaysThinkingEnabled: false }],
      [enter],
      [{ alwaysThinkingEnabled: false, ultracode: false }],
    ]);
    expect(value.fakeQuery.getSettings).toHaveBeenCalledTimes(2);
    await value.transport.close();
  });

  it("rejects a Model that cannot keep Ultracode and restores the previous Model", async () => {
    const value = fixture("create", "default", ultracode);
    await value.transport.start();
    value.fakeQuery.getSettings.mockResolvedValueOnce({
      applied: { ultracode: false, ultracodeRequested: true, ultracodeAvailable: false },
      effective: { enableWorkflows: true },
    });

    await expect(value.transport.setModel("haiku")).rejects.toMatchObject({
      reason: "modelUnsupported",
    });
    expect(value.fakeQuery.setModel.mock.calls).toEqual([["haiku"], [undefined]]);
    expect(value.fakeQuery.applyFlagSettings.mock.calls.at(-1)).toEqual([enter]);
    // Ultracode is confirmed on again with the previous Model.
    expect(value.fakeQuery.getSettings).toHaveBeenCalledTimes(3);
    expect(value.onFault).not.toHaveBeenCalled();

    await value.transport.setModel("sonnet");
    await value.transport.setModel("opus");
    expect(value.fakeQuery.setModel.mock.calls.slice(2)).toEqual([["sonnet"], ["opus"]]);
    await value.transport.close();
  });

  it("faults the Session when the confirmed state cannot be restored", async () => {
    const value = fixture("create", "default", ultracode);
    await value.transport.start();
    value.fakeQuery.getSettings.mockResolvedValueOnce({ applied: { ultracode: false } });
    const restoreFailure = new Error("native restore failed");
    value.fakeQuery.setModel.mockResolvedValueOnce(undefined).mockRejectedValueOnce(restoreFailure);

    await expect(value.transport.setModel("haiku")).rejects.toMatchObject({
      reason: "notApplied",
    });
    expect(value.onFault).toHaveBeenCalledWith(restoreFailure);
    await value.transport.close();
  });

  it("faults the Session when the previous Model does not bring Ultracode back", async () => {
    const value = fixture("create", "default", ultracode);
    await value.transport.start();
    const unavailable = {
      applied: { ultracode: false, ultracodeRequested: true, ultracodeAvailable: false },
      effective: { enableWorkflows: true },
    };
    value.fakeQuery.getSettings
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(unavailable);

    await expect(value.transport.setModel("haiku")).rejects.toMatchObject({
      reason: "modelUnsupported",
    });
    expect(value.onFault).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "modelUnsupported" }),
    );
    await value.transport.close();
  });

  it("faults the Session when Claude Code keeps Ultracode on after a rejected switch", async () => {
    const value = fixture("create", "default", harnessThinkingOptionIdSchema.parse("high"));
    await value.transport.start();
    value.fakeQuery.getSettings
      .mockResolvedValueOnce({ applied: { ultracode: false } })
      .mockResolvedValueOnce({ applied: { ultracode: true } });

    await expect(value.transport.setThinkingOption(ultracode)).rejects.toMatchObject({
      reason: "notApplied",
    });
    expect(value.onFault).toHaveBeenCalledWith(
      new Error("Claude Code kept Ultracode on after it was cleared"),
    );
    await value.transport.close();
  });

  it("leaves other selections unconfirmed and untouched by Ultracode", async () => {
    const value = fixture("create", "default", harnessThinkingOptionIdSchema.parse("max"));
    await value.transport.start();
    await value.transport.setModel("haiku");
    await value.transport.setThinkingOption(harnessThinkingOptionIdSchema.parse("low"));

    expect(value.fakeQuery.getSettings).not.toHaveBeenCalled();
    expect(value.fakeQuery.applyFlagSettings.mock.calls).toEqual([
      [{ alwaysThinkingEnabled: true, effortLevel: "low" }],
    ]);
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport Workflow agent Interactions", () => {
  const workflowProgress = {
    type: "system",
    subtype: "task_progress",
    task_id: "workflow-task",
    tool_use_id: "workflow-call",
    description: "Count lines",
    workflow_progress: [
      { type: "workflow_phase", index: 1, title: "Count" },
      {
        type: "workflow_agent",
        index: 1,
        label: "count:a.txt",
        agentId: "agent-a",
        state: "start",
        startedAt: 1,
      },
    ],
    session_id: "00000000-0000-4000-8000-000000000001",
  } as unknown as SDKMessage;

  /** The Workflow tool returns once the run is launched in the background. */
  function launchWorkflow(fakeQuery: FakeQuery): void {
    fakeQuery.push({
      type: "user",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "workflow-call", content: "Launched" }],
      },
      tool_use_result: { status: "async_launched", taskId: "workflow-task" },
    } as unknown as SDKMessage);
  }

  function agentPermission(
    canUseTool: NonNullable<ReturnType<typeof options>["canUseTool"]>,
    toolUseID: string,
    requestId: string,
  ) {
    return canUseTool(
      "Bash",
      { command: "wc -l a.txt" },
      {
        signal: new AbortController().signal,
        toolUseID,
        requestId,
        displayName: "Bash",
        description: "Count lines",
        agentID: "agent-a",
      },
    );
  }

  it("names the agent and routes its approval to the Root Segment that runs the Workflow", async () => {
    const value = fixture();
    const threadEvents: ClaudeTurnEvent[] = [];
    value.observeThreadEvents((event) => threadEvents.push(event));
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000010", (event) =>
      events.push(event),
    );
    pushToolUse(value.fakeQuery, "workflow-call", "Workflow", { name: "count" });
    value.fakeQuery.push(workflowProgress);
    // Run progress is a Session fact: a launched run keeps reporting after its Root Segment.
    await vi.waitFor(() =>
      expect(threadEvents).toContainEqual(expect.objectContaining({ type: "workflow.updated" })),
    );

    const permission = agentPermission(canUseTool, "agent-bash-tool", "agent-bash-control");
    expect(events.at(-1)).toEqual({
      type: "interaction.requested",
      request: {
        type: "approval",
        requestId: "claude-approval-1",
        title: "count:a.txt: Bash",
        description: "Count lines",
      },
    });
    await value.transport.respondToInteraction({
      type: "approval",
      requestId: "claude-approval-1",
      decision: "allowOnce",
    });
    await expect(permission).resolves.toMatchObject({
      behavior: "allow",
      toolUseID: "agent-bash-tool",
    });
    expect(events.at(-1)).toEqual({
      type: "interaction.closed",
      requestId: "claude-approval-1",
      reason: "responded",
    });
    launchWorkflow(value.fakeQuery);
    completeTurn(value.fakeQuery);
    await expect(turn).resolves.toEqual({ status: "succeeded" });
    await value.transport.close();
  });

  it("denies agent approvals once the Root Segment that runs the Workflow ends", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.startTurn("synthetic", "00000000-0000-4000-8000-000000000011", (event) =>
      events.push(event),
    );
    pushToolUse(value.fakeQuery, "workflow-call", "Workflow", { name: "count" });
    value.fakeQuery.push(workflowProgress);
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: "workflow.started" })),
    );
    const pending = agentPermission(canUseTool, "agent-bash-tool", "agent-bash-control");
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: "interaction.requested" })),
    );

    launchWorkflow(value.fakeQuery);
    completeTurn(value.fakeQuery);
    await expect(turn).resolves.toEqual({ status: "succeeded" });
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
    expect(events.at(-1)).toEqual({
      type: "interaction.closed",
      requestId: "claude-approval-1",
      reason: "superseded",
    });

    // No Turn can show a later request; the next native frame proves its owner is not live.
    const late = agentPermission(canUseTool, "agent-bash-tool-2", "agent-bash-control-2");
    value.fakeQuery.push(workflowProgress);
    await expect(late).resolves.toMatchObject({ behavior: "deny" });
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport steer", () => {
  it("pushes priority next and accepts when Claude starts that command", async () => {
    const value = fixture();
    await value.transport.start();
    const prompt = value.queryInput().prompt;
    if (typeof prompt === "string" || !prompt) throw new Error("expected streaming input");
    const input = prompt[Symbol.asyncIterator]();
    const turn = value.startTurn("hello", "00000000-0000-4000-8000-000000000030", () => undefined);
    await expect(input.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "user",
        message: { role: "user", content: "hello" },
        parent_tool_use_id: null,
      },
    });
    const steerId = "00000000-0000-4000-8000-000000000031";
    let settled = false;
    const steered = value.steer("PIN", steerId).then(() => {
      settled = true;
    });
    await expect(input.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "user",
        priority: "next",
        uuid: steerId,
        origin: { kind: "human" },
        parent_tool_use_id: null,
        session_id: "00000000-0000-4000-8000-000000000001",
        message: { role: "user", content: "PIN" },
      },
    });
    value.fakeQuery.push({
      type: "command_lifecycle",
      state: "queued",
      command_uuid: steerId,
      uuid: "00000000-0000-4000-8000-000000000032",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    await steered;
    expect(settled).toBe(true);
    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });

  it("resolves a late queued steer arriving after the Turn terminal", async () => {
    const value = fixture();
    await value.transport.start();
    const turn = value.startTurn("hello", "00000000-0000-4000-8000-000000000034", () => undefined);
    const steerId = "00000000-0000-4000-8000-000000000035";
    const steered = value.steer("PIN", steerId);
    completeTurn(value.fakeQuery);
    await turn;
    // Late queued arrives after terminal
    value.fakeQuery.push({
      type: "command_lifecycle",
      state: "queued",
      command_uuid: steerId,
      uuid: "00000000-0000-4000-8000-000000000036",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    await expect(steered).resolves.toBeUndefined();
    await value.transport.close();
  });

  it("reports acceptance uncertain when steer is not queued within 10s timeout", async () => {
    vi.useFakeTimers();
    try {
      const value = fixture();
      await value.transport.start();
      const turn = value.startTurn(
        "hello",
        "00000000-0000-4000-8000-000000000037",
        () => undefined,
      );
      const steered = value.steer("PIN", "00000000-0000-4000-8000-000000000038");
      completeTurn(value.fakeQuery);
      await turn;
      const rejection = expect(steered).rejects.toThrow(
        "Claude input acceptance could not be confirmed; it may still execute",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
      await value.transport.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ClaudeSdkTransport regressions", () => {
  it("keeps one live owner for root init, tool execution, approval and steer", async () => {
    const value = fixture();
    const turns: ObservedTurn[] = [];
    value.observeContinuations(turns);
    await value.transport.start();
    value.fakeQuery.push({
      type: "system",
      subtype: "init",
      parent_tool_use_id: "child",
    } as unknown as SDKMessage);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(turns).toHaveLength(0);
    value.fakeQuery.push({ type: "system", subtype: "init" } as SDKMessage);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("Approval callback missing");
    const approval = canUseTool(
      "Bash",
      { command: "echo 1" },
      { signal: new AbortController().signal, toolUseID: "call", requestId: "approval" },
    );
    pushToolUse(value.fakeQuery, "call", "Bash", { command: "echo 1" });
    let requested: Extract<ClaudeTurnEvent, { type: "interaction.requested" }> | undefined;
    await vi.waitFor(() => {
      requested = turns[0]?.events.find((e) => e.type === "interaction.requested");
      expect(requested).toBeDefined();
    });
    if (!requested) throw new Error("Approval missing");
    await value.transport.respondToInteraction({
      type: "approval",
      requestId: requested.request.requestId,
      decision: "allowOnce",
    });
    await expect(approval).resolves.toMatchObject({ behavior: "allow" });
    const steer = value.steer("adjust", "steer");
    value.fakeQuery.push({
      type: "command_lifecycle",
      state: "queued",
      command_uuid: "steer",
    } as unknown as SDKMessage);
    await steer;
    completeTool(value.fakeQuery, "call");
    completeTurn(value.fakeQuery);
    await vi.waitFor(() => expect(turns[0]?.terminal).toEqual({ status: "succeeded" }));
    expect(turns).toHaveLength(1);
    expect(
      turns[0]?.events
        .filter((e) => e.type === "tool.started" || e.type === "tool.completed")
        .map((e) => e.type),
    ).toEqual(["tool.started", "tool.completed"]);
    await value.transport.close();
  });
  it("keeps an accepted input separate from a preceding native continuation", async () => {
    const value = fixture();
    const events: ClaudeSessionEvent[] = [];
    value.transport.setEventHandler((event) => {
      events.push(event);
    });
    await value.transport.start();
    const accepted = value.transport.submitInput("new input", "new-input", "later");
    value.fakeQuery.push({
      type: "command_lifecycle",
      state: "queued",
      command_uuid: "new-input",
    } as unknown as SDKMessage);
    await accepted;
    value.fakeQuery.push({ type: "system", subtype: "init" } as SDKMessage);
    pushAssistantText(value.fakeQuery, "prior continuation", "prior-message");
    completeTurn(value.fakeQuery);
    value.fakeQuery.push({
      type: "command_lifecycle",
      state: "started",
      command_uuid: "new-input",
    } as unknown as SDKMessage);
    value.fakeQuery.push({ type: "system", subtype: "init" } as SDKMessage);
    pushAssistantText(value.fakeQuery, "new reply", "new-message");
    completeTurn(value.fakeQuery);
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === "segment.completed")).toHaveLength(2),
    );
    const starts = events.filter((e) => e.type === "segment.started");
    expect(starts.map((e) => e.inputIds)).toEqual([[], ["new-input"]]);
    expect(
      events.flatMap((e) =>
        e.type === "segment.event" && e.event.type === "text.delta"
          ? [{ segmentId: e.segmentId, text: e.event.delta }]
          : [],
      ),
    ).toEqual([
      { segmentId: starts[0]?.segmentId, text: "prior continuation" },
      { segmentId: starts[1]?.segmentId, text: "new reply" },
    ]);
    await value.transport.close();
  });

  it("denies a background child's permission when its native parent no longer has a live output owner", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("Tool approval callback missing");
    const permission = canUseTool(
      "Bash",
      { command: "true" },
      {
        signal: new AbortController().signal,
        toolUseID: "background-child-tool",
        requestId: "child-request",
        agentID: "background-agent",
      },
    );
    value.fakeQuery.push({
      type: "assistant",
      parent_tool_use_id: "finished-parent",
      uuid: "child-assistant",
      message: {
        id: "child-message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "background-child-tool",
            name: "Bash",
            input: { command: "true" },
          },
        ],
      },
    } as unknown as SDKMessage);
    await expect(permission).resolves.toMatchObject({ behavior: "deny" });
    expect(value.transport.isRunning()).toBe(false);
    await value.transport.close();
  });
  it("completes a foreground segment after a steer changes the result user_message_uuid", async () => {
    const value = fixture();
    await value.transport.start();
    const running = value.startTurn("original", "original-input", () => undefined);
    value.fakeQuery.push({
      type: "command_lifecycle",
      state: "started",
      command_uuid: "original-input",
    } as unknown as SDKMessage);
    pushAssistantText(value.fakeQuery, "working", "work-message");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const steer = value.steer("adjust", "steer-input");
    value.fakeQuery.push({
      type: "command_lifecycle",
      state: "queued",
      command_uuid: "steer-input",
    } as unknown as SDKMessage);
    await steer;
    value.fakeQuery.push({
      type: "result",
      subtype: "success",
      is_error: false,
      user_message_uuid: "steer-input",
    } as SDKMessage);
    await expect(running).resolves.toEqual({ status: "succeeded" });
    expect(value.transport.isRunning()).toBe(false);
    await value.transport.close();
  });
});
