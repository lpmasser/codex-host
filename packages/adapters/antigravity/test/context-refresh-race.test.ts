import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostEvent, HostUsage } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import type * as ContextUsageModule from "../src/context-usage.js";

import { pollAntigravityContextUsage } from "../src/context-usage.js";
import { AntigravityAdapter } from "../src/index.js";

vi.mock("../src/context-usage.js", async (original) => ({
  ...(await original<typeof ContextUsageModule>()),
  pollAntigravityContextUsage: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Antigravity context refresh ordering", () => {
  it("discards an in-flight pre-compaction sample and coalesces the final fresh observation", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-context-race-"));
    const initial = deferred<Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens">>();
    const started = deferred<undefined>();
    const compacted = deferred<undefined>();
    const source = vi.mocked(pollAntigravityContextUsage);
    source.mockReset();
    source.mockImplementationOnce(() => {
      started.resolve(undefined);
      return initial.promise;
    });
    source.mockResolvedValue({ contextUsedTokens: 9000, contextWindowTokens: 1048576 });
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const signal = path.join(home, "finish-turn");
    const events = [
      {
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          step_type: "checkpoint",
          state: "DONE",
        },
      },
      {
        event: "result",
        result: {
          conversation_id: conversationId,
          status: "SUCCESS",
          num_turns: 1,
          usage: { input_tokens: 30000, output_tokens: 3 },
        },
      },
    ];
    const script = `
const fs=require('node:fs');
if(process.argv.includes('models')){process.stdout.write('gemini-3.8-flash\\tGemini 3.8 Flash\\n');process.exit(0);}
if(process.argv.includes('--version')){process.stdout.write('1.2.14\\n');process.exit(0);}
if(process.argv.some(arg=>arg.startsWith('--print=')))process.exit(0);
const logAt=process.argv.indexOf('--log-file');if(logAt<0 || !process.argv[logAt+1])process.exit(2);
fs.writeFileSync(process.argv[logAt+1],'isolated context source');
const emit=event=>process.stdout.write(JSON.stringify(event)+'\\n');
emit({event:'init',conversation_id:${JSON.stringify(conversationId)}});
const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(signal)}))return;clearInterval(timer);for(const event of ${JSON.stringify(events)})emit(event);},5);
`;
    const js = path.join(home, "agy.cjs");
    const command = path.join(home, process.platform === "win32" ? "agy.cmd" : "agy");
    await writeFile(js, script);
    await writeFile(
      command,
      process.platform === "win32"
        ? `@"${process.execPath}" "${js}" %*\r\n`
        : `#!${process.execPath}\n${script}`,
    );
    await chmod(command, 0o755);
    const adapter = new AntigravityAdapter({
      command,
      environment: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        GEMINI_HOME: path.join(home, ".gemini"),
        CODEXHOST_DATA_DIR: path.join(home, "host"),
        CODEXHOST_THREAD_ID: "context-race-thread",
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: home });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const observed: HostEvent[] = [];
    try {
      const reader = (async () => {
        for await (const output of session.outputs) {
          if (output.kind !== "event") continue;
          const event = output.event;
          observed.push(event);
          if (event.type === "item.completed" && event.snapshot.item.type === "contextCompaction")
            compacted.resolve(undefined);
          if (event.type === "turn.completed") return;
        }
      })();
      const accepted = await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("context-race-turn"),
        input: [{ type: "text", text: "Fixture Turn" }],
      });
      expect(accepted.ok).toBe(true);
      await started.promise;
      await writeFile(signal, "continue");
      await compacted.promise;
      initial.resolve({ contextUsedTokens: 1000, contextWindowTokens: 1048576 });
      await reader;
      const usage = observed
        .filter((event) => event.type === "session.usage.changed")
        .map((event) => event.usage);
      expect(usage.at(-1)).toMatchObject({ inputTokens: 30000, contextUsedTokens: 9000 });
      expect(usage.some((value) => value?.contextUsedTokens === 1000)).toBe(false);
      // Baseline, checkpoint and final result can require at most one sample
      // each; a checkpoint sample that finishes before result is already fresh.
      expect(source.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(source.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      initial.resolve({ contextUsedTokens: 1000, contextWindowTokens: 1048576 });
      await session.close();
      await rm(home, { recursive: true, force: true });
      source.mockReset();
    }
  });
});
