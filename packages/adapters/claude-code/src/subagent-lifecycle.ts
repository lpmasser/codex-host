import type {
  HarnessError,
  HostEvent,
  HostItemOutcome,
  HostSubagentDelegationItem,
  HostSubagentState,
} from "@codexhost/harness-adapter";
import type { HostItemId, HostTurnId } from "@codexhost/shared-contracts";

import type { ClaudeTurnEvent } from "./transport.js";

interface ActiveSubagentDelegation {
  turnId: HostTurnId;
  item: HostSubagentDelegationItem;
  detached: boolean;
}

export interface ClaudeSubagentLifecycleOptions {
  newItemId(): HostItemId;
  emit(event: HostEvent): void;
}

function subagentFailure(): HarnessError {
  return {
    code: "nativeFailure",
    message: "Claude Code Subagent delegation failed",
    retryable: false,
  };
}

export class ClaudeSubagentLifecycle {
  readonly #emit: (event: HostEvent) => void;
  readonly #newItemId: () => HostItemId;
  readonly #delegations = new Map<string, ActiveSubagentDelegation>();

  constructor(options: ClaudeSubagentLifecycleOptions) {
    this.#emit = options.emit;
    this.#newItemId = options.newItemId;
  }

  pendingCount(turnId: HostTurnId): number {
    return [...this.#delegations.values()].filter(
      (delegation) => delegation.turnId === turnId && !delegation.detached,
    ).length;
  }

  owner(callId: string): { turnId: HostTurnId; itemId: HostItemId } | undefined {
    const delegation = this.#delegations.get(callId);
    return delegation ? { turnId: delegation.turnId, itemId: delegation.item.itemId } : undefined;
  }

  isDetached(itemId: HostItemId): boolean {
    return [...this.#delegations.values()].some(
      (entry) => entry.item.itemId === itemId && entry.detached,
    );
  }

  taskIds(turnId?: HostTurnId): string[] {
    return [...this.#delegations.values()].flatMap((delegation) => {
      const id = delegation.item.subagents[0]?.nativeSubagentId;
      return delegation.detached && id && (turnId === undefined || delegation.turnId === turnId)
        ? [id]
        : [];
    });
  }

  nativeSubagentId(callId: string): string | undefined {
    return this.#delegations.get(callId)?.item.subagents[0]?.nativeSubagentId;
  }

  start(turnId: HostTurnId, event: Extract<ClaudeTurnEvent, { type: "subagent.started" }>): void {
    if (this.#delegations.has(event.callId)) {
      throw new Error("Claude Code Subagent delegation started more than once");
    }
    const subagent: HostSubagentState = {
      subagentId: event.nativeSubagentId ?? event.callId,
      ...(event.nativeSubagentId ? { nativeSubagentId: event.nativeSubagentId } : {}),
      description: event.description,
      ...(event.role ? { role: event.role } : {}),
      background: event.background,
      status: "running",
    };
    const item: HostSubagentDelegationItem = {
      type: "subagentDelegation",
      itemId: this.#newItemId(),
      operation: event.operation,
      ...(event.prompt ? { prompt: event.prompt } : {}),
      subagents: [subagent],
    };
    this.#delegations.set(event.callId, { turnId, item, detached: false });
    this.#emit({ type: "item.started", turnId, item });
  }

  update(event: Extract<ClaudeTurnEvent, { type: "subagent.updated" }>): void {
    const active = this.#delegations.get(event.callId);
    if (!active) return;
    const current = active.item.subagents[0];
    if (!current) throw new Error("Claude Code Subagent delegation has no Agent state");
    const subagent: HostSubagentState = {
      ...current,
      status: event.status,
      ...(event.nativeSubagentId ? { nativeSubagentId: event.nativeSubagentId } : {}),
      ...(event.description ? { description: event.description } : {}),
      ...(event.role ? { role: event.role } : {}),
      ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
    };
    active.item = { ...active.item, subagents: [subagent] };
    this.#emit({
      type: "item.updated",
      turnId: active.turnId,
      itemId: active.item.itemId,
      update: { type: "subagents.replace", subagents: active.item.subagents },
    });
  }

  complete(
    event: Extract<ClaudeTurnEvent, { type: "subagent.completed" }>,
    cancellationRequested: boolean,
  ): HostSubagentState {
    const active = this.#delegations.get(event.callId);
    if (!active)
      throw new Error("Claude Code Subagent completion references an unknown delegation");
    const turnId = active.turnId;
    const current = active.item.subagents[0];
    if (!current) throw new Error("Claude Code Subagent delegation has no Agent state");
    const background = event.continuesInBackground && !event.isError;
    const status = background
      ? "running"
      : cancellationRequested
        ? "interrupted"
        : event.isError
          ? "failed"
          : "completed";
    const subagent: HostSubagentState = {
      ...current,
      status,
      ...(event.nativeSubagentId ? { nativeSubagentId: event.nativeSubagentId } : {}),
      ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
    };
    const item = { ...active.item, subagents: [subagent] };
    active.item = item;
    this.#emit({
      type: "item.updated",
      turnId,
      itemId: item.itemId,
      update: { type: "subagents.replace", subagents: item.subagents },
    });
    const outcome: HostItemOutcome = cancellationRequested
      ? { status: "cancelled", reason: "Cancelled by user" }
      : event.isError
        ? { status: "failed", error: subagentFailure() }
        : { status: "succeeded" };
    if (background) {
      active.detached = true;
      this.#emit({ type: "item.detached", turnId, itemId: item.itemId });
      return subagent;
    }
    this.#delegations.delete(event.callId);
    this.#emit({ type: "item.completed", turnId, snapshot: { item, outcome } });
    return subagent;
  }

  finalize(turnId: HostTurnId, outcome: HostItemOutcome): void {
    for (const [callId, active] of this.#delegations) {
      if (active.turnId !== turnId || active.detached) continue;
      this.#delegations.delete(callId);
      const current = active.item.subagents[0];
      if (!current) continue;
      const status =
        outcome.status === "succeeded"
          ? current.status
          : outcome.status === "cancelled"
            ? "interrupted"
            : "failed";
      const item = { ...active.item, subagents: [{ ...current, status }] };
      this.#emit({ type: "item.completed", turnId, snapshot: { item, outcome } });
    }
  }

  settle(event: Extract<ClaudeTurnEvent, { type: "subagent.settled" }>): boolean {
    const matched = [...this.#delegations].filter(
      ([callId, delegation]) =>
        delegation.detached &&
        (callId === event.callId ||
          (event.nativeSubagentId !== undefined &&
            delegation.item.subagents[0]?.nativeSubagentId === event.nativeSubagentId)),
    );
    if (matched.length === 0) return false;
    const outcome: HostItemOutcome =
      event.status === "completed"
        ? { status: "succeeded" }
        : event.status === "failed"
          ? { status: "failed", error: subagentFailure() }
          : { status: "cancelled", reason: "Background Agent stopped" };
    for (const [callId, entry] of matched) {
      this.#delegations.delete(callId);
      const subagents = entry.item.subagents.map((agent) => ({
        ...agent,
        status: event.status,
        ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
      }));
      this.#emit({
        type: "item.completed",
        turnId: entry.turnId,
        snapshot: { item: { ...entry.item, subagents }, outcome },
      });
    }
    return true;
  }

  abandon(outcome: HostItemOutcome): void {
    for (const delegation of this.#delegations.values()) delegation.detached = false;
    for (const turnId of new Set([...this.#delegations.values()].map((entry) => entry.turnId))) {
      this.finalize(turnId, outcome);
    }
  }
}
