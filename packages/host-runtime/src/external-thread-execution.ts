import type { HarnessSessionCapabilities, HostTurnId } from "@codexhost/shared-contracts";
import type { SessionActivityChangedEvent } from "@codexhost/harness-adapter";

type ExecutionCapabilities = Pick<HarnessSessionCapabilities, "nativeExecutionLifecycle">;

type SessionActivity = SessionActivityChangedEvent["activity"];

/** Owns execution facts; request admission and Session activity have distinct lifetimes. */
export class ExternalThreadExecution {
  #nativeLifecycle: boolean;
  #activeTurnId: HostTurnId | null = null;
  #pendingTurnId: HostTurnId | null = null;
  #activity: SessionActivity = "idle";
  #subagentRunning = false;

  constructor(capabilities: ExecutionCapabilities, subagentRunning = false) {
    this.#nativeLifecycle = capabilities.nativeExecutionLifecycle === true;
    this.#subagentRunning = subagentRunning;
  }

  get nativeLifecycle(): boolean {
    return this.#nativeLifecycle;
  }

  get activeTurnId(): HostTurnId | null {
    return this.#activeTurnId;
  }

  get pendingTurnId(): HostTurnId | null {
    return this.#pendingTurnId;
  }

  get running(): boolean {
    return (
      this.#activeTurnId !== null ||
      this.#pendingTurnId !== null ||
      this.#subagentRunning ||
      this.#activity !== "idle"
    );
  }

  get turnBusy(): boolean {
    return this.#nativeLifecycle
      ? this.#activeTurnId !== null || this.#pendingTurnId !== null
      : this.running;
  }

  requestStarted(turnId: HostTurnId): void {
    if (this.turnBusy) throw new Error("External Thread already has an active operation");
    if (this.#nativeLifecycle) this.#pendingTurnId = turnId;
    else this.#activeTurnId = turnId;
  }

  turnStarted(turnId: HostTurnId): void {
    if (this.#activeTurnId !== null && this.#activeTurnId !== turnId) {
      throw new Error("External execution started while another Turn is active");
    }
    if (this.#pendingTurnId === turnId) this.#pendingTurnId = null;
    this.#activeTurnId = turnId;
  }

  turnEnded(turnId: HostTurnId): void {
    if (this.#activeTurnId === turnId) this.#activeTurnId = null;
    if (this.#pendingTurnId === turnId) this.#pendingTurnId = null;
  }

  activityChanged(activity: SessionActivity): boolean {
    if (!this.#nativeLifecycle) return false;
    this.#activity = activity;
    return true;
  }

  sessionFaulted(): void {
    this.#activity = "idle";
  }

  subagentChanged(running: boolean): void {
    this.#subagentRunning = running;
  }

  clear(): void {
    this.#activeTurnId = null;
    this.#pendingTurnId = null;
    this.#activity = "idle";
    this.#subagentRunning = false;
  }

  sessionReplaced(capabilities: ExecutionCapabilities): void {
    this.clear();
    this.#nativeLifecycle = capabilities.nativeExecutionLifecycle === true;
  }
}
