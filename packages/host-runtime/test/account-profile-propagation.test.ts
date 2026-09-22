import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessAdapter, HostThreadSnapshot } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import type { ExternalHarnessId } from "@codexhost/protocol-core";
import { encodeExternalTransportSelection } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type AccountProfileImportEntry,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeExternalThreadFork } from "../src/external-thread-fork.js";
import { executeExternalThreadRollback } from "../src/external-thread-rollback.js";
import { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";
import { HarnessDelegationCoordinator } from "../src/harness-delegation-coordinator.js";
import { DELEGATION_THREAD_ID_ENV } from "../src/delegation-types.js";

const directories: string[] = [];
const harnessId = harnessIdSchema.parse("antigravity");
const accountProfileId = "profile-a";

function snapshot(sessionId: string, count: number): HostThreadSnapshot {
  return {
    turns: Array.from({ length: count }, (_, index) => ({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId,
        nativeSessionId: sessionId,
        nativeTurnKey: `turn-${index}`,
        formatVersion: 1,
      }),
      checkpoint: nativeCheckpointRefSchema.parse({
        harnessId,
        nativeSessionId: sessionId,
        checkpointId: `checkpoint-${index}`,
        formatVersion: 1,
      }),
      input: [{ type: "text", text: `prompt ${index}` }],
      items: [],
      outcome: { status: "succeeded" },
    })),
  };
}

class ProfileAdapter extends FakeHarnessAdapter {
  profileId: string | undefined = accountProfileId;
  selectCalls = 0;
  readonly openInputs: Parameters<FakeHarnessAdapter["open"]>[0][] = [];
  readonly accountProfiles = {
    select: async (): Promise<string | undefined> => {
      this.selectCalls += 1;
      return this.profileId;
    },
    importJson: async (): Promise<AccountProfileImportEntry[]> => [],
  };

  override async open(input: Parameters<FakeHarnessAdapter["open"]>[0]) {
    this.openInputs.push(input);
    return super.open(input);
  }
}

async function fixture(adapter: ProfileAdapter) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-account-profile-"));
  directories.push(directory);
  const store = new MappingStore({ directory });
  await store.initialize();
  const repository = new ExternalThreadRepository(store);
  const adapters = new Map<ExternalHarnessId, HarnessAdapter>([[adapter.harnessId, adapter]]);
  const runtime = new ExternalThreadRuntime({
    adapters,
    environment: {},
    repository,
    consumeOutputs: async () => undefined,
    diagnose: () => undefined,
  });
  const coordinator = new HarnessDelegationCoordinator({
    adapters,
    environment: {},
    externalRuntime: runtime,
    repository,
    registerExternalThread: (input) => runtime.register(input),
    startExternalTurn: async (thread, text, turnId) => {
      thread.running = true;
      thread.activeTurnId = hostTurnIdSchema.parse(turnId);
      const started = await thread.session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse(turnId),
        input: [{ type: "text", text }],
      });
      if (!started.ok) throw new Error(started.error.message);
    },
    notifyThreadStarted: async () => undefined,
    inspectOfficial: vi.fn(),
    readOfficial: vi.fn(),
    sendOfficial: vi.fn(),
    cancelOfficial: vi.fn(),
    startOfficial: vi.fn(),
    listOfficial: vi.fn(async () => ({ threads: [], nextCursor: null })),
    officialThreadCwd: async () => undefined,
    activeOfficialParents: () => [],
  });
  return { adapter, coordinator, repository, runtime, store };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("account Profile propagation", () => {
  it("selects, inspects, persists and opens a delegated Thread under one Profile", async () => {
    const adapter = new ProfileAdapter(harnessId);
    const value = await fixture(adapter);
    const inspect = vi.spyOn(adapter, "inspect");
    const model = adapter.catalog.defaultModel;
    if (!model) throw new Error("Fake catalog has no default Model");
    try {
      const result = await value.coordinator.start({
        harnessId: "antigravity",
        task: "review auth",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        model,
      });
      expect(adapter.selectCalls).toBe(1);
      expect(inspect).toHaveBeenCalledWith(
        expect.objectContaining({ accountProfileId, cwd: path.resolve("/synthetic") }),
      );
      expect(adapter.openInputs[0]).toMatchObject({ kind: "create", accountProfileId });
      await expect(value.repository.find(result.threadId)).resolves.toMatchObject({
        accountProfileId,
        state: "ready",
      });
      // The Fake Session refuses history reads during an active Turn; finish it before restoring.
      adapter.sessions[0]?.succeedTurn();
      value.runtime.clear();
      await expect(value.runtime.resolve(result.threadId)).resolves.toMatchObject({
        kind: "external",
      });
      expect(adapter.openInputs.at(-1)).toMatchObject({ kind: "resume", accountProfileId });
      expect(adapter.selectCalls).toBe(1);
    } finally {
      value.runtime.clear();
      await value.repository.close();
    }
  });

  it("resumes a stored legacy Thread without selecting a Profile", async () => {
    const adapter = new ProfileAdapter(harnessId);
    const value = await fixture(adapter);
    try {
      const created = await adapter.open({ kind: "create", cwd: "/synthetic" });
      if (!created.ok) throw new Error(created.error.message);
      const nativeRef = created.value.initialState.nativeRef;
      if (!nativeRef) throw new Error("Fake Adapter created no Native Session");
      const hostThreadId = hostThreadIdSchema.parse("legacy-thread");
      await value.repository.createProvisional({
        hostThreadId,
        createRequestId: "legacy-request",
        harnessId,
        cwd: "/synthetic",
        transportModelId: "codexhost/antigravity-native",
        ephemeral: false,
        historyMode: "paginated",
      });
      await value.repository.commitNative(hostThreadId, nativeRef);

      await expect(value.runtime.resolve(hostThreadId)).resolves.toMatchObject({
        kind: "external",
      });
      expect(adapter.openInputs.at(-1)).toMatchObject({ kind: "resume" });
      expect(adapter.openInputs.at(-1)).not.toHaveProperty("accountProfileId");
      expect(adapter.selectCalls).toBe(0);
    } finally {
      value.runtime.clear();
      await value.repository.close();
    }
  });

  it("inherits the source Profile on a derived Fork Thread", async () => {
    const adapter = new ProfileAdapter(harnessId);
    const value = await fixture(adapter);
    try {
      const sourceRef = nativeSessionRefSchema.parse({
        harnessId,
        nativeSessionId: "source-session",
        formatVersion: 1,
      });
      const history = snapshot(sourceRef.nativeSessionId, 2);
      await value.repository.createProvisional({
        hostThreadId: hostThreadIdSchema.parse("source"),
        createRequestId: "source-request",
        harnessId,
        accountProfileId,
        cwd: "/synthetic",
        transportModelId: "codexhost/antigravity-native",
        ephemeral: false,
        historyMode: "paginated",
      });
      const sourceRecord = await value.repository.commitNative(
        hostThreadIdSchema.parse("source"),
        sourceRef,
        history.turns.map((turn, index) => ({
          hostTurnId: hostTurnIdSchema.parse(`source-turn-${index}`),
          nativeTurnRef: turn.nativeTurnRef,
          nativeCheckpointRef: turn.checkpoint,
        })),
      );
      const source = value.runtime.register({
        record: sourceRecord,
        session: new FakeHarnessSession(
          harnessId,
          adapter.catalog,
          undefined,
          sourceRef,
          history,
          true,
          "/synthetic",
        ),
        sessionId: "source",
        thread: { id: "source" },
        turns: [],
      });
      const derivedRef = nativeSessionRefSchema.parse({
        harnessId,
        nativeSessionId: "derived-session",
        formatVersion: 1,
      });
      const open = vi.spyOn(adapter, "open").mockResolvedValue({
        ok: true,
        value: new FakeHarnessSession(
          harnessId,
          adapter.catalog,
          undefined,
          derivedRef,
          snapshot(derivedRef.nativeSessionId, 2),
          true,
          "/synthetic",
        ),
      });

      const result = await executeExternalThreadFork({
        source,
        fork: { threadId: "source", excludeTurns: false },
        adapters: new Map<ExternalHarnessId, HarnessAdapter>([[harnessId, adapter]]),
        repository: value.repository,
        runtime: value.runtime,
      });
      expect(result.ok).toBe(true);
      expect(open.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "fork", accountProfileId });
      if (!result.ok) throw new Error(result.error.message);
      await expect(value.repository.find(result.derived.id)).resolves.toMatchObject({
        accountProfileId,
      });
    } finally {
      value.runtime.clear();
      await value.repository.close();
    }
  });

  it("reopens a replaced Session under the current Thread's Profile on last-Turn rollback", async () => {
    const adapter = new ProfileAdapter(harnessId);
    const value = await fixture(adapter);
    try {
      const targetRef = nativeSessionRefSchema.parse({
        harnessId,
        nativeSessionId: "target-session",
        formatVersion: 1,
      });
      const history = snapshot(targetRef.nativeSessionId, 2);
      await value.repository.createProvisional({
        hostThreadId: hostThreadIdSchema.parse("target"),
        createRequestId: "target-request",
        harnessId,
        accountProfileId,
        cwd: "/synthetic",
        transportModelId: "codexhost/antigravity-native",
        ephemeral: false,
        historyMode: "paginated",
      });
      const targetRecord = await value.repository.commitNative(
        hostThreadIdSchema.parse("target"),
        targetRef,
        history.turns.map((turn, index) => ({
          hostTurnId: hostTurnIdSchema.parse(`target-turn-${index}`),
          nativeTurnRef: turn.nativeTurnRef,
          nativeCheckpointRef: turn.checkpoint,
        })),
      );
      const target = value.runtime.register({
        record: targetRecord,
        session: new FakeHarnessSession(
          harnessId,
          adapter.catalog,
          undefined,
          targetRef,
          history,
          true,
          "/synthetic",
          true,
          undefined,
          null,
          undefined,
          undefined,
          true,
        ),
        sessionId: "target",
        thread: { id: "target" },
        turns: [],
      });
      const replacementRef = nativeSessionRefSchema.parse({
        harnessId,
        nativeSessionId: "replacement-session",
        formatVersion: 1,
      });
      const open = vi.spyOn(adapter, "open").mockResolvedValue({
        ok: true,
        value: new FakeHarnessSession(
          harnessId,
          adapter.catalog,
          undefined,
          replacementRef,
          snapshot(replacementRef.nativeSessionId, 1),
        ),
      });

      const result = await executeExternalThreadRollback({
        derived: target,
        rollback: { threadId: "target", numTurns: 1 },
        adapters: new Map<ExternalHarnessId, HarnessAdapter>([[harnessId, adapter]]),
        repository: value.repository,
        runtime: value.runtime,
      });
      expect(result.ok).toBe(true);
      expect(open.mock.calls.at(-1)?.[0]).toMatchObject({
        kind: "rollbackLastTurn",
        accountProfileId,
      });
    } finally {
      value.runtime.clear();
      await value.repository.close();
    }
  });

  it("reuses a crashed attempt's provisional, Thread ID and Profile on retry", async () => {
    const adapter = new ProfileAdapter(harnessId);
    const value = await fixture(adapter);
    const inspect = vi.spyOn(adapter, "inspect");
    const model = adapter.catalog.defaultModel;
    if (!model) throw new Error("Fake catalog has no default Model");
    const requestId = "retry-after-crash";
    const crashedThreadId = hostThreadIdSchema.parse("crashed-thread");
    try {
      // A previous attempt persisted the provisional, then died before it could open.
      await value.repository.createProvisional({
        hostThreadId: crashedThreadId,
        createRequestId: `delegation:${requestId}`,
        harnessId,
        accountProfileId,
        cwd: "/synthetic",
        transportModelId: encodeExternalTransportSelection("antigravity", { model }),
        ephemeral: false,
        historyMode: "paginated",
      });
      // A fresh selection would hand out another Profile; the retry must not reach it.
      adapter.profileId = "profile-other";
      const createProvisional = vi.spyOn(value.repository, "createProvisional");

      const result = await value.coordinator.start({
        harnessId: "antigravity",
        task: "review auth",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        requestId,
        model,
      });

      expect(createProvisional).not.toHaveBeenCalled();
      expect(adapter.selectCalls).toBe(0);
      expect(inspect).toHaveBeenCalledWith(
        expect.objectContaining({ accountProfileId, cwd: path.resolve("/synthetic") }),
      );
      expect(adapter.openInputs).toHaveLength(1);
      expect(adapter.openInputs[0]).toMatchObject({ kind: "create", accountProfileId });
      expect(adapter.openInputs[0]?.environment?.[DELEGATION_THREAD_ID_ENV]).toBe(crashedThreadId);
      expect(result.threadId).toBe(crashedThreadId);
      const records = await value.repository.list();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        hostThreadId: crashedThreadId,
        accountProfileId,
        state: "ready",
      });
      await expect(value.repository.findDelegationByRequest(requestId)).resolves.toMatchObject({
        childHostThreadId: crashedThreadId,
      });
    } finally {
      value.runtime.clear();
      await value.repository.close();
    }
  });

  it("reuses a provisional with no Profile without polling for one", async () => {
    const adapter = new ProfileAdapter(harnessId);
    const value = await fixture(adapter);
    const requestId = "retry-legacy-provisional";
    try {
      await value.repository.createProvisional({
        hostThreadId: hostThreadIdSchema.parse("legacy-crashed-thread"),
        createRequestId: `delegation:${requestId}`,
        harnessId,
        cwd: "/synthetic",
        transportModelId: "codexhost/antigravity-native",
        ephemeral: false,
        historyMode: "paginated",
      });

      const result = await value.coordinator.start({
        harnessId: "antigravity",
        task: "review auth",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        requestId,
      });

      expect(adapter.selectCalls).toBe(0);
      expect(adapter.openInputs).toHaveLength(1);
      expect(adapter.openInputs[0]).toMatchObject({ kind: "create" });
      expect(adapter.openInputs[0]).not.toHaveProperty("accountProfileId");
      expect(result.threadId).toBe("legacy-crashed-thread");
      await expect(value.repository.find(result.threadId)).resolves.toMatchObject({
        hostThreadId: "legacy-crashed-thread",
      });
    } finally {
      value.runtime.clear();
      await value.repository.close();
    }
  });

  it("allocates once and opens once for concurrent starts sharing a Request ID", async () => {
    const adapter = new ProfileAdapter(harnessId);
    const value = await fixture(adapter);
    const model = adapter.catalog.defaultModel;
    if (!model) throw new Error("Fake catalog has no default Model");
    const input = {
      harnessId: "antigravity" as const,
      task: "review auth",
      cwd: "/synthetic",
      parentThreadId: "parent-thread",
      requestId: "concurrent-request",
      model,
    };
    try {
      const createProvisional = vi.spyOn(value.repository, "createProvisional");
      const [first, second] = await Promise.all([
        value.coordinator.start(input),
        value.coordinator.start(input),
      ]);
      expect(createProvisional).toHaveBeenCalledTimes(1);
      expect(adapter.selectCalls).toBe(1);
      expect(adapter.openInputs).toHaveLength(1);
      expect(adapter.openInputs[0]).toMatchObject({ kind: "create", accountProfileId });
      expect(second.threadId).toBe(first.threadId);
      expect(adapter.openInputs[0]?.environment?.[DELEGATION_THREAD_ID_ENV]).toBe(first.threadId);
      const records = await value.repository.list();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        hostThreadId: first.threadId,
        accountProfileId,
        state: "ready",
      });
    } finally {
      value.runtime.clear();
      await value.repository.close();
    }
  });

  it("rejects a concurrent Request ID reused for another Delegation configuration", async () => {
    const adapter = new ProfileAdapter(harnessId);
    const value = await fixture(adapter);
    const model = adapter.catalog.defaultModel;
    if (!model) throw new Error("Fake catalog has no default Model");
    try {
      const [first, second] = await Promise.allSettled([
        value.coordinator.start({
          harnessId: "antigravity",
          task: "review auth",
          cwd: "/synthetic",
          parentThreadId: "parent-thread",
          requestId: "conflicting-request",
          model,
        }),
        value.coordinator.start({
          harnessId: "antigravity",
          task: "different task",
          cwd: "/synthetic",
          parentThreadId: "parent-thread",
          requestId: "conflicting-request",
          model,
        }),
      ]);
      expect(first.status).toBe("fulfilled");
      expect(second.status).toBe("rejected");
      if (second.status !== "rejected") throw new Error("Second start unexpectedly succeeded");
      expect(second.reason).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(adapter.selectCalls).toBe(1);
      expect(adapter.openInputs).toHaveLength(1);
      expect(await value.repository.list()).toHaveLength(1);
    } finally {
      value.runtime.clear();
      await value.repository.close();
    }
  });

  it("binds a native Subagent child Thread to its parent's Profile", async () => {
    const adapter = new ProfileAdapter(harnessId);
    const value = await fixture(adapter);
    const parentRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "subagent-parent-session",
      formatVersion: 1,
    });
    try {
      await value.repository.createProvisional({
        hostThreadId: hostThreadIdSchema.parse("subagent-parent"),
        createRequestId: "subagent-parent-request",
        harnessId,
        accountProfileId,
        cwd: "/synthetic",
        transportModelId: "codexhost/antigravity-native",
        ephemeral: false,
        historyMode: "paginated",
      });
      const parent = await value.repository.commitNative(
        hostThreadIdSchema.parse("subagent-parent"),
        parentRef,
      );
      const child = await value.repository.materializeSubagent(parent, {
        subagentId: "native-child",
        nativeSubagentId: "native-child",
        description: "Native child",
        background: false,
        status: "running",
      });
      expect(child).toMatchObject({ accountProfileId, state: "ready" });
    } finally {
      value.runtime.clear();
      await value.repository.close();
    }
  });
});
