import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type { InputConsumedEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeTurnRefSchema } from "@codexhost/shared-contracts";
import { ExternalThreadRuntime, type ExternalThread } from "../src/external-thread-runtime.js";
import {
  createFixture,
  method,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

function consumed(turnId: string): InputConsumedEvent {
  return {
    type: "input.consumed",
    consumingTurnId: hostTurnIdSchema.parse(turnId),
    inputId: "native-input",
    input: [{ type: "text", text: "steered text" }],
    clientUserMessageId: "desktop-input",
  };
}

describe("Host native execution capability", () => {
  it.each([false, true])(
    "gates pending admission and Session activity (declared=%s)",
    async (declared) => {
      const fixture = createFixture();
      fixture.adapter.supportsNativeExecutionLifecycle = declared;
      const release = Promise.withResolvers<undefined>();
      const register = ExternalThreadRuntime.prototype.register;
      let thread: ExternalThread | undefined;
      const registration = vi
        .spyOn(ExternalThreadRuntime.prototype, "register")
        .mockImplementation(function (this: ExternalThreadRuntime, input) {
          thread = register.call(this, input);
          return thread;
        });
      const open = fixture.adapter.open.bind(fixture.adapter);
      const opening = vi.spyOn(fixture.adapter, "open").mockImplementation(async (input) => {
        const result = await open(input);
        if (result.ok) {
          const iterator = result.value.outputs[Symbol.asyncIterator]();
          vi.spyOn(result.value.outputs, Symbol.asyncIterator).mockReturnValue({
            async next() {
              const output = await iterator.next();
              if (
                !output.done &&
                output.value.kind === "event" &&
                output.value.event.type === "turn.started"
              )
                await release.promise;
              return output;
            },
          });
        }
        return result;
      });
      try {
        const threadId = await startPiThread(fixture);
        writeRequest(fixture.desktopInput, {
          id: 80,
          method: "turn/start",
          params: { threadId, input: [{ type: "text", text: "first" }] },
        });
        const response = await fixture.collector.waitFor((message) => requestId(message, 80));
        expect(response).not.toHaveProperty("error");
        if (!thread) throw new Error("Thread was not registered");
        const turnId = thread.execution.activeTurnId ?? thread.execution.pendingTurnId;
        if (!turnId) throw new Error("Input was not admitted");
        expect(thread.execution.activeTurnId).toBe(declared ? null : turnId);
        expect(thread.execution.pendingTurnId).toBe(declared ? turnId : null);
        expect(thread.execution.running).toBe(true);
        release.resolve(undefined);
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
        expect(thread.execution.activeTurnId).toBe(turnId);
        expect(thread.execution.pendingTurnId).toBeNull();
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Missing Session");
        session.publishActivity("running");
        session.succeedTurn();
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
        expect(thread.execution.running).toBe(declared);
        expect(thread.execution.turnBusy).toBe(false);
        const next = await startPiTurn(fixture, threadId, 81);
        session.publishActivity("idle");
        session.succeedTurn();
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", next));
        expect(thread.execution.running).toBe(false);
      } finally {
        release.resolve(undefined);
        registration.mockRestore();
        opening.mockRestore();
        await stopFixture(fixture);
      }
    },
  );

  it.each([
    { nextTurn: false, beforeReceipt: false },
    { nextTurn: false, beforeReceipt: true },
    { nextTurn: true, beforeReceipt: false },
  ])(
    "publishes consumed input once (next=$nextTurn, before receipt=$beforeReceipt)",
    async ({ nextTurn, beforeReceipt }) => {
      const fixture = createFixture();
      fixture.adapter.supportsSteer = true;
      fixture.adapter.supportsNativeExecutionLifecycle = true;
      try {
        const threadId = await startPiThread(fixture);
        const rootTurn = await startPiTurn(fixture, threadId);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Missing Session");
        const consumingTurn = nextTurn ? "autonomous-consumer" : rootTurn;
        const fact = consumed(consumingTurn);
        const inputStarted = (message: JsonObject) =>
          method(message, "item/started") &&
          (message.params as { item?: { id?: string } })?.item?.id === fact.inputId;
        const execute = session.execute.bind(session);
        if (beforeReceipt) {
          vi.spyOn(session, "execute").mockImplementation(async (command) => {
            const result = await execute(command);
            session.emitEvent(fact);
            await fixture.collector.waitFor(inputStarted);
            return result;
          });
        }
        writeRequest(fixture.desktopInput, {
          id: 90,
          method: "turn/steer",
          params: {
            threadId,
            expectedTurnId: rootTurn,
            clientUserMessageId: "desktop-input",
            input: [{ type: "text", text: "steered text" }],
          },
        });
        const response = await fixture.collector.waitFor((message) => requestId(message, 90));
        expect(response).toMatchObject({
          result: { delivery: "nativeAccepted", turnId: rootTurn },
        });
        if (!beforeReceipt) expect(fixture.collector.messages.filter(inputStarted)).toHaveLength(0);
        if (nextTurn) {
          session.succeedTurn();
          await fixture.collector.waitFor((message) =>
            turnEvent(message, "turn/completed", rootTurn),
          );
          session.emitEvent({
            type: "turn.autonomous.started",
            turnId: hostTurnIdSchema.parse(consumingTurn),
            input: [],
          });
          session.emitEvent({
            type: "turn.started",
            turnId: hostTurnIdSchema.parse(consumingTurn),
          });
        }
        session.emitEvent(fact);
        session.emitEvent(fact);
        const shown = await fixture.collector.waitFor(inputStarted);
        expect(shown).toMatchObject({
          params: { turnId: consumingTurn, item: { id: fact.inputId, clientId: "desktop-input" } },
        });
        if (nextTurn) {
          session.emitEvent({
            type: "turn.completed",
            turnId: hostTurnIdSchema.parse(consumingTurn),
            nativeTurnRef: nativeTurnRefSchema.parse({
              harnessId: session.harnessId,
              nativeSessionId: session.initialState.nativeRef?.nativeSessionId,
              nativeTurnKey: "consumed-input",
              formatVersion: 1,
            }),
            outcome: { status: "succeeded" },
          });
        } else session.succeedTurn();
        await fixture.collector.waitFor((message) =>
          turnEvent(message, "turn/completed", consumingTurn),
        );
        expect(fixture.collector.messages.filter(inputStarted)).toHaveLength(1);
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("keeps acceptance-time input projection for an undeclared Session", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing Session");
      writeRequest(fixture.desktopInput, {
        id: 91,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: "desktop-input",
          input: [{ type: "text", text: "steered text" }],
        },
      });
      await fixture.collector.waitFor((message) => requestId(message, 91));
      session.emitEvent(consumed(turnId)); // An undeclared fact cannot add a second projection.
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      const inputs = fixture.collector.messages.filter(
        (message) =>
          method(message, "item/started") &&
          (message.params as { item?: { type?: string } })?.item?.type === "userMessage",
      );
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ params: { turnId, item: { clientId: "desktop-input" } } });
    } finally {
      await stopFixture(fixture);
    }
  });
});
