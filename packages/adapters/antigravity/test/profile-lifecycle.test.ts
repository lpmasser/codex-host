import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { HarnessSession } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { AntigravityAdapter } from "../src/antigravity-adapter.js";
import { AntigravityAccountProfiles } from "../src/account-profiles.js";
import * as quotaModule from "../src/quota.js";

it("discards a default-account quota response when profiles were imported during its request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-profile-quota-"));
  const home = path.join(root, "home");
  await mkdir(home);
  const environment = { HOME: home, CODEXHOST_DATA_DIR: path.join(root, "host") };
  const entered = Promise.withResolvers<undefined>();
  const response = Promise.withResolvers<quotaModule.AntigravityQuotaSnapshot | null>();
  const fetchQuota = vi.spyOn(quotaModule, "fetchAntigravityQuota").mockImplementation(() => {
    entered.resolve(undefined);
    return response.promise;
  });
  const adapter = new AntigravityAdapter({ environment, command: process.execPath });
  try {
    const pending = adapter.inspectAccount();
    await entered.promise;
    const profiles = new AntigravityAccountProfiles({
      environment,
      authenticate: async ({ email }) => ({ email, serialized: "synthetic" }),
    });
    await profiles.importJson(
      JSON.stringify([{ email: "a@example.com", refresh_token: "synthetic" }]),
    );
    response.resolve({
      label: "default account",
      usedPercent: 25,
      periodType: "five_hour",
      fetchedAt: new Date().toISOString(),
    });
    expect(await pending).toBeNull();
    expect(adapter.credits()).toBeNull();
  } finally {
    response.resolve(null);
    fetchQuota.mockRestore();
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "pins native processes and resumed conversations to the saved profile",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agy-profile-lifecycle-"));
    const home = path.join(root, "home");
    await mkdir(home);
    const log = path.join(root, "invocations.jsonl");
    const environment = {
      ...process.env,
      HOME: home,
      GEMINI_HOME: path.join(root, "wrong-inherited-home"),
      CODEXHOST_DATA_DIR: path.join(root, "host"),
      PROFILE_TEST_LOG: log,
    };
    const profiles = new AntigravityAccountProfiles({
      environment,
      authenticate: async ({ email }) => ({
        email,
        serialized: "SYNTHETIC CREDENTIAL; never sent to a real CLI",
      }),
    });
    await profiles.importJson(
      JSON.stringify(
        ["a@example.com", "b@example.com"].map((email) => ({ email, refresh_token: "synthetic" })),
      ),
    );
    const ids = [(await profiles.select()) as string, (await profiles.select()) as string];
    const command = path.join(root, "agy");
    await writeFile(
      command,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.PROFILE_TEST_LOG, JSON.stringify({home:process.env.HOME,gemini:process.env.GEMINI_HOME,sshClient:process.env.SSH_CLIENT,args:process.argv.slice(2)})+"\\n");
if(process.argv.includes("models")){console.log("gemini-3.7-flash-high\\tGemini 3.7 Flash High");process.exit(0);}
const index=process.argv.indexOf("--conversation");
const id=index<0?path.basename(process.env.HOME):process.argv[index+1];
process.stdin.once("data",()=>{
 console.log(JSON.stringify({event:"init",init:{permission_mode:"dangerously-skip-permissions"},conversation_id:id}));
 console.log(JSON.stringify({event:"result",result:{conversation_id:id,status:"SUCCESS",num_turns:1,response:"fixture"}}));
});
process.stdin.on("end",()=>process.exit(0));
`,
    );
    await chmod(command, 0o755);
    const adapter = new AntigravityAdapter({ environment, command });
    async function turn(session: HarnessSession) {
      const output = session.outputs[Symbol.asyncIterator]();
      const completed = (async () => {
        for (;;) {
          const next = await output.next();
          if (next.done) throw new Error("No completion event");
          if (next.value.kind === "event" && next.value.event.type === "turn.completed")
            return next.value.event;
        }
      })();
      const accepted = await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse(randomUUID()),
        input: [{ type: "text", text: "fixture" }],
      });
      expect(accepted.ok).toBe(true);
      expect(await completed).toMatchObject({ outcome: { status: "succeeded" } });
    }
    try {
      const remote = new AntigravityAdapter({ environment, command, managedRemoteHost: true });
      expect(remote.accountProfiles).toBeUndefined();
      await remote.close();
      expect((await adapter.inspect()).status).toBe("ready");
      expect(await adapter.accountProfiles?.select()).toBe(ids[0]);
      for (const id of ids) {
        const opened = await adapter.open({ kind: "create", cwd: root, accountProfileId: id });
        if (!opened.ok) throw new Error(opened.error.message);
        await turn(opened.value);
        await opened.value.close();
      }
      expect(await adapter.inspectAccount()).toBeNull();
      await adapter.close();
      const restarted = new AntigravityAdapter({ environment, command });
      try {
        const resumed = await restarted.open({
          kind: "resume",
          cwd: root,
          accountProfileId: ids[0] as string,
          nativeRef: nativeSessionRefSchema.parse({
            formatVersion: 1,
            harnessId: "antigravity",
            nativeSessionId: ids[0],
          }),
        });
        if (!resumed.ok) throw new Error(resumed.error.message);
        await turn(resumed.value);
        await resumed.value.close();
        const invocations = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(new Set(invocations.map((i) => path.basename(i.home)))).toEqual(new Set(ids));
        expect(invocations.every((i) => i.gemini === path.join(i.home, ".gemini"))).toBe(true);
        expect(invocations.every((i) => i.sshClient === "127.0.0.1 0 0")).toBe(true);
        const resumedCall = invocations.find((i) => i.args.includes("--conversation"));
        expect(path.basename(resumedCall.home)).toBe(ids[0]);
        expect(resumedCall.args[resumedCall.args.indexOf("--conversation") + 1]).toBe(ids[0]);
        await rm(path.join(root, "host", "antigravity-profiles", ids[0] as string), {
          recursive: true,
        });
        expect(
          (await restarted.open({ kind: "create", cwd: root, accountProfileId: ids[0] as string }))
            .ok,
        ).toBe(false);
      } finally {
        await restarted.close();
      }
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
