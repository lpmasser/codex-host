import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import { ClaudeWorkflowLifecycle } from "../src/workflow-lifecycle.js";

const turnId = hostTurnIdSchema.parse("turn-1");

function lifecycle() {
  const events: HostEvent[] = [];
  let ordinal = 0;
  const workflows = new ClaudeWorkflowLifecycle({
    newItemId: () => hostItemIdSchema.parse(`workflow-item-${++ordinal}`),
    emit: (event) => events.push(event),
  });
  return { events, workflows };
}

describe("Claude Workflow lifecycle", () => {
  it("opens one delegation per run and replaces its agents as they report", () => {
    const { events, workflows } = lifecycle();
    workflows.start(turnId, { type: "workflow.started", callId: "workflow-call" });
    expect(events).toEqual([]);
    expect(workflows.pendingCount).toBe(1);

    expect(
      workflows.update({
        type: "workflow.updated",
        callId: "workflow-call",
        taskId: "workflow-task",
        description: "Count lines",
      }),
    ).toEqual([]);
    expect(events).toEqual([
      {
        type: "item.started",
        turnId,
        item: {
          type: "subagentDelegation",
          itemId: "workflow-item-1",
          operation: "spawn",
          prompt: "Count lines",
          subagents: [],
        },
      },
    ]);

    const changed = workflows.update({
      type: "workflow.updated",
      callId: "workflow-call",
      agents: [
        { index: 2, label: "count:b.txt", state: "queued" },
        {
          index: 1,
          label: "count:a.txt",
          state: "running",
          agentId: "agent-a",
          phaseTitle: "Count",
          model: "claude-sonnet-5-5",
        },
      ],
    });
    expect(changed).toEqual(["agent-a"]);
    expect(events.at(-1)).toEqual({
      type: "item.updated",
      turnId,
      itemId: "workflow-item-1",
      update: {
        type: "subagents.replace",
        subagents: [
          {
            subagentId: "workflow-call:1",
            nativeSubagentId: "agent-a",
            description: "count:a.txt",
            role: "Count",
            model: "claude-sonnet-5-5",
            background: true,
            status: "running",
          },
          {
            subagentId: "workflow-call:2",
            description: "count:b.txt",
            background: true,
            status: "pending",
          },
        ],
      },
    });

    // A repeated frame changes nothing.
    const emitted = events.length;
    workflows.update({
      type: "workflow.updated",
      callId: "workflow-call",
      agents: [{ index: 2, label: "count:b.txt", state: "queued" }],
    });
    expect(events).toHaveLength(emitted);
    expect(workflows.activity("workflow-call")).toEqual(["agent-a"]);
    expect(workflows.activity("unknown-call")).toEqual([]);
  });

  it("keeps a launched run open until its native task settles", () => {
    const { events, workflows } = lifecycle();
    workflows.start(turnId, { type: "workflow.started", callId: "workflow-call", name: "review" });

    expect(
      workflows.launched(
        {
          type: "workflow.launched",
          callId: "workflow-call",
          isError: false,
          background: true,
          taskId: "workflow-task",
        },
        false,
      ),
    ).toEqual({ callId: "workflow-call", taskId: "workflow-task" });
    expect(events).toMatchObject([
      { type: "item.started", item: { prompt: "review", subagents: [] } },
    ]);
    expect(workflows.pendingCount).toBe(0);
    expect(workflows.taskIds(turnId)).toEqual(["workflow-task"]);

    workflows.update({
      type: "workflow.updated",
      callId: "workflow-call",
      agents: [
        { index: 1, label: "a", state: "done", agentId: "agent-a", resultPreview: "3 lines" },
        { index: 2, label: "b", state: "running", agentId: "agent-b" },
        { index: 3, label: "c", state: "queued" },
        { index: 4, label: "d", state: "error", agentId: "agent-d", error: "blocked" },
      ],
    });
    expect(
      workflows.settle({
        type: "subagent.settled",
        nativeSubagentId: "workflow-task",
        status: "completed",
      }),
    ).toEqual({
      callId: "workflow-call",
      taskId: "workflow-task",
      nativeSubagentIds: ["agent-a", "agent-b", "agent-d"],
    });
    expect(events.at(-1)).toMatchObject({
      type: "item.completed",
      snapshot: {
        outcome: { status: "succeeded" },
        item: {
          subagents: [
            { subagentId: "workflow-call:1", status: "completed", resultSummary: "3 lines" },
            { subagentId: "workflow-call:2", status: "completed" },
            { subagentId: "workflow-call:3", status: "interrupted" },
            { subagentId: "workflow-call:4", status: "failed", resultSummary: "blocked" },
          ],
        },
      },
    });
    expect(workflows.taskIds(turnId)).toEqual([]);
    expect(
      workflows.settle({
        type: "subagent.settled",
        nativeSubagentId: "workflow-task",
        status: "completed",
      }),
    ).toBeNull();
  });

  it("settles a run that did not launch from its tool result", () => {
    const { events, workflows } = lifecycle();
    workflows.start(turnId, { type: "workflow.started", callId: "denied" });
    expect(
      workflows.launched(
        { type: "workflow.launched", callId: "denied", isError: true, background: false },
        false,
      ),
    ).toBeNull();
    expect(events.map(({ type }) => type)).toEqual(["item.started", "item.completed"]);
    expect(events.at(-1)).toMatchObject({
      snapshot: { outcome: { status: "failed", error: { code: "nativeFailure" } } },
    });

    workflows.start(turnId, { type: "workflow.started", callId: "cancelled" });
    workflows.launched(
      { type: "workflow.launched", callId: "cancelled", isError: false, background: true },
      true,
    );
    expect(events.at(-1)).toMatchObject({
      snapshot: { outcome: { status: "cancelled" } },
    });
  });

  it("ends open runs with the Turn and drops runs that never reached Claude Code", () => {
    const { events, workflows } = lifecycle();
    workflows.start(turnId, { type: "workflow.started", callId: "never-ran" });
    workflows.start(turnId, { type: "workflow.started", callId: "running" });
    workflows.update({
      type: "workflow.updated",
      callId: "running",
      taskId: "running-task",
      agents: [{ index: 1, label: "a", state: "running", agentId: "agent-a" }],
    });

    workflows.finalize(turnId, { status: "cancelled", reason: "Cancelled by user" });

    expect(events.map(({ type }) => type)).toEqual(["item.started", "item.completed"]);
    expect(events.at(-1)).toMatchObject({
      snapshot: {
        outcome: { status: "cancelled" },
        item: { subagents: [{ nativeSubagentId: "agent-a", status: "interrupted" }] },
      },
    });
    expect(workflows.pendingCount).toBe(0);
  });

  it("keeps a launched run working after its Turn and reports its agents at Session level", () => {
    const { events, workflows } = lifecycle();
    const otherTurnId = hostTurnIdSchema.parse("turn-2");
    workflows.start(turnId, { type: "workflow.started", callId: "workflow-call" });
    workflows.update({
      type: "workflow.updated",
      callId: "workflow-call",
      taskId: "workflow-task",
      agents: [
        { index: 1, label: "a", state: "running", agentId: "agent-a" },
        { index: 2, label: "b", state: "queued" },
      ],
    });
    workflows.launched(
      {
        type: "workflow.launched",
        callId: "workflow-call",
        isError: false,
        background: true,
        taskId: "workflow-task",
      },
      false,
    );

    workflows.finalize(otherTurnId, { status: "succeeded" });
    expect(events.map(({ type }) => type)).toEqual(["item.started"]);
    workflows.finalize(turnId, { status: "succeeded" });
    expect(events.at(-1)).toMatchObject({
      type: "item.completed",
      turnId,
      snapshot: {
        outcome: { status: "succeeded" },
        item: {
          subagents: [
            { nativeSubagentId: "agent-a", status: "running" },
            { subagentId: "workflow-call:2", status: "pending" },
          ],
        },
      },
    });
    expect(workflows.taskIds(turnId)).toEqual(["workflow-task"]);
    expect(workflows.taskIds(otherTurnId)).toEqual([]);

    const emitted = events.length;
    expect(
      workflows.update({
        type: "workflow.updated",
        callId: "workflow-call",
        agents: [
          { index: 1, label: "a", state: "done", agentId: "agent-a", resultPreview: "ok" },
          { index: 2, label: "b", state: "running", agentId: "agent-b" },
        ],
      }),
    ).toEqual(["agent-a", "agent-b"]);
    expect(events.slice(emitted)).toEqual([
      {
        type: "subagent.state.changed",
        nativeSubagentId: "agent-a",
        status: "completed",
        resultSummary: "ok",
      },
      { type: "subagent.state.changed", nativeSubagentId: "agent-b", status: "running" },
    ]);

    expect(
      workflows.settle({
        type: "subagent.settled",
        nativeSubagentId: "workflow-task",
        status: "interrupted",
      }),
    ).toMatchObject({ callId: "workflow-call" });
    expect(events.at(-1)).toEqual({
      type: "subagent.state.changed",
      nativeSubagentId: "agent-b",
      status: "interrupted",
    });
    expect(events.filter(({ type }) => type === "item.completed")).toHaveLength(1);
  });

  it("abandons every open run when the native process that ran them ends", () => {
    const { events, workflows } = lifecycle();
    workflows.start(turnId, { type: "workflow.started", callId: "workflow-call" });
    workflows.update({
      type: "workflow.updated",
      callId: "workflow-call",
      taskId: "workflow-task",
      agents: [{ index: 1, label: "a", state: "running", agentId: "agent-a" }],
    });
    workflows.abandon({ status: "cancelled", reason: "Claude Code Session closed" });
    expect(events.at(-1)).toMatchObject({
      type: "item.completed",
      snapshot: {
        outcome: { status: "cancelled" },
        item: { subagents: [{ nativeSubagentId: "agent-a", status: "interrupted" }] },
      },
    });
    expect(workflows.pendingCount).toBe(0);
  });
});
