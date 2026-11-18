import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessAdapter as createGlobalAdapter } from "@codexhost/adapter-workbuddy/plugin";
import { WorkBuddyAdapter } from "@codexhost/adapter-workbuddy";
import { createHarnessAdapter as createChinaAdapter } from "../src/plugin.js";

const homes: string[] = [];
const adapters: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(release: "global" | "cn", foreign: boolean) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "wb-data-consumers-")));
  homes.push(home);
  const root = path.join(home, "data");
  const cwd = path.join(home, "project");
  await mkdir(cwd);
  const folder = (edition: "global" | "cn") => (edition === "cn" ? ".workbuddy" : ".workbuddy-ai");
  const snapshot = path.join(root, "cache", "acc-product-config-v3.json");
  await mkdir(path.dirname(snapshot), { recursive: true, mode: 0o700 });
  await writeFile(
    snapshot,
    JSON.stringify({
      dataFolderName: folder(foreign ? (release === "cn" ? "global" : "cn") : release),
    }),
    { mode: 0o600 },
  );
  const slug = cwd
    .replace(/[/\\:]/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-+/gu, "-");
  const file = path.join(root, "projects", slug, "foreign-session.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  const rows = [
    {
      id: "u",
      type: "message",
      role: "user",
      sessionId: "foreign-session",
      cwd,
      content: "HISTORY-MARKER",
      timestamp: 1000,
    },
    {
      id: "a",
      parentId: "u",
      type: "message",
      role: "assistant",
      sessionId: "foreign-session",
      cwd,
      content: "OK",
      status: "completed",
      timestamp: 2000,
      providerData: {
        messageId: "foreign-request",
        model: "foreign-model",
        rawUsage: { prompt_tokens: 11, completion_tokens: 3 },
      },
    },
  ];
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const adapter = (release === "cn" ? createChinaAdapter : createGlobalAdapter)({
    environment: {
      HOME: home,
      [release === "cn" ? "WORKBUDDYCN_CONFIG_DIR" : "WORKBUDDY_CONFIG_DIR"]: root,
    },
    platform: process.platform,
    managedRemoteHost: false,
  });
  adapters.push(adapter);
  if (!(adapter instanceof WorkBuddyAdapter))
    throw new Error("Expected the local WorkBuddy Adapter");
  return { adapter, file };
}

describe.each(["global", "cn"] as const)("%s data consumer root identity", (release) => {
  it("rejects import listing before exposing foreign candidates", async () => {
    const { adapter } = await fixture(release, true);
    expect(await adapter.sessionImport.listCandidates()).toMatchObject({ ok: false });
  });

  it("rejects import resolution before assigning a foreign Native Ref", async () => {
    const { adapter } = await fixture(release, true);
    expect(await adapter.sessionImport.resolveCandidate("foreign-session")).toMatchObject({
      ok: false,
    });
  });

  it("rejects usage source enumeration from a foreign root", async () => {
    const { adapter } = await fixture(release, true);
    await expect(
      adapter.usageStatistics.listSources(new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalidRequest" });
  });

  it("rejects usage reads without a preceding source enumeration", async () => {
    const { adapter, file } = await fixture(release, true);
    await expect(
      adapter.usageStatistics.readSource(file, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalidRequest" });
  });

  it("rejects a persisted usage source outside the selected root", async () => {
    const { adapter } = await fixture(release, false);
    const { file } = await fixture(release, true);
    await expect(
      adapter.usageStatistics.readSource(file, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalidRequest" });
  });

  it("imports and meters its own root through the real plugin factory", async () => {
    const { adapter, file } = await fixture(release, false);
    expect(await adapter.sessionImport.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "foreign-session", title: "HISTORY-MARKER" }],
    });
    expect(await adapter.sessionImport.resolveCandidate("foreign-session")).toMatchObject({
      ok: true,
      value: { nativeRef: { harnessId: release === "cn" ? "workbuddy-cn" : "workbuddy" } },
    });
    const signal = new AbortController().signal;
    expect(await adapter.usageStatistics.listSources(signal)).toMatchObject([{ id: file }]);
    expect(await adapter.usageStatistics.readSource(file, signal)).toMatchObject([
      { id: "foreign-request", model: "foreign-model", inputTokens: 11, outputTokens: 3 },
    ]);
  });
});
