import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue, RoutedHarnessId } from "@codexhost/protocol-core";

import { DelegationControlError } from "./delegation-types.js";
import type {
  DelegationPendingQuestion,
  ThreadAnswerInput,
  ThreadAnswerResult,
} from "./delegation-types.js";

/** The protocol owner has an explicit rejection, rather than unknown delivery. */
export class QuestionReplyRejected extends DelegationControlError {
  constructor(message: string) {
    super("DELEGATION_FAILED", message);
  }
}

interface QuestionRequest {
  requestId: string | number;
  threadId: string;
  turnId: string;
  harnessId: RoutedHarnessId;
  kind?: DelegationPendingQuestion["kind"];
  /** Native question data; its protocol owner interprets and validates replies. */
  request: JsonObject;
  nativeInteractionId?: string;
  expiresAt?: string;
  validate?(reply: JsonObject): void;
  respond(reply: JsonObject): Promise<void>;
  retire?(): void;
}

interface PendingQuestion extends QuestionRequest {
  interactionId: string;
  timer?: NodeJS.Timeout;
  state?: "claimed" | "answered";
}

/** One pending request shared by Desktop and delegation; reply semantics stay with its owner. */
export class QuestionInteractions {
  readonly #pending = new Map<string | number, PendingQuestion>();
  readonly #identityPrefix = randomUUID();
  #nextIdentity = 0;

  constructor(
    readonly effects: {
      run<T>(threadId: string, operation: () => Promise<T>): Promise<T>;
      resolved(threadId: string, requestId: string | number): Promise<void>;
      diagnose(error: unknown): void;
    },
  ) {}

  register(request: QuestionRequest): void {
    // Async items may appear in both started and completed notifications. Keep
    // their settled identity until the Turn closes, so replay cannot reopen it.
    if (this.#pending.has(request.requestId)) return;
    const pending: PendingQuestion = {
      ...request,
      interactionId: `${this.#identityPrefix}:${++this.#nextIdentity}`,
    };
    this.#pending.set(request.requestId, pending);
    const deadline = Date.parse(request.expiresAt ?? "");
    if (Number.isFinite(deadline)) {
      pending.timer = setTimeout(
        () => void this.#expire(pending),
        Math.max(0, deadline - Date.now()),
      );
    }
  }

  read(threadId: string): DelegationPendingQuestion[] {
    return [...this.#pending.values()]
      .filter((request) => request.threadId === threadId && !request.state)
      .map(({ interactionId, turnId, expiresAt, request, kind }) => ({
        interactionId,
        kind: kind ?? "requestUserInput",
        turnId,
        ...(expiresAt ? { expiresAt } : {}),
        request,
      }));
  }

  async answer(input: ThreadAnswerInput): Promise<ThreadAnswerResult> {
    if (typeof input.threadId !== "string" || !input.threadId.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
    }
    if (typeof input.interactionId !== "string" || !input.interactionId.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Interaction identifier is required");
    }
    const request = [...this.#pending.values()].find(
      ({ interactionId }) => interactionId === input.interactionId,
    );
    if (!request || request.state) throw this.#notPending();
    if (request.threadId !== input.threadId) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Question belongs to another Thread");
    }
    if (input.result === undefined) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Question reply result is required");
    }
    await this.effects.run(request.threadId, () =>
      this.#send(request, { result: input.result }, true),
    );
    return {
      threadId: request.threadId,
      turnId: request.turnId,
      interactionId: request.interactionId,
      harnessId: request.harnessId,
      status: "running",
      next: {
        read: `codexhost thread read ${request.threadId}`,
        wait: `codexhost thread wait ${request.threadId} --timeout-ms 30000`,
      },
    };
  }

  /** Clients sharing Threads must also dismiss the request answered by another client. */
  async handleDesktopResponse(value: JsonValue, sharedClients: boolean): Promise<boolean> {
    if (!value || typeof value !== "object" || Array.isArray(value) || "method" in value)
      return false;
    if (typeof value.id !== "string" && typeof value.id !== "number") return false;
    const request = this.#pending.get(value.id);
    if (!request || request.kind === "requestUserInputAsync") return false;
    try {
      await this.effects.run(request.threadId, () => this.#send(request, value, sharedClients));
    } catch (error) {
      this.effects.diagnose(error);
    }
    return true;
  }

  async closeWhere(matches: (request: QuestionRequest) => boolean): Promise<void> {
    await Promise.all(
      [...this.#pending.values()].filter(matches).map((request) => this.close(request.requestId)),
    );
  }

  async close(requestId: string | number, notify = true): Promise<void> {
    const request = this.#pending.get(requestId);
    if (!request) return;
    this.#pending.delete(requestId);
    if (request.timer) clearTimeout(request.timer);
    if (request.state) return;
    await this.#retire(request, notify);
  }

  /** Reserve a native Desktop submission before it can race a CLI answer. */
  claimAsync(requestIds: string[]): ((accepted: boolean) => void) | undefined {
    const requests = [...new Set(requestIds)]
      .map((id) => this.#pending.get(id))
      .filter(
        (request): request is PendingQuestion =>
          request?.kind === "requestUserInputAsync" && request.state !== "answered",
      );
    if (!requests.length) return undefined;
    if (requests.some((request) => request.state)) throw this.#notPending();
    for (const request of requests) this.#take(request);
    // Only an explicit native rejection releases the reservation. Unknown
    // delivery and accepted user-message events must not invite a second send.
    return (accepted) => {
      for (const request of requests) this.#settleAsync(request, accepted);
    };
  }

  #settleAsync(request: PendingQuestion, accepted: boolean): void {
    if (this.#pending.get(request.requestId) !== request || request.state !== "claimed") return;
    if (accepted) request.state = "answered";
    else delete request.state;
  }

  observeAsyncAnswer(requestId: string): void {
    const request = this.#pending.get(requestId);
    if (request?.kind === "requestUserInputAsync") request.state = "answered";
  }

  #take(request: PendingQuestion): void {
    if (this.#pending.get(request.requestId) !== request || request.state) throw this.#notPending();
    if (request.kind === "requestUserInputAsync") request.state = "claimed";
    else this.#pending.delete(request.requestId);
    if (request.timer) clearTimeout(request.timer);
  }

  async #retire(request: PendingQuestion, notify: boolean): Promise<void> {
    request.retire?.();
    if (notify && request.kind !== "requestUserInputAsync")
      await this.effects.resolved(request.threadId, request.requestId).catch(this.effects.diagnose);
  }

  async #send(request: PendingQuestion, reply: JsonObject, notify: boolean): Promise<void> {
    if (Date.parse(request.expiresAt ?? "") <= Date.now()) {
      await this.#expire(request);
      throw this.#notPending();
    }
    request.validate?.(reply);
    // Claim before calling the existing reply handler; failures cannot invite a duplicate send.
    this.#take(request);
    try {
      await request.respond(reply);
      this.#settleAsync(request, true);
    } catch (error) {
      if (error instanceof QuestionReplyRejected && request.kind === "requestUserInputAsync")
        this.#settleAsync(request, false);
      throw error;
    } finally {
      // An explicitly rejected async reply still belongs to both input surfaces.
      if (request.kind !== "requestUserInputAsync" || request.state)
        await this.#retire(request, notify);
    }
  }

  async #expire(request: PendingQuestion): Promise<void> {
    if (this.#pending.get(request.requestId) !== request) return;
    this.#take(request);
    // Keep the existing Desktop expiry order: dismiss first, then cancel at the source.
    await this.effects.resolved(request.threadId, request.requestId).catch(this.effects.diagnose);
    try {
      await this.effects.run(request.threadId, () => request.respond({ result: { answers: {} } }));
    } catch (error) {
      this.effects.diagnose(error);
    } finally {
      request.retire?.();
    }
  }

  #notPending(): DelegationControlError {
    return new DelegationControlError(
      "QUESTION_NOT_PENDING",
      "Question is no longer pending or is being answered",
    );
  }
}
