import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import {
  createFixture,
  readJsonLine,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
} from "./app-server-host-fixture.js";

describe("Delegation context", () => {
  it("creates native tasks with no parent while zero, one, or several Turns are active", async () => {
    const registry = new DelegationControlRegistry();
    const fixture = createFixture({ onDelegationApi: (api) => registry.register(api) });
    try {
      await fixture.ready;
      for (let index = 0; index < 3; index++) {
        const input = {
          harnessId: "codex" as const,
          task: "independent task",
          cwd: "/synthetic",
          ...(index === 0 ? { requestId: "root-request" } : {}),
        };
        const pending = registry.start(input);
        const start = await readJsonLine(fixture.official.stdin);
        expect(start).toMatchObject({ method: "thread/start", params: { cwd: "/synthetic" } });
        fixture.official.stdout.write(
          `${JSON.stringify({ id: start.id, result: { thread: { id: `root-${index}` } } })}\n`,
        );
        const name = await readJsonLine(fixture.official.stdin);
        expect(name).toMatchObject({
          method: "thread/name/set",
          params: { name: "independent task" },
        });
        fixture.official.stdout.write(`${JSON.stringify({ id: name.id, result: {} })}\n`);
        const turn = await readJsonLine(fixture.official.stdin);
        expect(turn).toMatchObject({
          method: "turn/start",
          params: { input: [{ text: "independent task" }] },
        });
        fixture.official.stdout.write(
          `${JSON.stringify({ id: turn.id, result: { turn: { id: `turn-${index}` } } })}\n`,
        );
        const result = await pending;
        expect(result).toMatchObject({ threadId: `root-${index}` });
        expect(result).not.toHaveProperty("parentThreadId");
        if (index === 0) expect(await registry.start(input)).toMatchObject({ threadId: "root-0" });
      }
      const records = await fixture.mappingStore.listDelegations();
      expect(records).toHaveLength(3);
      for (const record of records) {
        expect(record).not.toHaveProperty("parentHostThreadId");
        expect(record).not.toHaveProperty("sourceHarnessId");
      }
    } finally {
      registry.close();
      await stopFixture(fixture);
    }
  });

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
