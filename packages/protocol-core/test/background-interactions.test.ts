import { describe, expect, it } from "vitest";
import type {
  HostApprovalInteraction,
  HostQuestionInteraction,
  HostSubagentDelegationItem,
} from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import { CodexTurnProjector } from "../src/index.js";

const turnId = hostTurnIdSchema.parse("root-turn");
const owner: HostSubagentDelegationItem = {
  type: "subagentDelegation",
  itemId: hostItemIdSchema.parse("workflow-owner"),
  operation: "spawn",
  subagents: [],
};

function runningTask() {
  const value = new CodexTurnProjector({
    threadId: "thread",
    turnId,
    cwd: "/workspace",
    startedAtMs: 1,
  });
  value.project({ type: "turn.started", turnId });
  value.project({ type: "item.started", turnId, item: owner });
  value.project({ type: "item.detached", turnId, itemId: owner.itemId });
  return value;
}

function approval(): HostApprovalInteraction {
  return {
    type: "approval",
    turnId,
    ownerItemId: owner.itemId,
    interactionId: hostInteractionIdSchema.parse("agent-approval"),
    title: "Agent: Bash",
    subject: { type: "nativeAction" },
    actions: [
      { id: "allow", label: "Allow", effect: "allowOnce" },
      { id: "deny", label: "Deny", effect: "deny" },
    ],
  };
}

describe("Interactions owned by native background tasks", () => {
  it("keeps an unanswered approval across Root completion and accepts a later approval", () => {
    const value = runningTask();
    value.projectApproval(approval(), "Claude Code");
    expect(
      value.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } })
        .completedTurn?.status,
    ).toBe("completed");
    value.project({
      type: "interaction.closed",
      turnId,
      interactionId: approval().interactionId,
      reason: "responded",
    });
    const late = { ...approval(), interactionId: hostInteractionIdSchema.parse("late-approval") };
    expect(value.projectApproval(late, "Claude Code").approvalRequest.request).toMatchObject({
      method: "mcpServer/elicitation/request",
      params: { turnId: null, threadId: "thread" },
    });
    value.project({
      type: "interaction.closed",
      turnId,
      interactionId: late.interactionId,
      reason: "cancelled",
    });
    value.project({
      type: "item.completed",
      turnId,
      snapshot: { item: owner, outcome: { status: "succeeded" } },
    });
    expect(value.hasOpenDetachedItems).toBe(false);
    expect(() => value.projectApproval(approval(), "Claude Code")).toThrow();
  });

  it("renders and settles an Agent question after the Root completed", () => {
    const value = runningTask();
    value.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
    const interaction: HostQuestionInteraction = {
      type: "question",
      turnId,
      ownerItemId: owner.itemId,
      interactionId: hostInteractionIdSchema.parse("agent-question"),
      questions: [
        {
          id: "q",
          type: "text",
          prompt: "Which file?",
          optional: false,
          multiline: false,
          secret: false,
        },
      ],
    };
    const result = value.projectQuestion(interaction, hostItemIdSchema.parse("question-item"));
    expect(result.questionRequest.request).toMatchObject({ params: { isBlocking: false } });
    expect(result.messages).toContainEqual(expect.objectContaining({ method: "item/started" }));
    const closed = value.project({
      type: "interaction.closed",
      turnId,
      interactionId: interaction.interactionId,
      reason: "responded",
    });
    expect(closed.messages).toContainEqual(expect.objectContaining({ method: "item/completed" }));
    expect(value.completed).toBe(true);
    expect(value.hasOpenDetachedItems).toBe(true);
  });

  it("retains a late native cancellation until the pending approval is retired", () => {
    const value = runningTask();
    value.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
    value.projectApproval(approval(), "Claude Code");
    value.project({
      type: "item.completed",
      turnId,
      snapshot: { item: owner, outcome: { status: "cancelled", reason: "Native task stopped" } },
    });
    expect(value.hasOpenDetachedItems).toBe(true);
    value.project({
      type: "interaction.closed",
      turnId,
      interactionId: approval().interactionId,
      reason: "cancelled",
    });
    expect(value.hasOpenDetachedItems).toBe(false);
    const unscoped = approval();
    delete unscoped.ownerItemId;
    expect(() => value.projectApproval(unscoped, "Claude Code")).toThrow("terminal event");
  });
});
