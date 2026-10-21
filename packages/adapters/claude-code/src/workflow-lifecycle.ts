import type {
  HarnessError,
  HostEvent,
  HostItemOutcome,
  HostSubagentDelegationItem,
  HostSubagentState,
  HostSubagentStatus,
} from "@codexhost/harness-adapter";
import type { HostItemId, HostTurnId } from "@codexhost/shared-contracts";

import type { ClaudeTurnEvent, ClaudeWorkflowAgent } from "./transport.js";

type WorkflowEvent<T extends ClaudeTurnEvent["type"]> = Extract<ClaudeTurnEvent, { type: T }>;

interface WorkflowRun {
  callId: string;
  /** The Turn whose Root called the Workflow tool; the delegation Item belongs to it. */
  turnId: HostTurnId;
  name?: string;
  description?: string;
  taskId?: string;
  /** Opens with the first native task frame, which names the run. */
  item: HostSubagentDelegationItem | null;
  agents: Map<number, HostSubagentState>;
  /** The delegation Item stays open independently of its Root Turn. */
  detached: boolean;
}

export interface ClaudeWorkflowLifecycleOptions {
  newItemId(): HostItemId;
  emit(event: HostEvent): void;
}

export interface ClaudeWorkflowSettlement {
  callId: string;
  taskId?: string;
  /** Agents whose native transcript may have changed. */
  nativeSubagentIds: string[];
}

function workflowFailure(): HarnessError {
  return {
    code: "nativeFailure",
    message: "Claude Code Workflow failed",
    retryable: false,
  };
}

function agentStatus(state: ClaudeWorkflowAgent["state"]): HostSubagentStatus {
  switch (state) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "done":
      return "completed";
    case "error":
      return "failed";
  }
}

function agentSnapshot(
  callId: string,
  agent: ClaudeWorkflowAgent,
  previous: HostSubagentState | undefined,
): HostSubagentState {
  const nativeSubagentId = agent.agentId ?? previous?.nativeSubagentId;
  const role = agent.agentType ?? agent.phaseTitle ?? previous?.role;
  const model = agent.model ?? previous?.model;
  const resultSummary =
    agent.state === "error"
      ? (agent.error ?? agent.resultPreview)
      : agent.state === "done"
        ? agent.resultPreview
        : undefined;
  return {
    // Stable before Claude Code assigns the agent ID; the run calls agents by ordinal.
    subagentId: `${callId}:${agent.index}`,
    ...(nativeSubagentId ? { nativeSubagentId } : {}),
    description: agent.label,
    ...(role ? { role } : {}),
    ...(model ? { model } : {}),
    background: true,
    status: agentStatus(agent.state),
    ...(resultSummary ? { resultSummary } : {}),
  };
}

function sameAgent(left: HostSubagentState | undefined, right: HostSubagentState): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Projects native Workflow runs onto the common Subagent contract: one delegation Item per
 * run, one Subagent per workflow agent. A launched run stays open after the Workflow tool
 * returns, because its agents only appear while it runs in the background. The Session owns
 * runs: a run launched by an earlier Turn keeps reporting until its native task settles.
 */
export class ClaudeWorkflowLifecycle {
  readonly #emit: (event: HostEvent) => void;
  readonly #newItemId: () => HostItemId;
  readonly #runs = new Map<string, WorkflowRun>();

  constructor(options: ClaudeWorkflowLifecycleOptions) {
    this.#emit = options.emit;
    this.#newItemId = options.newItemId;
  }

  /** Runs whose Workflow tool has not returned yet. */
  get pendingCount(): number {
    let count = 0;
    for (const run of this.#runs.values()) if (!run.detached) count += 1;
    return count;
  }

  /** Native task IDs of the Turn's launched runs still open. */
  taskIds(turnId?: HostTurnId): string[] {
    return [...this.#runs.values()].flatMap((run) =>
      (turnId === undefined || run.turnId === turnId) && run.detached && run.taskId
        ? [run.taskId]
        : [],
    );
  }

  owner(callId: string): { turnId: HostTurnId; itemId: HostItemId } | undefined {
    const run = this.#runs.get(callId);
    return run?.item ? { turnId: run.turnId, itemId: run.item.itemId } : undefined;
  }

  isDetached(itemId: HostItemId): boolean {
    return [...this.#runs.values()].some((run) => run.item?.itemId === itemId && run.detached);
  }

  start(turnId: HostTurnId, event: WorkflowEvent<"workflow.started">): void {
    if (this.#runs.has(event.callId)) {
      throw new Error("Claude Code Workflow started more than once");
    }
    this.#runs.set(event.callId, {
      callId: event.callId,
      turnId,
      ...(event.name ? { name: event.name } : {}),
      item: null,
      agents: new Map(),
      detached: false,
    });
  }

  /** Returns agents whose state changed, so their transcripts can be refreshed. */
  update(event: WorkflowEvent<"workflow.updated">): string[] {
    const run = this.#runs.get(event.callId);
    if (!run) return [];
    if (event.taskId) run.taskId = event.taskId;
    if (event.description && !run.item) run.description = event.description;
    const changed: HostSubagentState[] = [];
    for (const agent of event.agents ?? []) {
      const previous = run.agents.get(agent.index);
      const next = agentSnapshot(run.callId, agent, previous);
      if (sameAgent(previous, next)) continue;
      run.agents.set(agent.index, next);
      changed.push(next);
    }
    if (!run.item) {
      this.#open(run);
    } else if (changed.length > 0) {
      this.#replaceSubagents(run);
    }
    return changed.flatMap((agent) => (agent.nativeSubagentId ? [agent.nativeSubagentId] : []));
  }

  /** Running agents of the run, whose transcripts an activity frame may have changed. */
  activity(callId: string): string[] {
    const run = this.#runs.get(callId);
    if (!run) return [];
    return [...run.agents.values()].flatMap((agent) =>
      agent.status === "running" && agent.nativeSubagentId ? [agent.nativeSubagentId] : [],
    );
  }

  /** Returns the launched run, or null when the tool result settled the Item. */
  launched(
    event: WorkflowEvent<"workflow.launched">,
    cancellationRequested: boolean,
  ): { callId: string; taskId?: string } | null {
    const run = this.#runs.get(event.callId);
    if (!run) return null;
    if (event.taskId) run.taskId = event.taskId;
    const item = run.item ?? this.#open(run);
    if (event.background && !event.isError) {
      run.detached = true;
      this.#emit({ type: "item.detached", turnId: run.turnId, itemId: item.itemId });
      return { callId: run.callId, ...(run.taskId ? { taskId: run.taskId } : {}) };
    }
    this.#complete(
      run,
      cancellationRequested
        ? { status: "cancelled", reason: "Cancelled by user" }
        : event.isError
          ? { status: "failed", error: workflowFailure() }
          : { status: "succeeded" },
    );
    return null;
  }

  /** Settles the run a native task notification names; null when it is not a Workflow run. */
  settle(event: WorkflowEvent<"subagent.settled">): ClaudeWorkflowSettlement | null {
    const run =
      (event.callId ? this.#runs.get(event.callId) : undefined) ??
      [...this.#runs.values()].find((candidate) => candidate.taskId === event.nativeSubagentId);
    if (!run) return null;
    const nativeSubagentIds = [...run.agents.values()].flatMap((agent) =>
      agent.nativeSubagentId ? [agent.nativeSubagentId] : [],
    );
    this.#complete(
      run,
      event.status === "completed"
        ? { status: "succeeded" }
        : event.status === "failed"
          ? { status: "failed", error: workflowFailure() }
          : { status: "cancelled", reason: "Workflow stopped" },
    );
    return {
      callId: run.callId,
      ...(run.taskId ? { taskId: run.taskId } : {}),
      nativeSubagentIds,
    };
  }

  /** Root completion only settles foreground calls; detached runs follow native task events. */
  finalize(turnId: HostTurnId, outcome: HostItemOutcome): void {
    for (const run of [...this.#runs.values()]) {
      if (run.turnId !== turnId || run.detached) continue;
      this.#complete(run, outcome);
    }
  }

  /** The native process that ran every open run ended, such as on Session close. */
  abandon(outcome: HostItemOutcome): void {
    for (const run of [...this.#runs.values()]) this.#complete(run, outcome);
  }

  #open(run: WorkflowRun): HostSubagentDelegationItem {
    const prompt = run.description ?? run.name;
    const item: HostSubagentDelegationItem = {
      type: "subagentDelegation",
      itemId: this.#newItemId(),
      operation: "spawn",
      ...(prompt ? { prompt } : {}),
      subagents: this.#orderedAgents(run),
    };
    run.item = item;
    this.#emit({ type: "item.started", turnId: run.turnId, item });
    return item;
  }

  #replaceSubagents(run: WorkflowRun): void {
    const item = run.item;
    if (!item) return;
    run.item = { ...item, subagents: this.#orderedAgents(run) };
    this.#emit({
      type: "item.updated",
      turnId: run.turnId,
      itemId: item.itemId,
      update: { type: "subagents.replace", subagents: run.item.subagents },
    });
  }

  #complete(run: WorkflowRun, outcome: HostItemOutcome): void {
    this.#runs.delete(run.callId);
    const item = run.item;
    if (!item) return;
    // Agents the last progress frame left unfinished end with the run; a queued agent that
    // never started did not run at all.
    const running: HostSubagentStatus =
      outcome.status === "succeeded"
        ? "completed"
        : outcome.status === "cancelled"
          ? "interrupted"
          : "failed";
    const subagents = this.#orderedAgents(run).map((agent) =>
      agent.status === "running"
        ? { ...agent, status: running }
        : agent.status === "pending"
          ? { ...agent, status: "interrupted" as const }
          : agent,
    );
    this.#emit({
      type: "item.completed",
      turnId: run.turnId,
      snapshot: { item: { ...item, subagents }, outcome },
    });
  }

  #orderedAgents(run: WorkflowRun): HostSubagentState[] {
    return [...run.agents.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, agent]) => agent);
  }
}
