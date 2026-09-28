import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { MappingStore } from "../src/index.js";

const directories: string[] = [];
const harnessId = harnessIdSchema.parse("antigravity");
const accountProfileId = "profile-3f1c";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mapping-account-profile-"));
  directories.push(directory);
  const store = new MappingStore({ directory });
  await store.initialize();
  return { directory, store };
}

function provisionalInput(hostThreadId: string, createRequestId: string) {
  return {
    hostThreadId: hostThreadIdSchema.parse(hostThreadId),
    createRequestId,
    harnessId,
    cwd: "/synthetic",
    transportModelId: "codexhost/antigravity-native",
    ephemeral: false,
    historyMode: "paginated" as const,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Thread account Profile binding", () => {
  it("persists the binding across reload and keeps it on Ready", async () => {
    const { directory, store } = await fixture();
    await store.createProvisional({
      ...provisionalInput("thread-a", "request-a"),
      accountProfileId,
    });
    const ready = await store.commitReady({
      hostThreadId: hostThreadIdSchema.parse("thread-a"),
      nativeSessionRef: nativeSessionRefSchema.parse({
        harnessId,
        nativeSessionId: "session-a",
        formatVersion: 1,
      }),
    });
    expect(ready.accountProfileId).toBe(accountProfileId);
    await store.close();

    const reopened = new MappingStore({ directory });
    await reopened.initialize();
    try {
      await expect(reopened.getThread(hostThreadIdSchema.parse("thread-a"))).resolves.toMatchObject(
        {
          accountProfileId,
          state: "ready",
        },
      );
    } finally {
      await reopened.close();
    }
  });

  it("keeps the stored binding when a duplicate create request is retried", async () => {
    const { store } = await fixture();
    await store.createProvisional({
      ...provisionalInput("thread-a", "request-a"),
      accountProfileId,
    });
    const retried = await store.createProvisional({
      ...provisionalInput("thread-b", "request-a"),
      accountProfileId: "profile-other",
    });
    expect(retried.hostThreadId).toBe("thread-a");
    expect(retried.accountProfileId).toBe(accountProfileId);
  });

  it("loads a stored record that has no Profile binding", async () => {
    const { directory, store } = await fixture();
    await store.createProvisional(provisionalInput("legacy", "request-legacy"));
    await store.commitReady({
      hostThreadId: hostThreadIdSchema.parse("legacy"),
      nativeSessionRef: nativeSessionRefSchema.parse({
        harnessId,
        nativeSessionId: "session-legacy",
        formatVersion: 1,
      }),
    });
    await store.close();
    const stored = JSON.parse(
      await readFile(path.join(directory, "threads", "legacy.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("accountProfileId");

    const reopened = new MappingStore({ directory });
    await reopened.initialize();
    try {
      const record = await reopened.getThread(hostThreadIdSchema.parse("legacy"));
      expect(record?.accountProfileId).toBeUndefined();
    } finally {
      await reopened.close();
    }
  });
});
