import { describe, expect, it } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type { DelegationControlApi, DelegationPendingQuestion } from "../src/delegation-types.js";
import {
  createFixture,
  method,
  readJsonLine,
  requiredMessageId,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const threadId = "native-thread";
const turnId = "native-turn";
const questions = [
  { title: "Format?", options: ["Markdown", "JSON"] },
  { title: "Anything else?" },
];

async function fixture() {
  let api!: DelegationControlApi;
  const f = createFixture({
    onDelegationApi: (value) => {
      api = value;
      return undefined;
    },
  });
  await f.ready;
  writeRequest(f.official.stdout, {
    method: "turn/started",
    params: { threadId, turn: { id: turnId, status: "inProgress" } },
  });
  await f.collector.waitFor((m) => method(m, "turn/started"));
  const item = { type: "agentMessage", id: "async-item", text: "", phase: "commentary", questions };
  const publish = async (name = "item/completed") => {
    const before = f.collector.messages.length;
    writeRequest(f.official.stdout, { method: name, params: { threadId, turnId, item } });
    await f.collector.waitFor((m) => f.collector.messages.indexOf(m) >= before && method(m, name));
  };
  await publish("item/started");
  const read = async (wait = false) => {
    const reading = wait
      ? api.wait({ threadId, view: "result", timeoutMs: 1000 })
      : api.read({ threadId, view: "result" });
    const request = await readJsonLine(f.official.stdin);
    expect(request.method).toBe("thread/read");
    writeRequest(f.official.stdout, {
      id: requiredMessageId(request),
      result: {
        thread: {
          id: threadId,
          status: { type: "active" },
          turns: [{ id: turnId, status: "inProgress", items: [item] }],
        },
      },
    });
    return reading;
  };
  const pending = (await read()).pendingQuestions;
  const first = pending?.[0];
  const second = pending?.[1];
  if (!pending || !first || !second) throw new Error("Missing async Questions");
  return { f, api, read, pending, first, second, publish };
}

function desktopReply(question: DelegationPendingQuestion, answer = "Markdown"): JsonObject {
  return {
    id: 900,
    method: "turn/steer",
    params: {
      threadId,
      expectedTurnId: turnId,
      clientUserMessageId: "desktop-message",
      input: [
        {
          type: "text",
          text: `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: question.request.questionItemId, question: question.request.title, answer }])}\n</send_user_message_question_reply>`,
        },
      ],
    },
  };
}

describe("Native asynchronous questions through delegation", () => {
  it("reads each question, answers the original Turn, and keeps unanswered siblings", async () => {
    const { f, api, read, pending, first, publish } = await fixture();
    try {
      expect(pending).toHaveLength(2);
      expect(pending.map((q) => q.kind)).toEqual([
        "requestUserInputAsync",
        "requestUserInputAsync",
      ]);
      expect(pending[0]?.request).toMatchObject({
        ...questions[0],
        itemId: "async-item",
        questionItemId: JSON.stringify(["request_user_input_async", "async-item", 0]),
      });
      const input = {
        threadId,
        interactionId: first.interactionId,
        result: { answer: "Markdown" },
      };
      await expect(api.answer({ ...input, result: { answer: " " } })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      const answering = api.answer(input);
      const native = await readJsonLine(f.official.stdin);
      expect(native.method).toBe("turn/steer");
      expect(native.params).toEqual({
        threadId,
        expectedTurnId: turnId,
        input: (desktopReply(first).params as JsonObject).input,
      });
      writeRequest(f.desktopInput, desktopReply(first, "JSON"));
      const competing = await f.collector.waitFor((m) => m.id === 900);
      expect(competing).toMatchObject({ error: { code: -32602 } });
      expect(f.official.stdin.read()).toBeNull();
      writeRequest(f.official.stdout, { id: requiredMessageId(native), result: { turnId } });
      await expect(answering).resolves.toMatchObject({ turnId, status: "running" });
      await publish(); // Native completed notification must not resurrect the answered question.
      expect((await read()).pendingQuestions).toEqual([pending[1]]);
      await expect(api.answer(input)).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
      expect(f.collector.messages.filter((m) => method(m, "serverRequest/resolved"))).toEqual([]);
    } finally {
      await stopFixture(f);
    }
  });

  it("wait returns an async question even though the native Turn is still running", async () => {
    const { f, read, pending } = await fixture();
    try {
      await expect(read(true)).resolves.toMatchObject({
        status: "running",
        timedOut: false,
        pendingQuestions: pending,
      });
    } finally {
      await stopFixture(f);
    }
  });

  it.each(["cli", "desktop"])(
    "lets %s answer after an explicit rejection of a CLI reply",
    async (entry) => {
      const { f, api, read, pending, first } = await fixture();
      try {
        const input = {
          threadId,
          interactionId: first.interactionId,
          result: { answer: "Markdown" },
        };
        const rejected = expect(api.answer(input)).rejects.toMatchObject({
          code: "DELEGATION_FAILED",
        });
        const native = await readJsonLine(f.official.stdin);
        writeRequest(f.official.stdout, {
          id: requiredMessageId(native),
          error: { code: -32600, message: "Explicitly rejected" },
        });
        await rejected;
        expect((await read()).pendingQuestions).toEqual(pending);
        const retried = entry === "cli" ? api.answer(input) : undefined;
        if (entry === "desktop") writeRequest(f.desktopInput, desktopReply(first));
        const retry = await readJsonLine(f.official.stdin);
        expect(retry.method).toBe("turn/steer");
        expect((retry.params as JsonObject).expectedTurnId).toBe(turnId);
        writeRequest(f.official.stdout, { id: requiredMessageId(retry), result: { turnId } });
        if (retried) await retried;
        else await f.collector.waitFor((m) => m.id === 900);
        expect((await read()).pendingQuestions).toEqual([pending[1]]);
      } finally {
        await stopFixture(f);
      }
    },
  );

  it.each([false, true])(
    "reserves Desktop replies and handles native rejection=%s",
    async (reject) => {
      const { f, api, read, pending, first, publish } = await fixture();
      try {
        const request = desktopReply(first);
        writeRequest(f.desktopInput, request);
        expect(await readJsonLine(f.official.stdin)).toEqual(request);
        await expect(
          api.answer({ threadId, interactionId: first.interactionId, result: { answer: "JSON" } }),
        ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
        writeRequest(f.official.stdout, {
          id: 900,
          ...(reject ? { error: { code: -32600, message: "Rejected" } } : { result: { turnId } }),
        });
        await f.collector.waitFor((m) => m.id === 900);
        await publish();
        expect((await read()).pendingQuestions).toEqual(reject ? pending : [pending[1]]);
        if (!reject) {
          // A later native follow-up is still a message, not a second CLI answer.
          const followUp = { ...request, id: 901 };
          writeRequest(f.desktopInput, followUp);
          expect(await readJsonLine(f.official.stdin)).toEqual(followUp);
          writeRequest(f.official.stdout, { id: 901, result: { turnId } });
          await f.collector.waitFor((m) => m.id === 901);
        }
      } finally {
        await stopFixture(f);
      }
    },
  );

  it("observes an accepted reply from another client without consuming its unanswered sibling", async () => {
    const { f, api, read, pending, first, publish } = await fixture();
    try {
      const input = (desktopReply(first).params as JsonObject).input;
      if (!input) throw new Error("Missing native reply input");
      writeRequest(f.official.stdout, {
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "userMessage", id: "native-reply", content: input },
        },
      });
      await f.collector.waitFor(
        (m) =>
          method(m, "item/completed") &&
          ((m.params as JsonObject).item as JsonObject).id === "native-reply",
      );
      await publish();
      expect((await read()).pendingQuestions).toEqual([pending[1]]);
      await expect(
        api.answer({ threadId, interactionId: first.interactionId, result: { answer: "JSON" } }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
    } finally {
      await stopFixture(f);
    }
  });

  it("cannot deliver a stale answer into a later Turn", async () => {
    const { f, api, first, publish } = await fixture();
    try {
      writeRequest(f.official.stdout, {
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } },
      });
      await f.collector.waitFor((m) => method(m, "turn/completed"));
      writeRequest(f.official.stdout, {
        method: "turn/started",
        params: { threadId, turn: { id: "next-turn", status: "inProgress" } },
      });
      await f.collector.waitFor(
        (m) =>
          method(m, "turn/started") &&
          ((m.params as JsonObject).turn as JsonObject).id === "next-turn",
      );
      await publish();
      await expect(
        api.answer({
          threadId,
          interactionId: first.interactionId,
          result: { answer: "JSON" },
        }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
      expect(f.official.stdin.read()).toBeNull();
    } finally {
      await stopFixture(f);
    }
  });
});
