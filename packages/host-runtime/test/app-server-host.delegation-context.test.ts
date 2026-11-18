import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import {
  createFixture,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
} from "./app-server-host-fixture.js";

describe("Delegation context", () => {
  it("keeps the current Desktop user message in Turn reads through completion and history refresh", async () => {
    const registry = new DelegationControlRegistry();
    const fixture = createFixture({ onDelegationApi: (api) => registry.register(api) });
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const started = await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/started", turnId),
      );
      expect(started).toMatchObject({ params: { turn: { items: [] } } });
      const first = await registry.read({ threadId, view: "messages", from: 1, to: 1 });
      expect(first.turns).toEqual([
        {
          turnId,
          turnNumber: 1,
          status: "running",
          messages: [{ id: `${turnId}-user`, role: "user", text: "synthetic" }],
        },
      ]);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing running Session");
      session.appendText("Answer");
      session.succeedTurn();
      const terminal = await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", turnId),
      );
      expect(((terminal.params as JsonObject).turn as JsonObject).items).toEqual([
        expect.objectContaining({ type: "agentMessage", text: "Answer" }),
      ]);
      vi.spyOn(session, "readSnapshot").mockResolvedValueOnce({
        ok: false,
        error: {
          code: "internalError",
          message: "Snapshot unavailable immediately after completion",
          retryable: false,
        },
      });
      const all = await registry.read({ threadId, view: "messages", from: 1, to: 1 });
      expect(all.turns?.[0]?.messages).toEqual([
        first.turns?.[0]?.messages[0],
        expect.objectContaining({ role: "agent", text: "Answer" }),
      ]);
      expect(
        fixture.collector.messages.filter(
          (message) =>
            message.method === "item/started" &&
            (message.params as { item?: { type?: string } }).item?.type === "userMessage",
        ),
      ).toHaveLength(0);
    } finally {
      registry.close();
      await stopFixture(fixture);
    }
  });
});
