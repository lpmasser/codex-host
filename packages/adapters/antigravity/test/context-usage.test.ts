import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HarnessOutput,
  HarnessSession,
  HostEvent,
  HostUsage,
} from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { AntigravityAdapter, parseAntigravityContextUsage } from "../src/index.js";

/**
 * The fake Language Server answers over TLS, and the Adapter's client sets
 * `rejectUnauthorized: false`, so this throwaway self-signed localhost pair
 * carries no secret; it only spares the test lanes an openssl dependency.
 */
const FAKE_LS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCfX27q+8OKbfJW
KdDT0oob3yEJvZwKKSgJX6CRSitB8tUcs/PoE0xD/YbFaxD//6NsCDom7JHIOJFx
gaKkYkLo8S4i3Em9z31etg0RD3xgCuUyr8RnjjvHpFagY07ICuseVZTtUJSz/OH7
rdREEypJVRYfbeoA2goGilThCjzeC5u939vEiztDpsQ9DR1SbNXPbQ2KkwgwbSy+
x+GFtSm+VUcjz/gGo3S64j3Lxd6oNANlTy7SscOmDpPQh8g0DD8Sqk69Rj0Z9y4g
oTmbxuYIlvJ/K790+1WJQEPgAsMM8P83A8nnxG01nqFfA32AZti2PmC+R7pabWS9
Jy8heFYXAgMBAAECggEAOFv/VYoC9Ik9Ectn1gC2ZnTZsiAjdlRnnCj9F2QrN/8v
7h6VOpTYe5LEfjwGnwFAQYwHRIyUYUHf7UvywD8felEQB7PvP/iIVV378PSQ/0Xb
F7mgsx5RdaBgIgf8bDGwQ+Hv8Jx2edAL+nzWe9xrL9OvJx4vim2Q7g8tRQfhzoOt
WBruxIfchN3hQhTJoUHAkZLV4bKu4nf4rIM4l6DnRe+t3IHpWmZ90ofwYUMoBPk2
RRoigKFBekSGjGjb8P8Rsy4gJFU9ZkwAeo9+k599BHDjxLz7LGZxWKrAzSZD7W1C
dIyooG7kELRTtbyqSGA5u3RjSt6mYix+WLa20XYMwQKBgQDU9KAymxKrzqRN5/KL
hLZ6FOd6+bTbm1GTFIAaT1THpFAnN0mrh0csbQa+FuPiZNAPZ5n7kC5MHnLgn8Nu
0nNFiBIw5uRIYGUFOQCRQcDEFIj029RIEkczvrKPTHamKY9Fl6ldvNjFUtMORiJk
OGeCU0Bcp/1sz6NNUEZyOpPc0wKBgQC/litZSK4C0ABctNO/EbfAhNhg8Rf1vOK+
0XjxPmbB/jImarcwhpu6SWAbIZ+yHyVxDKMtfEOkeEEdTywABXxQYa6dDySyw4p8
QEKfTcMkpjnoMOXTts+6PA9pjbmyzoOSMNDHCpVcEj593cHnpsms24vFWsDgwMAD
CxZ4alRHLQKBgBTlmF6+5tsjIO5gJ2XXdQyPxpNDs6KlICEdruBmDny0vATNIRaK
5MoQPMwkdOI/YEdStEKCSHjBuCYgp03VqugUzSwtTBNqGh+kE1EtsZvMJBBbDf6w
hHooaV80cqQlieCbXExNfrwGP52z9iX9fvLD9pnhBjZKPc0VZoRJCT9vAoGAHcAz
ERVROEyWkc7ext/4eePnOf6WaumfCGS89DFtgZh4rzCJK/brPd1hGDV7eAyQIuME
f+65DlRCQEvoGETBzjWtCOSuHThyS+MqtVQ9BnbtrRnSxrKvxUrIVerVOGgLVGtS
MGZ7VSXcIG2MS+3BiZ86MDZslzo3VwGkxqQ0XC0CgYBBvPf8/9ZLf/+vsNqCDZYx
DFrYfO/Iy7xVz8M3wG1YvhwolvikJV0PCfx5EDcuuIyMZC2YcLx2N+Mx0dn7mdvU
jhaH58+j3xY040+IxQ4aAE20gC7U/xgekl/RQ4GrMT/aeVFgKBW2UsFR1Nc/4Acc
Q6cF+6u8pD4ORNMszbHu9A==
-----END PRIVATE KEY-----`;

const FAKE_LS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUDrQzs8Xjx7oQEYb1FVJ6ZU4sZKAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkzMDE1NDQ0MloXDTM2MDky
NzE1NDQ0MlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAn19u6vvDim3yVinQ09KKG98hCb2cCikoCV+gkUorQfLV
HLPz6BNMQ/2GxWsQ//+jbAg6JuyRyDiRcYGipGJC6PEuItxJvc99XrYNEQ98YArl
Mq/EZ447x6RWoGNOyArrHlWU7VCUs/zh+63URBMqSVUWH23qANoKBopU4Qo83gub
vd/bxIs7Q6bEPQ0dUmzVz20NipMIMG0svsfhhbUpvlVHI8/4BqN0uuI9y8XeqDQD
ZU8u0rHDpg6T0IfINAw/EqpOvUY9GfcuIKE5m8bmCJbyfyu/dPtViUBD4ALDDPD/
NwPJ58RtNZ6hXwN9gGbYtj5gvke6Wm1kvScvIXhWFwIDAQABo1MwUTAdBgNVHQ4E
FgQUs74BFrkuVPqs8eKROrd2rnYT7CkwHwYDVR0jBBgwFoAUs74BFrkuVPqs8eKR
Ord2rnYT7CkwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAYtNp
niaESOve/83IORTbzK80A4niLUnv/Ex4LZFmJy4jFMURs6PDn96DSnuoBTo8VyPv
vmsaGWrJsRvK9PtpU153R0JUuo70X5OMHpkIme3EbK3aEajYm/f40XsbsOhoccPP
XjnK0Cre4Nf7XdOQYZUAzRmLRWa2mN3W5xqGLLyGBOCQDyhF3am6T9hA+50jh+N/
d9z+2VpiIw/JiNePwmOxC0AFouAfc4bGq3i1ch5O1vwCWZhG/+ViuHJP0TGkkB+A
RJh+BvnH+2nNkBEDsIW5NhV2LXtd0oM+wdGOaTFImicqfHnz29+VKRE+POMxJRHg
tugAb6F0b8XuhFh+2Q==
-----END CERTIFICATE-----`;

interface CheckpointFixture {
  command: string;
  cwd: string;
  requestCount(): Promise<number>;
  cleanup(): Promise<void>;
}

interface FixtureOptions {
  lines: readonly string[];
  /** generatorMetadata entries the fake LS reports until the timeline rewrites them. */
  metadata: readonly unknown[];
  /** State rewrites applied before the given 1-based stream line is written. */
  timeline?: ReadonlyArray<{ beforeLine: number; metadata: unknown[] }>;
  /** Before writing the keyed line, wait until the mapped marker file exists. */
  waitBeforeLine?: Record<number, string>;
  responseDelayMs?: number;
  keepAlive?: boolean;
}

/**
 * Stand-in `agy` whose Language Server answers
 * GetCascadeTrajectoryGeneratorMetadata from a file the test rewrites
 * mid-Turn. Probe branches (`models`, `version`, `--print=…`) are handled
 * explicitly, and the log file is written only when `--log-file` was actually
 * passed — never argv[0].
 */
async function fakeAgyWithLanguageServer(options: FixtureOptions): Promise<CheckpointFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-usage-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-usage-cwd-"));
  const metadataPath = path.join(directory, "metadata.json");
  const requestsPath = path.join(directory, "ls-requests.txt");
  const streamPath = path.join(directory, "stream.json");
  const timelinePath = path.join(directory, "timeline.json");
  const waitPath = path.join(directory, "wait.json");
  const keyPath = path.join(directory, "ls-key.pem");
  const certPath = path.join(directory, "ls-cert.pem");
  const cleanup = async (): Promise<void> => {
    for (const target of [directory, cwd]) {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
  const script = `
const fs = require("node:fs");
const https = require("node:https");
const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
};

if (args.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
  process.exit(0);
}
if (args.includes("version") || args.includes("--version")) {
  process.stdout.write("1.2.14-fake\\n");
  process.exit(0);
}
if (args.some((argument) => argument.startsWith("--print="))) {
  process.stdout.write(JSON.stringify({ event: "command_result", command: { name: "usage", data: { groups: [] } } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: "conv-usage", status: "SUCCESS", num_turns: 0 } }) + "\\n");
  process.exit(0);
}

const stateFile = ${JSON.stringify(metadataPath)};
const requestsFile = ${JSON.stringify(requestsPath)};
const streamFile = ${JSON.stringify(streamPath)};
const timelineFile = ${JSON.stringify(timelinePath)};
const waitFile = ${JSON.stringify(waitPath)};
const keyFile = ${JSON.stringify(keyPath)};
const certFile = ${JSON.stringify(certPath)};
const responseDelayMs = ${options.responseDelayMs ?? 0};
const keepAlive = ${options.keepAlive === true};
let requestCount = 0;
let server = null;

function streamTurn() {
  const lines = JSON.parse(fs.readFileSync(streamFile, "utf8"));
  const timeline = JSON.parse(fs.readFileSync(timelineFile, "utf8"));
  const waitBeforeLine = JSON.parse(fs.readFileSync(waitFile, "utf8"));
  const byLine = new Map(timeline.map((entry) => [entry.beforeLine, entry]));
  const waitMarker = (marker) => new Promise((resolve) => {
    const check = () => (fs.existsSync(marker) ? resolve() : setTimeout(check, 5));
    check();
  });
  const run = async () => {
    let lineNumber = 0;
    for (const line of lines) {
      lineNumber += 1;
      const marker = waitBeforeLine[String(lineNumber)];
      if (marker) await waitMarker(marker);
      const scheduled = byLine.get(lineNumber);
      if (scheduled) fs.writeFileSync(stateFile, JSON.stringify(scheduled.metadata));
      process.stdout.write(line + "\\n");
    }
    if (keepAlive) {
      process.stdin.resume();
      process.stdin.on("end", () => process.exit(0));
    }
  };
  void run();
}

// The shim only ever writes to a --log-file value it actually received, so a
// probe invocation without one can never scribble over argv[0].
if (argValue("--log-file")) {
  server = https.createServer(
    { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) },
    (request, response) => {
      if (request.method !== "POST" || !(request.url ?? "").includes("GetCascadeTrajectoryGeneratorMetadata")) {
        response.writeHead(404);
        response.end();
        return;
      }
      request.resume();
      request.on("end", () => {
        requestCount += 1;
        fs.writeFileSync(requestsFile, String(requestCount));
        const respond = () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ trajectory: { generatorMetadata: JSON.parse(fs.readFileSync(stateFile, "utf8")) } }));
        };
        if (responseDelayMs > 0) setTimeout(respond, responseDelayMs);
        else respond();
      });
    },
  );
  server.unref();
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    fs.appendFileSync(argValue("--log-file"), "Language server listening on random port at " + port + " for HTTPS (gRPC)\\n");
    streamTurn();
  });
} else {
  streamTurn();
}
`;
  await writeFile(metadataPath, JSON.stringify(options.metadata));
  await writeFile(requestsPath, "0");
  await writeFile(streamPath, JSON.stringify(options.lines));
  await writeFile(timelinePath, JSON.stringify(options.timeline ?? []));
  await writeFile(waitPath, JSON.stringify(options.waitBeforeLine ?? {}));
  await writeFile(keyPath, FAKE_LS_KEY);
  await writeFile(certPath, FAKE_LS_CERT);
  const jsPath = path.join(directory, "agy.cjs");
  await writeFile(jsPath, script);
  let command: string;
  if (process.platform === "win32") {
    command = path.join(directory, "agy.cmd");
    await writeFile(command, `@node "${jsPath}" %*\r\n`);
  } else {
    command = path.join(directory, "agy");
    await writeFile(command, `#!/usr/bin/env node\n${script}`);
    await chmod(command, 0o755);
  }
  return {
    command,
    cwd,
    requestCount: async () => Number(await readFile(requestsPath, "utf8")),
    cleanup,
  };
}

const initEvent = (conversationId: string): string =>
  JSON.stringify({ event: "init", conversation_id: conversationId });

const agentStep = (conversationId: string, stepIndex: number, text: string): string =>
  JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: stepIndex,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: text,
    },
  });

const checkpointStep = (
  conversationId: string,
  stepIndex: number,
  state: "ACTIVE" | "DONE" | "ERROR",
): string =>
  JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: stepIndex,
      state,
      step_type: "checkpoint",
    },
  });

const resultEvent = (conversationId: string, usage?: Record<string, unknown>): string =>
  JSON.stringify({
    event: "result",
    result: {
      conversation_id: conversationId,
      status: "SUCCESS",
      num_turns: 1,
      response: "done",
      ...(usage ? { usage } : {}),
    },
  });

const metadataEntry = (usedTokens: number): unknown => ({
  chatModel: {
    chatStartMetadata: {
      contextWindowMetadata: { estimatedTokensUsed: usedTokens, maxContextTokens: 1_048_576 },
    },
  },
});

type UsageChanged = Extract<HostEvent, { type: "session.usage.changed" }> & {
  usage: HostUsage;
};
type ItemStarted = Extract<HostEvent, { type: "item.started" }>;
type ItemCompleted = Extract<HostEvent, { type: "item.completed" }>;

const isUsageEvent = (event: HostEvent): event is UsageChanged =>
  event.type === "session.usage.changed" && event.usage !== null;

const onTurnCompleted = (event: HostEvent): boolean => event.type === "turn.completed";

const startedCompactions = (events: HostEvent[]): ItemStarted[] =>
  events.filter(
    (event): event is ItemStarted =>
      event.type === "item.started" && event.item.type === "contextCompaction",
  );

const completedCompactions = (events: HostEvent[]): ItemCompleted[] =>
  events.filter(
    (event): event is ItemCompleted =>
      event.type === "item.completed" && event.snapshot.item.type === "contextCompaction",
  );

async function nextEvent(
  iterator: AsyncIterator<HarnessOutput>,
  description: string,
): Promise<HostEvent> {
  const result = await iterator.next();
  if (result.done) throw new Error(`Output stream ended while ${description}`);
  if (result.value.kind !== "event") throw new Error(`Expected an event while ${description}`);
  return result.value.event;
}

async function drainUntil(
  iterator: AsyncIterator<HarnessOutput>,
  predicate: (event: HostEvent) => boolean,
  description: string,
): Promise<HostEvent[]> {
  const collected: HostEvent[] = [];
  for (;;) {
    const event = await nextEvent(iterator, description);
    collected.push(event);
    if (predicate(event)) return collected;
  }
}

/**
 * Listens for the given window after a Turn ended and reports everything that
 * still arrived; the Session stays open, so silence is the assertion.
 */
async function eventsWithin(
  iterator: AsyncIterator<HarnessOutput>,
  windowMs: number,
): Promise<HostEvent[]> {
  const collected: HostEvent[] = [];
  const collector = (async () => {
    for (;;) {
      const result = await iterator.next();
      if (result.done) return;
      if (result.value.kind === "event") collected.push(result.value.event);
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  void collector.catch(() => undefined);
  return collected;
}

async function openSession(adapter: AntigravityAdapter, cwd: string): Promise<HarnessSession> {
  const opened = await adapter.open({ kind: "create", cwd });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

async function startTurn(session: HarnessSession): Promise<HostTurnId> {
  const turnId = hostTurnIdSchema.parse(`turn-${Math.random().toString(36).slice(2)}`);
  const executed = await session.execute({
    type: "turn.start",
    turnId,
    input: [{ type: "text", text: "run" }],
  });
  if (!executed.ok) throw new Error(executed.error.message);
  return turnId;
}

type HostTurnId = ReturnType<typeof hostTurnIdSchema.parse>;

async function withFixture(
  options: FixtureOptions,
  run: (fixture: CheckpointFixture, adapter: AntigravityAdapter) => Promise<void>,
): Promise<void> {
  const fixture = await fakeAgyWithLanguageServer(options);
  const adapter = new AntigravityAdapter({
    command: fixture.command,
    environment: { ...process.env, CODEXHOST_DATA_DIR: path.join(fixture.cwd, "host") },
  });
  try {
    await run(fixture, adapter);
  } finally {
    await adapter.close();
    await fixture.cleanup();
  }
}

describe("Antigravity checkpoint compaction and context usage", () => {
  it.each<{
    name: string;
    states: Array<"ACTIVE" | "DONE" | "ERROR">;
    outcome: Record<string, unknown>;
  }>([
    {
      name: "repeated ACTIVE/DONE updates",
      states: ["ACTIVE", "ACTIVE", "DONE", "DONE"],
      outcome: { status: "succeeded" },
    },
    { name: "DONE-only", states: ["DONE"], outcome: { status: "succeeded" } },
    {
      name: "ERROR with a successful native Turn",
      states: ["ACTIVE", "ERROR"],
      outcome: {
        status: "failed",
        error: { code: "nativeFailure", message: expect.stringContaining("compaction failed") },
      },
    },
  ])("settles one compaction lifecycle for $name", async ({ states, outcome }) => {
    await withFixture(
      {
        lines: [
          initEvent("conv-cmp"),
          ...states.map((state) => checkpointStep("conv-cmp", 7, state)),
          resultEvent("conv-cmp"),
        ],
        metadata: [metadataEntry(4_321)],
      },
      async (fixture, adapter) => {
        const session = await openSession(adapter, fixture.cwd);
        const iterator = session.outputs[Symbol.asyncIterator]();
        await startTurn(session);
        const events = await drainUntil(iterator, onTurnCompleted, "the compaction turn");
        const started = startedCompactions(events);
        const completed = completedCompactions(events);
        expect(started).toHaveLength(1);
        expect(completed).toHaveLength(1);
        expect(completed[0]?.snapshot).toMatchObject({ item: started[0]?.item, outcome });
        expect(events.findIndex((event) => event === started[0])).toBeLessThan(
          events.findIndex((event) => event === completed[0]),
        );
        expect(events.find(onTurnCompleted)).toMatchObject({ outcome: { status: "succeeded" } });
        await session.close();
      },
    );
  });

  it("settles the streaming agent message before the compaction Item starts", async () => {
    await withFixture(
      {
        lines: [
          initEvent("conv-settle"),
          agentStep("conv-settle", 1, "The context is getting long, compacting."),
          checkpointStep("conv-settle", 2, "ACTIVE"),
          checkpointStep("conv-settle", 2, "DONE"),
          resultEvent("conv-settle"),
        ],
        metadata: [metadataEntry(4_321)],
      },
      async (fixture, adapter) => {
        const session = await openSession(adapter, fixture.cwd);
        const iterator = session.outputs[Symbol.asyncIterator]();
        await startTurn(session);
        const events = await drainUntil(iterator, onTurnCompleted, "the settlement turn");
        const agentCompleted = events.findIndex(
          (event) => event.type === "item.completed" && event.snapshot.item.type === "agentMessage",
        );
        const compactionStarted = events.findIndex(
          (event) => event.type === "item.started" && event.item.type === "contextCompaction",
        );
        expect(agentCompleted).toBeGreaterThan(-1);
        expect(compactionStarted).toBeGreaterThan(agentCompleted);
        const agent = events[agentCompleted];
        if (agent?.type !== "item.completed") throw new Error("Agent completion vanished");
        expect(agent.snapshot.outcome.status).toBe("succeeded");
        await session.close();
      },
    );
  });

  it("refreshes the grown native context at the Turn end and never substitutes cumulative input", async () => {
    const marker = path.join(
      os.tmpdir(),
      `codexhost-agy-marker-${Math.random().toString(36).slice(2)}`,
    );
    await withFixture(
      {
        lines: [
          initEvent("conv-grow"),
          agentStep("conv-grow", 1, "working"),
          resultEvent("conv-grow", {
            input_tokens: 30_000,
            output_tokens: 500,
            total_tokens: 30_500,
          }),
        ],
        metadata: [metadataEntry(1_000)],
        timeline: [{ beforeLine: 3, metadata: [metadataEntry(1_000), metadataEntry(9_000)] }],
        waitBeforeLine: { 3: marker },
      },
      async (fixture, adapter) => {
        const session = await openSession(adapter, fixture.cwd);
        const iterator = session.outputs[Symbol.asyncIterator]();
        await startTurn(session);
        // The Turn baseline publishes once; only then does the stream continue
        // into the result, so the final refresh is a genuinely fresh query.
        await drainUntil(
          iterator,
          (event) => isUsageEvent(event) && event.usage.contextUsedTokens === 1_000,
          "the baseline context observation",
        );
        await writeFile(marker, "go");
        const events = await drainUntil(iterator, onTurnCompleted, "the growth turn");
        const usages = events
          .filter(isUsageEvent)
          .map((event) => event.usage)
          .filter((usage) => usage !== null);
        expect(usages.at(-1)).toMatchObject({
          inputTokens: 30_000,
          outputTokens: 500,
          totalTokens: 30_500,
          contextUsedTokens: 9_000,
          contextWindowTokens: 1_048_576,
        });
        for (const usage of usages) {
          expect(usage.contextUsedTokens).not.toBe(30_000);
        }
        // Bounded refreshes: the Turn baseline plus the Turn result, not one
        // request per stream step.
        expect(await fixture.requestCount()).toBe(2);
        await session.close();
      },
    );
    await rm(marker, { force: true });
  });

  it("keeps a request's prompt estimate as a fallback behind the Language Server reading", async () => {
    const beforeStep = path.join(os.tmpdir(), `agy-step-${Math.random().toString(36).slice(2)}`);
    const beforeResult = path.join(
      os.tmpdir(),
      `agy-result-${Math.random().toString(36).slice(2)}`,
    );
    await withFixture(
      {
        lines: [
          initEvent("conv-estimate"),
          JSON.stringify({
            event: "step_update",
            step_update: {
              conversation_id: "conv-estimate",
              step_index: 1,
              state: "ACTIVE",
              step_type: "agent_response",
              text_delta: "working",
              usage: { input_tokens: 20_000, cache_read_tokens: 5_000, output_tokens: 10 },
            },
          }),
          resultEvent("conv-estimate"),
        ],
        metadata: [metadataEntry(1_000)],
        timeline: [{ beforeLine: 3, metadata: [metadataEntry(1_000), metadataEntry(9_000)] }],
        waitBeforeLine: { 2: beforeStep, 3: beforeResult },
      },
      async (fixture, adapter) => {
        const session = await openSession(adapter, fixture.cwd);
        const iterator = session.outputs[Symbol.asyncIterator]();
        await startTurn(session);
        await drainUntil(
          iterator,
          (event) => isUsageEvent(event) && event.usage.contextUsedTokens === 1_000,
          "the baseline",
        );
        await writeFile(beforeStep, "go");
        const stepUsage = await drainUntil(
          iterator,
          (event) => isUsageEvent(event) && event.usage.inputTokens === 20_000,
          "the request usage",
        );
        // Billing counters still publish; the estimate does not replace the reading.
        expect(stepUsage.filter(isUsageEvent).at(-1)?.usage).toMatchObject({
          inputTokens: 20_000,
          outputTokens: 10,
          contextUsedTokens: 1_000,
        });
        await writeFile(beforeResult, "go");
        const events = await drainUntil(iterator, onTurnCompleted, "the estimate Turn");
        expect(events.filter(isUsageEvent).at(-1)?.usage.contextUsedTokens).toBe(9_000);
        await session.close();
      },
    );
    await rm(beforeStep, { force: true });
    await rm(beforeResult, { force: true });
  });

  it("refreshes native context after a completed generation without waiting for the Turn result", async () => {
    const beforeGeneration = path.join(
      os.tmpdir(),
      `agy-generation-${Math.random().toString(36).slice(2)}`,
    );
    const beforeResult = path.join(
      os.tmpdir(),
      `agy-result-${Math.random().toString(36).slice(2)}`,
    );
    await withFixture(
      {
        lines: [
          initEvent("conv-generation"),
          JSON.stringify({
            event: "step_update",
            step_update: {
              conversation_id: "conv-generation",
              step_index: 1,
              step_type: "agent_response",
              state: "DONE",
              text: "done",
            },
          }),
          resultEvent("conv-generation"),
        ],
        metadata: [metadataEntry(1_000)],
        timeline: [{ beforeLine: 2, metadata: [metadataEntry(1_000), metadataEntry(9_000)] }],
        waitBeforeLine: { 2: beforeGeneration, 3: beforeResult },
      },
      async (fixture, adapter) => {
        const session = await openSession(adapter, fixture.cwd);
        const iterator = session.outputs[Symbol.asyncIterator]();
        await startTurn(session);
        await drainUntil(
          iterator,
          (event) => isUsageEvent(event) && event.usage.contextUsedTokens === 1_000,
          "the baseline",
        );
        await writeFile(beforeGeneration, "go");
        await drainUntil(
          iterator,
          (event) => isUsageEvent(event) && event.usage.contextUsedTokens === 9_000,
          "the completed generation context",
        );
        await writeFile(beforeResult, "go");
        await drainUntil(iterator, onTurnCompleted, "the generation Turn");
        await session.close();
      },
    );
    await rm(beforeGeneration, { force: true });
    await rm(beforeResult, { force: true });
  });

  it("publishes the post-compaction context drop when the checkpoint completes", async () => {
    const preMarker = path.join(
      os.tmpdir(),
      `codexhost-agy-marker-${Math.random().toString(36).slice(2)}`,
    );
    const postMarker = path.join(
      os.tmpdir(),
      `codexhost-agy-marker-${Math.random().toString(36).slice(2)}`,
    );
    await withFixture(
      {
        lines: [
          initEvent("conv-drop"),
          agentStep("conv-drop", 1, "before compaction"),
          checkpointStep("conv-drop", 2, "ACTIVE"),
          checkpointStep("conv-drop", 2, "DONE"),
          resultEvent("conv-drop", {
            input_tokens: 30_000,
            output_tokens: 900,
            total_tokens: 30_900,
          }),
        ],
        metadata: [metadataEntry(9_000)],
        timeline: [{ beforeLine: 4, metadata: [metadataEntry(9_000), metadataEntry(1_200)] }],
        waitBeforeLine: { 4: preMarker, 5: postMarker },
      },
      async (fixture, adapter) => {
        const session = await openSession(adapter, fixture.cwd);
        const iterator = session.outputs[Symbol.asyncIterator]();
        await startTurn(session);
        // The pre-compaction baseline publishes first; only then may the
        // stream reach the checkpoint terminal state.
        const baselineEvents = await drainUntil(
          iterator,
          (event) => isUsageEvent(event) && event.usage.contextUsedTokens === 9_000,
          "the pre-compaction context observation",
        );
        await writeFile(preMarker, "go");
        const compactionEvents = await drainUntil(
          iterator,
          (event) => isUsageEvent(event) && event.usage.contextUsedTokens === 1_200,
          "the post-compaction context observation",
        );
        await writeFile(postMarker, "go");
        const events = [
          ...baselineEvents,
          ...compactionEvents,
          ...(await drainUntil(iterator, onTurnCompleted, "the compaction drop turn")),
        ];
        expect(startedCompactions(events)).toHaveLength(1);
        expect(completedCompactions(events)).toHaveLength(1);
        const usages = events
          .filter(isUsageEvent)
          .map((event) => event.usage)
          .filter((usage) => usage !== null);
        expect(usages.at(-1)).toMatchObject({
          inputTokens: 30_000,
          contextUsedTokens: 1_200,
          contextWindowTokens: 1_048_576,
        });
        for (const usage of usages) {
          expect(usage.contextUsedTokens).not.toBe(30_000);
        }
        await session.close();
      },
    );
    await rm(preMarker, { force: true });
    await rm(postMarker, { force: true });
  });

  it("closes an open compaction Item as cancelled and stays quiet after the Turn ends", async () => {
    await withFixture(
      {
        lines: [
          initEvent("conv-cancel-open"),
          agentStep("conv-cancel-open", 1, "compacting"),
          checkpointStep("conv-cancel-open", 5, "ACTIVE"),
        ],
        metadata: [metadataEntry(7_000)],
        responseDelayMs: 400,
        keepAlive: true,
      },
      async (fixture, adapter) => {
        const session = await openSession(adapter, fixture.cwd);
        const iterator = session.outputs[Symbol.asyncIterator]();
        const turnId = await startTurn(session);
        await drainUntil(
          iterator,
          (event) => event.type === "item.started" && event.item.type === "contextCompaction",
          "the open compaction Item",
        );
        expect(await session.execute({ type: "turn.cancel", turnId })).toMatchObject({ ok: true });
        const events = await drainUntil(iterator, onTurnCompleted, "the cancelled turn");
        expect(events.find(onTurnCompleted)).toMatchObject({
          outcome: { status: "cancelled" },
        });
        expect(completedCompactions(events).map(({ snapshot }) => snapshot.outcome.status)).toEqual(
          ["cancelled"],
        );
        // Nothing may publish after the Turn ended, not even the in-flight
        // Language Server request the baseline started.
        expect(await eventsWithin(iterator, 700)).toEqual([]);
        await session.close();
      },
    );
  });

  it("reuses the in-flight refresh instead of issuing stale duplicate requests", async () => {
    await withFixture(
      {
        lines: [initEvent("conv-cancel-refresh"), checkpointStep("conv-cancel-refresh", 3, "DONE")],
        metadata: [metadataEntry(7_000)],
        responseDelayMs: 400,
        keepAlive: true,
      },
      async (fixture, adapter) => {
        const session = await openSession(adapter, fixture.cwd);
        const iterator = session.outputs[Symbol.asyncIterator]();
        const turnId = await startTurn(session);
        const events = await drainUntil(
          iterator,
          (event) =>
            event.type === "item.completed" && event.snapshot.item.type === "contextCompaction",
          "the DONE-only compaction Item",
        );
        expect(events.at(-1)).toMatchObject({
          snapshot: { outcome: { status: "succeeded" } },
        });
        expect(await session.execute({ type: "turn.cancel", turnId })).toMatchObject({ ok: true });
        await drainUntil(iterator, onTurnCompleted, "the cancelled refresh turn");
        // The checkpoint's refresh trigger landed while the Turn baseline was
        // still in flight, so it must not have queued a second request.
        const requestsAtCancellation = await fixture.requestCount();
        expect(requestsAtCancellation).toBeLessThanOrEqual(1);
        expect(await eventsWithin(iterator, 700)).toEqual([]);
        expect(await fixture.requestCount()).toBe(requestsAtCancellation);
        await session.close();
      },
    );
  });

  it("reads the latest valid generator metadata entry instead of the first", () => {
    const payload = (entries: unknown[]) => ({ trajectory: { generatorMetadata: entries } });
    const entry = (usedTokens: number): unknown => ({
      chatModel: {
        chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: usedTokens } },
      },
    });
    expect(parseAntigravityContextUsage(payload([entry(1_000), entry(9_000)]))).toEqual({
      contextUsedTokens: 9_000,
      contextWindowTokens: 1_048_576,
    });
    // Invalid entries never shadow the latest valid one, in either position.
    expect(parseAntigravityContextUsage(payload([entry(1_000), { broken: true }]))).toEqual({
      contextUsedTokens: 1_000,
      contextWindowTokens: 1_048_576,
    });
    expect(parseAntigravityContextUsage(payload([{ broken: true }, entry(9_000)]))).toEqual({
      contextUsedTokens: 9_000,
      contextWindowTokens: 1_048_576,
    });
    expect(parseAntigravityContextUsage({ generatorMetadata: [] })).toBeNull();
  });
});
