import type { JsonObject, JsonRpcRequest, JsonValue } from "@codexhost/protocol-core";
import { DelegationControlError } from "./delegation-types.js";
import { QuestionReplyRejected, type QuestionInteractions } from "./question-interactions.js";

const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Codex Desktop 26.1016 identifies each agentMessage.questions entry this way.
function requestId(threadId: string, turnId: string, questionItemId: string): string {
  return JSON.stringify([threadId, turnId, questionItemId]);
}

function replies(input: unknown): JsonObject[] {
  if (!Array.isArray(input) || input.length !== 1) return [];
  const entry: unknown = input[0];
  if (!object(entry) || entry.type !== "text" || typeof entry.text !== "string") return [];
  const text = entry.text.trim();
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return [];
  try {
    const decoded: unknown = JSON.parse(text.slice(OPEN.length, -CLOSE.length));
    const values: unknown[] = Array.isArray(decoded) ? decoded : [decoded];
    return values.length &&
      values.every(
        (value) =>
          object(value) &&
          typeof value.questionItemId === "string" &&
          typeof value.question === "string" &&
          typeof value.answer === "string",
      )
      ? (values as JsonObject[])
      : [];
  } catch {
    return [];
  }
}

function answer(reply: JsonObject): string {
  if (
    !object(reply.result) ||
    typeof reply.result.answer !== "string" ||
    !reply.result.answer.trim()
  )
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "Async Question requires a non-empty answer",
    );
  return reply.result.answer;
}

/** Native async wire semantics. QuestionInteractions owns all pending/claimed identities. */
export class CodexAsyncQuestions {
  readonly #desktopReplies = new Map<string | number, (accepted: boolean) => void>();

  constructor(
    readonly effects: {
      questions: QuestionInteractions;
      activeTurn(threadId: string): string | undefined;
      request(method: string, params: JsonObject): Promise<JsonObject>;
    },
  ) {}

  observe(value: JsonValue): void {
    if (!object(value)) return;
    if ((typeof value.id === "string" || typeof value.id === "number") && !("method" in value)) {
      const settle = this.#desktopReplies.get(value.id);
      this.#desktopReplies.delete(value.id);
      settle?.(!value.error);
      return;
    }
    if (value.method !== "item/started" && value.method !== "item/completed") return;
    const params = value.params;
    if (!object(params) || typeof params.threadId !== "string" || typeof params.turnId !== "string")
      return;
    const { threadId, turnId } = params;
    if (this.effects.activeTurn(threadId) !== turnId || !object(params.item)) return;
    const item = params.item;
    if (
      item.type === "userMessage" ||
      (item.type === "steeringUserMessage" && item.status === "accepted")
    ) {
      for (const reply of replies(item.type === "userMessage" ? item.content : item.input))
        this.effects.questions.observeAsyncAnswer(
          requestId(threadId, turnId, reply.questionItemId as string),
        );
    }
    if (
      item.type !== "agentMessage" ||
      typeof item.id !== "string" ||
      !Array.isArray(item.questions)
    )
      return;
    const itemId = item.id;
    item.questions.forEach((question, index) => {
      if (
        !object(question) ||
        typeof question.title !== "string" ||
        !question.title.trim() ||
        (question.options != null &&
          (!Array.isArray(question.options) ||
            question.options.some((option) => typeof option !== "string")))
      )
        return;
      const title = question.title;
      const questionItemId = JSON.stringify(["request_user_input_async", itemId, index]);
      this.effects.questions.register({
        kind: "requestUserInputAsync",
        requestId: requestId(threadId, turnId, questionItemId),
        threadId,
        turnId,
        harnessId: "codex",
        request: { ...question, threadId, turnId, itemId, questionItemId },
        validate: (reply) => {
          answer(reply);
        },
        respond: async (reply) => {
          if (this.effects.activeTurn(threadId) !== turnId)
            throw new DelegationControlError(
              "QUESTION_NOT_PENDING",
              "Question Turn is no longer active",
            );
          const text = `${OPEN}\n${JSON.stringify([{ questionItemId, question: title, answer: answer(reply) }])}\n${CLOSE}`;
          const response = await this.effects.request("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: [{ type: "text", text }],
          });
          if (object(response.error))
            throw new QuestionReplyRejected(
              typeof response.error.message === "string"
                ? response.error.message
                : "Native Question answer was rejected",
            );
          if (!object(response.result) || response.result.turnId !== turnId)
            throw new Error("Native Question answer returned no matching Turn identity");
        },
      });
    });
  }

  /** Observe the native Desktop reply without changing its params or transport. */
  claimDesktop(request: JsonRpcRequest): void {
    if (request.method !== "turn/steer" && request.method !== "turn/start") return;
    const params = request.params;
    if (!object(params) || typeof params.threadId !== "string") return;
    const turnId = this.effects.activeTurn(params.threadId);
    if (!turnId || (params.expectedTurnId != null && params.expectedTurnId !== turnId)) return;
    const restore = this.effects.questions.claimAsync(
      replies(params.input).map((reply) =>
        requestId(params.threadId as string, turnId, reply.questionItemId as string),
      ),
    );
    if (restore) this.#desktopReplies.set(request.id, restore);
  }

  clear(): void {
    this.#desktopReplies.clear();
  }

  forgetDesktopReply(id: string | number): void {
    this.#desktopReplies.delete(id);
  }
}
