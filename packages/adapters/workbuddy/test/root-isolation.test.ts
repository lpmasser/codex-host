import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workBuddyInvocation } from "../src/command.js";
import { WORKBUDDY_DISTRIBUTIONS, type WorkBuddyDistribution } from "../src/distribution.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(distribution: WorkBuddyDistribution) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "wb-root-isolation-")));
  homes.push(home);
  const own = WORKBUDDY_DISTRIBUTIONS[distribution];
  const foreign = WORKBUDDY_DISTRIBUTIONS[distribution === "cn" ? "global" : "cn"];
  const app = path.join(home, "Applications", "WorkBuddy.app");
  const executable = path.join(app, "Contents", "MacOS", "Electron");
  const pkg = path.join(app, "Contents", "Resources", "app.asar.unpacked", "cli");
  const cli = path.join(pkg, "bin", "codebuddy");
  for (const file of [executable, cli]) {
    await mkdir(path.dirname(file), { recursive: true });
    // Invocation construction must never execute these placeholders.
    await writeFile(file, "#!/bin/sh\nexit 92\n", { mode: 0o755 });
  }
  await writeFile(path.join(pkg, "product.json"), JSON.stringify(own));
  const root = path.join(home, "custom-data-root");
  const cache = path.join(root, "cache");
  const snapshot = path.join(cache, "acc-product-config-v3.json");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await writeFile(snapshot, JSON.stringify(foreign), { mode: 0o600 });
  const partial = path.join(home, "partial.json");
  await writeFile(partial, '{"models":[]}');
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    [own.configDirectoryEnvironmentVariable]: root,
  };
  const invoke = (ephemeral = false, args?: string[]) =>
    workBuddyInvocation(environment, ephemeral, { distribution, platform: "darwin" }, args);
  return {
    home,
    own,
    foreign,
    app,
    executable,
    cli,
    root,
    cache,
    snapshot,
    partial,
    environment,
    invoke,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const partialInline = '{"models":[]}';
const cases: {
  name: string;
  prepare?: (f: Fixture) => void | Promise<void>;
  ephemeral?: boolean;
  args?: string[];
}[] = [
  { name: "automatic app discovery without explicit product configuration" },
  {
    name: "V3 partial configuration",
    prepare: ({ environment }) => {
      environment.ACC_PRODUCT_CONFIG_V3 = partialInline;
    },
  },
  {
    name: "V3 empty configuration",
    prepare: ({ environment }) => {
      environment.ACC_PRODUCT_CONFIG_V3 = "";
    },
  },
  {
    name: "V2 partial configuration",
    prepare: ({ environment }) => {
      environment.ACC_PRODUCT_CONFIG_V2 = partialInline;
    },
  },
  {
    name: "legacy partial configuration",
    prepare: ({ environment }) => {
      environment.ACC_PRODUCT_CONFIG = partialInline;
    },
  },
  {
    name: "explicit partial configuration file",
    prepare: ({ environment, partial }) => {
      environment.ACC_PRODUCT_CONFIG_PATH = partial;
    },
  },
  {
    name: "empty PATH configuration",
    prepare: ({ environment }) => {
      environment.ACC_PRODUCT_CONFIG_PATH = "";
    },
  },
  {
    name: "whitespace PATH configuration",
    prepare: ({ environment }) => {
      environment.ACC_PRODUCT_CONFIG_PATH = "   ";
    },
  },
  {
    name: "all explicit configuration sources together",
    prepare: ({ environment, partial }) => {
      Object.assign(environment, {
        ACC_PRODUCT_CONFIG_PATH: partial,
        ACC_PRODUCT_CONFIG_V3: partialInline,
        ACC_PRODUCT_CONFIG_V2: partialInline,
        ACC_PRODUCT_CONFIG: partialInline,
      });
    },
  },
  {
    name: "unparseable explicit inline configuration",
    prepare: ({ environment }) => {
      environment.ACC_PRODUCT_CONFIG_V3 = "{invalid-json";
    },
  },
  {
    name: "standalone CLI",
    prepare: ({ environment, own, cli }) => {
      environment[own.commandEnvironmentVariable] = cli;
    },
  },
  {
    name: "standalone CLI with partial configuration file",
    prepare: ({ environment, own, cli, partial }) => {
      environment[own.commandEnvironmentVariable] = cli;
      environment.ACC_PRODUCT_CONFIG_PATH = partial;
    },
  },
  { name: "readable 0644 snapshot", prepare: ({ snapshot }) => chmod(snapshot, 0o644) },
  { name: "writable 0775 root", prepare: ({ root }) => chmod(root, 0o775) },
  {
    name: "symlinked root",
    prepare: async ({ root }) => {
      await rename(root, `${root}-target`);
      await symlink(`${root}-target`, root);
    },
  },
  {
    name: "symlinked cache",
    prepare: async ({ cache }) => {
      await rename(cache, `${cache}-target`);
      await symlink(`${cache}-target`, cache);
    },
  },
  {
    name: "symlinked snapshot",
    prepare: async ({ snapshot }) => {
      await rename(snapshot, `${snapshot}-target`);
      await symlink(`${snapshot}-target`, snapshot);
    },
  },
  {
    name: "explicit app directory",
    prepare: ({ environment, own, app }) => {
      environment[own.commandEnvironmentVariable] = app;
    },
  },
  {
    name: "explicit Desktop executable",
    prepare: ({ environment, own, executable }) => {
      environment[own.commandEnvironmentVariable] = executable;
    },
  },
  { name: "ephemeral inspect", ephemeral: true },
  { name: "native administration arguments", args: ["--resume", "s", "--fork-session", "--print"] },
  {
    name: "linked standalone CLI",
    prepare: async ({ environment, own, cli, home }) => {
      const link = path.join(home, "linked-cli");
      await symlink(cli, link);
      environment[own.commandEnvironmentVariable] = link;
    },
  },
];

describe.runIf(process.platform !== "win32")("WorkBuddy root identity on disk", () => {
  describe.each(["global", "cn"] as const)("%s release", (distribution) => {
    it.each(cases)("rejects a foreign root: $name", async ({ prepare, ephemeral, args }) => {
      const f = await fixture(distribution);
      await prepare?.(f);
      expect(() => f.invoke(ephemeral, args)).toThrowError(
        expect.objectContaining({ code: "invalidRequest" }),
      );
    });

    it("accepts its own snapshot under an arbitrary directory name", async () => {
      const f = await fixture(distribution);
      await writeFile(f.snapshot, JSON.stringify(f.own));
      expect(f.invoke().environment).toMatchObject({
        WORKBUDDY_CONFIG_DIR: f.root,
        CODEBUDDY_CONFIG_DIR: f.root,
        ACC_PRODUCT_CONFIG_PATH: f.snapshot,
      });
    });

    it("accepts its own 0644 snapshot without forwarding it", async () => {
      const f = await fixture(distribution);
      await writeFile(f.snapshot, JSON.stringify(f.own));
      await chmod(f.snapshot, 0o644);
      expect(f.invoke().environment.ACC_PRODUCT_CONFIG_PATH).toBeUndefined();
    });

    it("accepts its own standalone CLI without forwarding a snapshot", async () => {
      const f = await fixture(distribution);
      await writeFile(f.snapshot, JSON.stringify(f.own));
      f.environment[f.own.commandEnvironmentVariable] = f.cli;
      expect(f.invoke().environment.ACC_PRODUCT_CONFIG_PATH).toBeUndefined();
    });

    it("keeps an unparseable root snapshot out of the child configuration", async () => {
      const f = await fixture(distribution);
      await writeFile(f.snapshot, "{invalid-json");
      expect(f.invoke().environment.ACC_PRODUCT_CONFIG_PATH).toBeUndefined();
    });

    it("rejects a foreign explicit configuration even with its own root snapshot", async () => {
      const f = await fixture(distribution);
      await writeFile(f.snapshot, JSON.stringify(f.own));
      f.environment.ACC_PRODUCT_CONFIG_V3 = JSON.stringify(f.foreign);
      expect(f.invoke).toThrowError(expect.objectContaining({ code: "invalidRequest" }));
    });
  });
});
