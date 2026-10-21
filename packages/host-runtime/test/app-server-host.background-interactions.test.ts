import { describe, expect, it, vi } from "vitest";
import type { HostCommand, HostSubagentDelegationItem } from "@codexhost/harness-adapter";
import { hostInteractionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { DelegationControlApi } from "../src/delegation-types.js";
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

describe("Native background interaction ownership", () => {
  it("answers a background approval while new work runs and cancels only its old task owner", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsNativeExecutionLifecycle = true;
    try {
      const threadId = await startPiThread(fixture);
      const first = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Expected native session");
      const ownerId = session.startSubagentDelegation({
        subagentId: "worker",
        description: "background",
        background: true,
        status: "running",
      });
      session.detachItem(ownerId);
      session.publishActivity("running");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", first));
      const second = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId, 3));
      const interactionId = hostInteractionIdSchema.parse("background-approval");
      const original = session.execute.bind(session);
      const commands: HostCommand[] = [];
      vi.spyOn(session, "execute").mockImplementation(async (input) => {
        const command = input as HostCommand;
        commands.push(command);
        if (command.type === "interaction.respond") {
          session.interactionResponses.push(command);
          session.emitEvent({
            type: "interaction.closed",
            turnId: first,
            interactionId: command.interactionId,
            reason: "responded",
          });
          return { ok: true, value: { accepted: true } } as never;
        }
        if (command.type === "turn.cancel" && command.turnId === first) {
          const item: HostSubagentDelegationItem = {
            type: "subagentDelegation",
            itemId: ownerId,
            operation: "spawn",
            subagents: [],
          };
          session.emitEvent({
            type: "item.completed",
            turnId: first,
            snapshot: { item, outcome: { status: "cancelled", reason: "Native task stopped" } },
          });
          return { ok: true, value: { cancellationRequested: true } } as never;
        }
        return original(input);
      });
      session.emitInteraction({
        type: "approval",
        turnId: first,
        ownerItemId: ownerId,
        interactionId,
        title: "Agent: Bash",
        subject: { type: "nativeAction" },
        actions: [
          { id: "allow", label: "Allow", effect: "allowOnce" },
          { id: "deny", label: "Deny", effect: "deny" },
        ],
      });
      const approval = await fixture.collector.waitFor((message) =>
        method(message, "mcpServer/elicitation/request"),
      );
      if (approval.id === undefined) throw new Error("Expected approval request ID");
      expect(approval.params).toMatchObject({ threadId, turnId: null });
      writeRequest(fixture.desktopInput, {
        id: approval.id,
        result: { action: "accept", content: {} },
      });
      await vi.waitFor(() => expect(session.interactionResponses).toHaveLength(1));
      expect(session.interactionResponses[0]).toMatchObject({
        interactionId,
        response: { actionId: "allow" },
      });
      session.emitInteraction({
        type: "question",
        turnId: first,
        ownerItemId: ownerId,
        interactionId: hostInteractionIdSchema.parse("background-question"),
        questions: [
          {
            id: "file",
            type: "text",
            prompt: "Which file?",
            optional: false,
            multiline: false,
            secret: false,
          },
        ],
      });
      const question = await fixture.collector.waitFor((message) =>
        method(message, "item/tool/requestUserInput"),
      );
      if (question.id === undefined) throw new Error("Expected question request ID");
      expect(question.params).toMatchObject({ threadId, turnId: first, isBlocking: false });
      writeRequest(fixture.desktopInput, {
        id: question.id,
        result: { answers: { file: { answers: ["a.txt"] } } },
      });
      await vi.waitFor(() => expect(session.interactionResponses).toHaveLength(2));
      expect(session.interactionResponses[1]).toMatchObject({
        interactionId: "background-question",
        response: { type: "question", answers: { file: ["a.txt"] } },
      });
      writeRequest(fixture.desktopInput, {
        id: 99,
        method: "turn/interrupt",
        params: { threadId, turnId: first },
      });
      const stopped = await fixture.collector.waitFor((message) => requestId(message, 99));
      expect(stopped).not.toHaveProperty("error");
      expect(
        commands.some((command) => command.type === "turn.cancel" && command.turnId === second),
      ).toBe(false);
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", second));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("uses thread cancel to stop background owners when no Root execution remains", async () => {
    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (value) => {
        api = value;
      },
    });
    try {
      const threadId = await startPiThread(fixture);
      const first = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Expected native session");
      const ownerId = session.startSubagentDelegation({
        subagentId: "worker",
        description: "background",
        background: true,
        status: "running",
      });
      session.detachItem(ownerId);
      session.publishActivity("running");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", first));
      const execute = vi
        .spyOn(session, "execute")
        .mockResolvedValue({ ok: true, value: { cancellationRequested: true } } as never);
      if (!api) throw new Error("Expected delegation control API");
      expect(await api.cancel({ threadId })).toMatchObject({ cancelled: true, turnId: null });
      expect(execute).toHaveBeenCalledWith({ type: "turn.cancel", turnId: first });
    } finally {
      await stopFixture(fixture);
    }
  });
});
