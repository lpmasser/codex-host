import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it.runIf(process.platform !== "win32")(
  "rejects a FIFO root snapshot without blocking the calling thread",
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "wb-fifo-snapshot-"));
    try {
      const pkg = path.join(home, "cli");
      await mkdir(path.join(pkg, "bin"), { recursive: true });
      const cli = path.join(pkg, "bin", "codebuddy");
      await writeFile(cli, "#!/bin/sh\nexit 92\n", { mode: 0o755 });
      await writeFile(path.join(pkg, "product.json"), '{"dataFolderName":".workbuddy"}');
      const root = path.join(home, "data");
      const snapshot = path.join(root, "cache", "acc-product-config-v3.json");
      await mkdir(path.dirname(snapshot), { recursive: true });
      await run("mkfifo", ["-m", "600", snapshot]);
      const module = new URL("../src/command.ts", import.meta.url).href;
      const script = `
      import { workBuddyInvocation } from ${JSON.stringify(module)};
      console.log("ENTER_INVOCATION");
      try {
        workBuddyInvocation(${JSON.stringify({ HOME: home, WORKBUDDYCN_CONFIG_DIR: root, CODEXHOST_WORKBUDDYCN_COMMAND: cli })}, false, { distribution: "cn" });
        throw new Error("FIFO snapshot was accepted");
      } catch (error) {
        if (error.code !== "invalidRequest") throw error;
        console.log("REJECTED", error.code);
      }
    `;
      const result = await run(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { timeout: 2000 },
      );
      expect(result.stdout).toContain("ENTER_INVOCATION\nREJECTED invalidRequest");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
