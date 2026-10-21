import { describe, expect, it } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { ExternalThreadExecution } from "../src/external-thread-execution.js";

const a = hostTurnIdSchema.parse("a");
const b = hostTurnIdSchema.parse("b");
const native = () => new ExternalThreadExecution({ nativeExecutionLifecycle: true });
const state = (execution: ExternalThreadExecution) => ({
  active: execution.activeTurnId,
  pending: execution.pendingTurnId,
  running: execution.running,
  busy: execution.turnBusy,
});
const idle = { active: null, pending: null, running: false, busy: false };

describe("External Thread execution facts", () => {
  it.each([{}, { nativeExecutionLifecycle: false }])(
    "keeps legacy acceptance when native lifecycle is not enabled: %j",
    (capabilities) => {
      const execution = new ExternalThreadExecution(capabilities);
      expect(execution.activityChanged("running")).toBe(false);
      expect(state(execution)).toEqual(idle);
      execution.requestStarted(a);
      expect(state(execution)).toEqual({ active: a, pending: null, running: true, busy: true });
      execution.activityChanged("idle");
      execution.turnStarted(a);
      execution.activityChanged("requires_action");
      expect(execution.activeTurnId).toBe(a);
      execution.turnEnded(a);
      expect(state(execution)).toEqual(idle);
    },
  );

  it("keeps pending input separate from a preceding autonomous execution", () => {
    const execution = native();
    execution.requestStarted(b);
    expect(state(execution)).toEqual({ active: null, pending: b, running: true, busy: true });
    execution.turnStarted(a);
    expect(state(execution)).toEqual({ active: a, pending: b, running: true, busy: true });
    execution.turnEnded(a);
    expect(state(execution)).toEqual({ active: null, pending: b, running: true, busy: true });
    execution.turnStarted(b);
    expect(state(execution)).toEqual({ active: b, pending: null, running: true, busy: true });
    execution.turnEnded(b);
    expect(state(execution)).toEqual(idle);
  });

  it.each(["idle-first", "result-first"])(
    "settles activity and execution independently: %s",
    (order) => {
      const execution = native();
      execution.requestStarted(a);
      execution.activityChanged("running");
      execution.turnStarted(a);
      if (order === "idle-first") {
        execution.activityChanged("idle");
        expect(execution.running).toBe(true);
        expect(execution.turnBusy).toBe(true);
        execution.turnEnded(a);
      } else {
        execution.turnEnded(a);
        expect(execution.running).toBe(true);
        expect(execution.turnBusy).toBe(false);
        execution.activityChanged("idle");
      }
      expect(state(execution)).toEqual(idle);
    },
  );

  it("accepts another request while only native Session activity remains", () => {
    const execution = native();
    execution.activityChanged("requires_action");
    expect(execution.running).toBe(true);
    expect(execution.turnBusy).toBe(false);
    execution.requestStarted(a);
    execution.turnEnded(a);
    expect(state(execution)).toEqual({ ...idle, running: true });
    execution.sessionFaulted();
    expect(state(execution)).toEqual(idle);
  });

  it("rejects or cancels a pending request without changing the preceding execution", () => {
    const execution = native();
    execution.requestStarted(b);
    execution.turnStarted(a);
    execution.turnEnded(b);
    expect(state(execution)).toEqual({ active: a, pending: null, running: true, busy: true });
    execution.turnEnded(a);
    execution.requestStarted(b);
    execution.turnEnded(b);
    expect(state(execution)).toEqual(idle);
  });

  it("does not let an old terminal clear a later execution", () => {
    const execution = native();
    execution.turnStarted(a);
    execution.turnEnded(a);
    execution.turnStarted(b);
    execution.turnEnded(a);
    expect(execution.activeTurnId).toBe(b);
    expect(execution.running).toBe(true);
  });

  it("rejects overlapping requests and executions but accepts the matching start", () => {
    const execution = native();
    execution.requestStarted(a);
    expect(() => execution.requestStarted(b)).toThrow("active operation");
    execution.turnStarted(a);
    expect(() => execution.turnStarted(a)).not.toThrow();
    expect(() => execution.turnStarted(b)).toThrow("another Turn");
  });

  it("retains accepted execution ownership until its terminal after a Session fault", () => {
    const execution = native();
    execution.requestStarted(a);
    execution.activityChanged("running");
    execution.sessionFaulted();
    expect(execution.pendingTurnId).toBe(a);
    expect(execution.running).toBe(true);
    execution.turnEnded(a);
    expect(state(execution)).toEqual(idle);
  });

  it("clears execution and read-only subagent activity on release and re-reads capabilities on restore", () => {
    const execution = new ExternalThreadExecution({}, true);
    expect(execution.running).toBe(true);
    execution.subagentChanged(false);
    expect(state(execution)).toEqual(idle);
    execution.sessionReplaced({ nativeExecutionLifecycle: true });
    execution.activityChanged("running");
    execution.requestStarted(a);
    execution.clear();
    expect(state(execution)).toEqual(idle);
    execution.sessionReplaced({});
    execution.activityChanged("running");
    execution.requestStarted(b);
    expect(state(execution)).toEqual({ active: b, pending: null, running: true, busy: true });
  });
});
