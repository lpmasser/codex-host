import { describe, expect, it } from "vitest";

import { CodexTurnProjector } from "../src/codex-ui-projector.js";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

const turnId = hostTurnIdSchema.parse("turn-1");
const itemId = hostItemIdSchema.parse("item-1");

describe("CodexTurnProjector pending Turn", () => {
  it("retains Desktop-owned input in read and terminal snapshots without publishing it twice", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/synthetic",
      startedAtMs: 1_000,
      initialInput: [{ type: "text", text: "Current user request" }],
      clientUserMessageId: "desktop-message",
      publishInitialInput: false,
    });
    const started = projector.project({ type: "turn.started", turnId });
    expect(started.messages).toHaveLength(1);
    expect(started.messages[0]).toMatchObject({
      method: "turn/started",
      params: { turn: { items: [] } },
    });
    expect(projector.pendingTurn()).toMatchObject({ items: [] });
    const snapshot = projector.pendingTurn(null, { includeInput: true });
    expect(snapshot).toMatchObject({
      items: [
        { id: `${turnId}-user`, type: "userMessage", content: [{ text: "Current user request" }] },
      ],
    });
    const completed = projector.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(completed.completedTurn?.items).toEqual(snapshot.items);
    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      method: "turn/completed",
      params: { turn: { items: [] } },
    });
  });
  it("includes explicitly projected input for an externally started Turn", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/synthetic",
      startedAtMs: 1_000,
      initialInput: [{ type: "text", text: "Review auth" }],
      clientUserMessageId: "client-1",
    });

    const started = projector.project({ type: "turn.started", turnId });

    expect(started.messages).toMatchObject([
      {
        method: "turn/started",
        params: {
          turn: {
            items: [
              {
                id: `${turnId}-user`,
                type: "userMessage",
                content: [{ type: "text", text: "Review auth", text_elements: [] }],
              },
            ],
          },
        },
      },
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId,
          item: {
            id: `${turnId}-user`,
            type: "userMessage",
            clientId: "client-1",
            content: [{ type: "text", text: "Review auth", text_elements: [] }],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId,
          item: {
            id: `${turnId}-user`,
            type: "userMessage",
            clientId: "client-1",
          },
        },
      },
    ]);
    expect(projector.pendingTurn()).toMatchObject({
      items: [
        {
          id: `${turnId}-user`,
          type: "userMessage",
          content: [{ type: "text", text: "Review auth", text_elements: [] }],
        },
      ],
    });
  });

  it("includes the current visible Agent message but excludes reasoning activity", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/synthetic",
      startedAtMs: 1_000,
    });
    projector.project({ type: "turn.started", turnId });
    projector.project({
      type: "item.started",
      turnId,
      item: { type: "agentMessage", itemId, text: "" },
    });
    projector.project({
      type: "item.updated",
      turnId,
      itemId,
      update: { type: "text.append", text: "Checking auth." },
    });
    const reasoningId = hostItemIdSchema.parse("reasoning-1");
    projector.project({
      type: "item.started",
      turnId,
      item: { type: "reasoning", itemId: reasoningId, text: "hidden" },
    });

    expect(projector.pendingTurn()).toMatchObject({
      status: "inProgress",
      items: [
        {
          id: itemId,
          type: "agentMessage",
          text: "Checking auth.",
        },
      ],
    });
    expect(JSON.stringify(projector.pendingTurn())).not.toContain("hidden");
  });
});
