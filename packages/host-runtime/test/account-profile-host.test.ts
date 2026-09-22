import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { type ExternalHarnessId, type JsonObject } from "@codexhost/protocol-core";
import {
  ACCOUNT_PROFILES_METHOD,
  encodeHarnessPluginRoute,
  harnessIdSchema,
  hostThreadIdSchema,
  type AccountProfileImportEntry,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppServerHost } from "../src/app-server-host.js";

const directories: string[] = [];

class FakeOfficialProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.stdout.end();
    this.emit("exit", null, signal);
    return true;
  });

  constructor() {
    super();
    this.stdin.once("finish", () => {
      this.stdout.end();
      this.emit("exit", 0, null);
    });
  }
}

class AccountProfileAdapter extends FakeHarnessAdapter {
  profileId: string | undefined = "profile-a";
  selectError: Error | undefined;
  selectCalls = 0;
  importJson = vi.fn<(content: string) => Promise<AccountProfileImportEntry[]>>(async () => [
    { label: "a@example.com", status: "imported" },
  ]);
  readonly openInputs: Parameters<FakeHarnessAdapter["open"]>[0][] = [];
  readonly accountProfiles = {
    select: async (): Promise<string | undefined> => {
      this.selectCalls += 1;
      if (this.selectError) throw this.selectError;
      return this.profileId;
    },
    importJson: (content: string): Promise<AccountProfileImportEntry[]> => this.importJson(content),
  };

  override async open(input: Parameters<FakeHarnessAdapter["open"]>[0]) {
    this.openInputs.push(input);
    return super.open(input);
  }
}

class JsonLineCollector {
  readonly messages: JsonObject[] = [];
  readonly #waiters: Array<{
    predicate: (message: JsonObject) => boolean;
    resolve(message: JsonObject): void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  #buffer = "";

  constructor(stream: PassThrough) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(this.#buffer.slice(0, newline)) as JsonObject;
        this.#buffer = this.#buffer.slice(newline + 1);
        this.messages.push(message);
        for (const waiter of this.#waiters.filter(({ predicate }) => predicate(message))) {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  waitFor(predicate: (message: JsonObject) => boolean): Promise<JsonObject> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<JsonObject>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new Error("Timed out waiting for Host output"));
        }, 2_000),
      };
      this.#waiters.push(waiter);
    });
  }
}

async function createFixture(adapters: ReadonlyMap<ExternalHarnessId, FakeHarnessAdapter>) {
  const directory = mkdtempSync(path.join(tmpdir(), "codexhost-account-profile-"));
  directories.push(directory);
  const desktopInput = new PassThrough();
  const desktopOutput = new PassThrough();
  const collector = new JsonLineCollector(desktopOutput);
  const official = new FakeOfficialProcess();
  const startup = Promise.withResolvers<undefined>();
  void startup.promise.catch(() => undefined);
  const mappingStore = new MappingStore({ directory });
  const host = new AppServerHost({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server"],
    defaultAgent: "codex",
    desktopInput,
    desktopOutput,
    diagnosticOutput: new PassThrough(),
    mappingStore,
    environment: { CODEXHOST_DATA_DIR: directory },
    externalAdapters: adapters,
    spawnOfficial: (() => {
      startup.resolve(undefined);
      return official as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as typeof spawn,
  });
  const running = host.run();
  void running.then(
    () => startup.reject(new Error("Host exited before fixture startup")),
    (error) => startup.reject(error),
  );
  return {
    collector,
    desktopInput,
    mappingStore,
    ready: startup.promise.then(
      () => new Promise<undefined>((resolve) => setImmediate(resolve, undefined)),
    ),
    running,
  };
}

function writeRequest(stream: PassThrough, value: JsonObject): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function call(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  id: number,
  method: string,
  params: JsonObject,
): Promise<JsonObject> {
  writeRequest(fixture.desktopInput, { id, method, params });
  return fixture.collector.waitFor((message) => message.id === id);
}

async function closeFixture(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  fixture.desktopInput.end();
  await fixture.running;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Harness account profile RPC", () => {
  it("reports capability and returns only Adapter import metadata", async () => {
    const adapter = new AccountProfileAdapter(harnessIdSchema.parse("antigravity"));
    const fixture = await createFixture(new Map([["antigravity", adapter]]));
    try {
      await fixture.ready;
      await expect(
        call(fixture, 1, ACCOUNT_PROFILES_METHOD, {
          action: "status",
          harnessId: "antigravity",
        }),
      ).resolves.toMatchObject({ result: { available: true, results: [] } });

      await expect(
        call(fixture, 2, ACCOUNT_PROFILES_METHOD, {
          action: "import",
          harnessId: "antigravity",
          content: '{"email":"a@example.com"}',
        }),
      ).resolves.toMatchObject({
        result: { available: true, results: [{ label: "a@example.com", status: "imported" }] },
      });
      expect(adapter.importJson).toHaveBeenCalledWith('{"email":"a@example.com"}');
    } finally {
      await closeFixture(fixture);
    }
  });

  it("reports no availability for an Adapter without the capability", async () => {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("antigravity"));
    const fixture = await createFixture(new Map([["antigravity", adapter]]));
    try {
      await fixture.ready;
      await expect(
        call(fixture, 1, ACCOUNT_PROFILES_METHOD, {
          action: "status",
          harnessId: "antigravity",
        }),
      ).resolves.toMatchObject({ result: { available: false, results: [] } });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("returns a fixed error without echoing import content or credentials", async () => {
    const adapter = new AccountProfileAdapter(harnessIdSchema.parse("antigravity"));
    adapter.importJson.mockRejectedValue(new Error("refresh_token=SECRET-TOKEN"));
    const fixture = await createFixture(new Map([["antigravity", adapter]]));
    try {
      await fixture.ready;
      const response = await call(fixture, 1, ACCOUNT_PROFILES_METHOD, {
        action: "import",
        harnessId: "antigravity",
        content: '{"refresh_token":"SECRET-TOKEN"}',
      });
      expect(response).toMatchObject({
        error: { code: -32077, message: "Account profile operation failed" },
      });
      expect(JSON.stringify(fixture.collector.messages)).not.toContain("SECRET-TOKEN");
    } finally {
      await closeFixture(fixture);
    }
  });

  it("persists the selected Profile before opening a Desktop-created Thread", async () => {
    const adapter = new AccountProfileAdapter(harnessIdSchema.parse("antigravity"));
    const fixture = await createFixture(new Map([["antigravity", adapter]]));
    try {
      await fixture.ready;
      const response = await call(fixture, 1, "thread/start", {
        model: encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("antigravity") }),
        cwd: "/synthetic",
      });
      const thread = (response.result as JsonObject).thread as JsonObject;
      expect(adapter.selectCalls).toBe(1);
      expect(adapter.openInputs[0]).toMatchObject({
        kind: "create",
        accountProfileId: "profile-a",
      });
      await expect(
        fixture.mappingStore.getThread(hostThreadIdSchema.parse(String(thread.id))),
      ).resolves.toMatchObject({ accountProfileId: "profile-a", state: "ready" });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("fails Desktop Thread creation when the Adapter cannot select a Profile", async () => {
    const adapter = new AccountProfileAdapter(harnessIdSchema.parse("antigravity"));
    adapter.selectError = new Error("profile index is unreadable");
    const fixture = await createFixture(new Map([["antigravity", adapter]]));
    try {
      await fixture.ready;
      const response = await call(fixture, 1, "thread/start", {
        model: encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("antigravity") }),
        cwd: "/synthetic",
      });
      expect(response).toMatchObject({ error: { code: -32076 } });
      expect(adapter.openInputs).toHaveLength(0);
      await expect(fixture.mappingStore.listThreads()).resolves.toHaveLength(0);
    } finally {
      await closeFixture(fixture);
    }
  });
});
