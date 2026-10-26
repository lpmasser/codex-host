import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codeBuddyPrimaryHistoryPath,
  type CodeBuddyClientFactory,
} from "@codexhost/adapter-codebuddy";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { workBuddyInvocation } from "../src/command.js";
import { workBuddyRuntimeProfile } from "../src/common.js";
import { workBuddyDistributionOf, type WorkBuddyDistribution } from "../src/distribution.js";
import { createHarnessAdapter as createWorkBuddyAdapter } from "../src/plugin.js";
import { WorkBuddyAdapter } from "../src/workbuddy-adapter.js";

const roots: string[] = [];
const adapters: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const dataFolder = { global: ".workbuddy-ai", cn: ".workbuddy" } as const;
const macApp = (app: string) => ({
  executable: `/Applications/${app}.app/Contents/MacOS/Electron`,
  cli: `/Applications/${app}.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`,
});
const windowsApp = (folder: string, exe: string) => {
  const root = `C:\\Users\\Test\\AppData\\Local\\Programs\\${folder}`;
  return {
    executable: `${root}\\${exe}`,
    cli: `${root}\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy`,
  };
};
type Install = { executable: string; cli: string; release: WorkBuddyDistribution | "codebuddy" };

/** A controlled file layout: executables plus the product metadata each CLI declares. */
function layout(platform: "darwin" | "win32", installs: Install[]) {
  const files = installs.flatMap(({ executable, cli }) => [executable, cli]);
  return {
    platform,
    isExecutable: (candidate: string) => files.includes(candidate),
    isDirectory: (candidate: string) =>
      installs.some(({ executable }) => executable.startsWith(`${candidate}\\`)),
    readProduct: (cli: string) => {
      const install = installs.find((candidate) => candidate.cli === cli);
      if (!install) throw new Error("ENOENT");
      return {
        dataFolderName:
          install.release === "codebuddy" ? ".codebuddy" : dataFolder[install.release],
      };
    },
  };
}
const windowsEnvironment = {
  USERPROFILE: "C:\\Users\\Test",
  LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
};

describe("WorkBuddy release discovery", () => {
  const macGlobal: Install = { ...macApp("WorkBuddy AI"), release: "global" };
  const macCn: Install = { ...macApp("WorkBuddy"), release: "cn" };
  const winGlobal: Install = {
    ...windowsApp("WorkBuddy AI", "WorkBuddy AI.exe"),
    release: "global",
  };
  const winCn: Install = { ...windowsApp("WorkBuddy", "WorkBuddy.exe"), release: "cn" };

  it.each([
    ["darwin", [macGlobal, macCn]],
    ["win32", [winGlobal, winCn]],
  ] as const)(
    "selects each release's own %s installation when both are installed",
    (platform, installs) => {
      const dependencies = layout(platform, [...installs]);
      const environment = platform === "darwin" ? { HOME: "/Users/test" } : windowsEnvironment;
      for (const install of installs) {
        const invocation = workBuddyInvocation(environment, false, {
          ...dependencies,
          distribution: install.release as WorkBuddyDistribution,
        });
        expect(invocation.command).toBe(install.executable);
        expect(invocation.arguments).toEqual(["--eval", expect.any(String), install.cli, "--acp"]);
      }
    },
  );

  it.each([
    ["darwin", macGlobal, "cn"],
    ["darwin", macCn, "global"],
    ["win32", winGlobal, "cn"],
    ["win32", winCn, "global"],
  ] as const)(
    "never borrows the only %s installation for the other release",
    (platform, install, other) => {
      const dependencies = layout(platform, [install]);
      const environment = platform === "darwin" ? { HOME: "/Users/test" } : windowsEnvironment;
      expect(
        workBuddyInvocation(environment, false, {
          ...dependencies,
          distribution: install.release as WorkBuddyDistribution,
        }).command,
      ).toBe(install.executable);
      expect(() =>
        workBuddyInvocation(environment, false, { ...dependencies, distribution: other }),
      ).toThrow(/unavailable/u);
    },
  );

  it("identifies a Windows release by its metadata, not its installation folder name", () => {
    const international = {
      ...windowsApp("WorkBuddy", "WorkBuddy.exe"),
      release: "global" as const,
    };
    const dependencies = layout("win32", [international]);
    expect(() =>
      workBuddyInvocation(windowsEnvironment, false, { ...dependencies, distribution: "cn" }),
    ).toThrow(/unavailable/u);
    expect(
      workBuddyInvocation(windowsEnvironment, false, { ...dependencies, distribution: "global" })
        .command,
    ).toBe(international.executable);
  });

  it.each([
    ["installation folder", "C:\\Users\\Test\\AppData\\Local\\Programs\\WorkBuddy AI"],
    ["Desktop executable", winGlobal.executable],
  ])("rejects an explicit %s of the other release instead of switching Harness", (_kind, path) => {
    const dependencies = layout("win32", [winGlobal, winCn]);
    expect(() =>
      workBuddyInvocation({ ...windowsEnvironment, CODEXHOST_WORKBUDDYCN_COMMAND: path }, false, {
        ...dependencies,
        distribution: "cn",
      }),
    ).toThrow(`${path} is WorkBuddy, not WorkBuddy CN; select the workbuddy Harness for it`);
    expect(
      workBuddyInvocation({ ...windowsEnvironment, CODEXHOST_WORKBUDDY_COMMAND: path }, false, {
        ...dependencies,
        distribution: "global",
      }).command,
    ).toBe(winGlobal.executable);
  });

  it("rejects an explicit macOS app of the other release", () => {
    const dependencies = layout("darwin", [macGlobal, macCn]);
    expect(() =>
      workBuddyInvocation(
        { HOME: "/Users/test", CODEXHOST_WORKBUDDY_COMMAND: macCn.executable },
        false,
        { ...dependencies, distribution: "global" },
      ),
    ).toThrow("is WorkBuddy CN, not WorkBuddy; select the workbuddy-cn Harness for it");
  });

  it("reads only its own launch override", () => {
    const dependencies = layout("darwin", [macGlobal, macCn]);
    const environment = {
      HOME: "/Users/test",
      CODEXHOST_WORKBUDDY_COMMAND: macGlobal.executable,
      CODEXHOST_WORKBUDDYCN_COMMAND: macCn.executable,
    };
    for (const install of [macGlobal, macCn])
      expect(
        workBuddyInvocation(environment, false, {
          ...dependencies,
          distribution: install.release as WorkBuddyDistribution,
        }).command,
      ).toBe(install.executable);
    // The international override does not stop China release discovery.
    expect(
      workBuddyInvocation(
        { HOME: "/Users/test", CODEXHOST_WORKBUDDY_COMMAND: "/custom/international" },
        false,
        { ...dependencies, distribution: "cn" },
      ).command,
    ).toBe(macCn.executable);
  });

  it("does not let a plain CodeBuddy CLI stand in for WorkBuddy", () => {
    const codebuddy = { executable: "/usr/local/bin/node", cli: "/opt/codebuddy/bin/codebuddy" };
    const dependencies = layout("darwin", [{ ...codebuddy, release: "codebuddy" }]);
    for (const distribution of ["global", "cn"] as const)
      expect(() =>
        workBuddyInvocation(
          {
            HOME: "/Users/test",
            CODEXHOST_WORKBUDDY_COMMAND: codebuddy.cli,
            CODEXHOST_WORKBUDDYCN_COMMAND: codebuddy.cli,
          },
          false,
          { ...dependencies, distribution },
        ),
      ).toThrow("does not declare");
  });
});

describe("WorkBuddy release data roots", () => {
  const ref = (harnessId: string) =>
    nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "native-session",
      formatVersion: 1,
    });
  const installs: Install[] = [
    { ...macApp("WorkBuddy AI"), release: "global" },
    { ...macApp("WorkBuddy"), release: "cn" },
  ];
  // App-written snapshots as the two releases store them (identity fields only).
  const internationalSnapshot = JSON.stringify({
    dataFolderName: ".workbuddy-ai",
    endpoint: "https://www.workbuddy.ai",
  });
  const chinaSnapshot = JSON.stringify({
    dataFolderName: ".workbuddy",
    endpoint: "https://www.workbuddy.cn",
  });

  /** Secure-looking root directories holding the given App-written snapshot files. */
  function launch(
    distribution: WorkBuddyDistribution,
    environment: NodeJS.ProcessEnv,
    snapshots: Record<string, string>,
  ) {
    return workBuddyInvocation(environment, false, {
      ...layout("darwin", installs),
      distribution,
      lstat: (candidate) => ({
        isDirectory: () => !(candidate in snapshots),
        isFile: () => candidate in snapshots,
        isSymbolicLink: () => false,
        mode: candidate in snapshots ? 0o100600 : 0o40700,
        size: 1,
        uid: 501,
      }),
      getuid: () => 501,
      readText: (file) => {
        const contents = snapshots[file];
        if (contents === undefined) throw new Error("ENOENT");
        return contents;
      },
    }).environment;
  }
  const historyPath = (distribution: WorkBuddyDistribution, environment: NodeJS.ProcessEnv) => {
    const profile = workBuddyRuntimeProfile(distribution);
    return codeBuddyPrimaryHistoryPath("/work", ref(profile.harnessId), environment, profile);
  };
  const bothDefaultSnapshots = {
    "/Users/test/.workbuddy-ai/cache/acc-product-config-v3.json": internationalSnapshot,
    "/Users/test/.workbuddy/cache/acc-product-config-v3.json": chinaSnapshot,
  };

  it.each([
    ["global", "/Users/test/.workbuddy-ai"],
    ["cn", "/Users/test/.workbuddy"],
  ] as const)(
    "gives %s one default root for the ACP child, product snapshot and history",
    (distribution, root) => {
      const environment = { HOME: "/Users/test", CODEBUDDY_CONFIG_DIR: "/ordinary-codebuddy" };
      expect(launch(distribution, environment, bothDefaultSnapshots)).toMatchObject({
        CODEBUDDY_CONFIG_DIR: root,
        WORKBUDDY_CONFIG_DIR: root,
        ACC_PRODUCT_CONFIG_PATH: `${root}/cache/acc-product-config-v3.json`,
      });
      expect(historyPath(distribution, environment)).toBe(
        `${root}/projects/work/native-session.jsonl`,
      );
    },
  );

  // Review repro 1: an international root override reached CN's child and snapshot.
  it("keeps the China default root when only the international root is overridden", () => {
    const environment = { HOME: "/Users/test", WORKBUDDY_CONFIG_DIR: "/Users/test/.workbuddy-ai" };
    const child = launch("cn", environment, bothDefaultSnapshots);
    expect(child).toMatchObject({
      CODEBUDDY_CONFIG_DIR: "/Users/test/.workbuddy",
      WORKBUDDY_CONFIG_DIR: "/Users/test/.workbuddy",
      ACC_PRODUCT_CONFIG_PATH: "/Users/test/.workbuddy/cache/acc-product-config-v3.json",
    });
    expect(historyPath("cn", environment)).toBe(
      "/Users/test/.workbuddy/projects/work/native-session.jsonl",
    );
    expect(launch("global", environment, bothDefaultSnapshots).WORKBUDDY_CONFIG_DIR).toBe(
      "/Users/test/.workbuddy-ai",
    );
  });

  it("gives each release its own root when both Host overrides are set", () => {
    const environment = {
      HOME: "/Users/test",
      WORKBUDDY_CONFIG_DIR: "/roots/international",
      WORKBUDDYCN_CONFIG_DIR: "/roots/china",
    };
    const snapshots = {
      "/roots/international/cache/acc-product-config-v3.json": internationalSnapshot,
      "/roots/china/cache/acc-product-config-v3.json": chinaSnapshot,
    };
    for (const [distribution, root] of [
      ["global", "/roots/international"],
      ["cn", "/roots/china"],
    ] as const) {
      expect(launch(distribution, environment, snapshots)).toMatchObject({
        CODEBUDDY_CONFIG_DIR: root,
        WORKBUDDY_CONFIG_DIR: root,
        ACC_PRODUCT_CONFIG_PATH: `${root}/cache/acc-product-config-v3.json`,
      });
      expect(historyPath(distribution, environment)).toBe(
        `${root}/projects/work/native-session.jsonl`,
      );
    }
  });

  it("rejects a China root override that holds the international release's data", () => {
    expect(() =>
      launch(
        "cn",
        { HOME: "/Users/test", WORKBUDDYCN_CONFIG_DIR: "/Users/test/.workbuddy-ai" },
        bothDefaultSnapshots,
      ),
    ).toThrow(
      "The product snapshot in this WorkBuddy root declares WorkBuddy, not WorkBuddy CN; select the workbuddy Harness for it",
    );
  });

  it("reads China native history from the China root even when the international root is set", async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "wb-cn-history-")));
    roots.push(home);
    const cwd = path.join(home, "Project");
    await mkdir(cwd);
    // Native PathUtils.compressPath of the canonical cwd, written out independently.
    const slug = `${home.split(path.sep).filter(Boolean).join("-").replace(/:/gu, "")}-Project`;
    const write = async (root: string, text: string) => {
      const directory = path.join(root, "projects", slug);
      await mkdir(directory, { recursive: true });
      const rows = [
        { id: "u", type: "message", role: "user", sessionId: "s", cwd, content: text },
        {
          id: "a",
          parentId: "u",
          type: "message",
          role: "assistant",
          sessionId: "s",
          cwd,
          content: "OK",
          status: "completed",
        },
      ];
      await writeFile(
        path.join(directory, "s.jsonl"),
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
    };
    await write(path.join(home, ".workbuddy"), "china history");
    await write(path.join(home, ".workbuddy-ai"), "international history");
    const adapter = new WorkBuddyAdapter({
      distribution: "cn",
      environment: { HOME: home, WORKBUDDY_CONFIG_DIR: path.join(home, ".workbuddy-ai") },
      clientFactory: fakeClient("s"),
    });
    adapters.push(adapter);
    const resumed = await adapter.open({
      kind: "resume",
      cwd,
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "workbuddy-cn",
        nativeSessionId: "s",
        formatVersion: 1,
      }),
    });
    if (!resumed.ok) throw new Error(resumed.error.message);
    expect(await resumed.value.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ text: "china history" }] }] },
    });
  });
});

describe("WorkBuddy release product configuration", () => {
  const dependencies = (
    distribution: WorkBuddyDistribution,
    files: Record<string, string> = {},
  ) => ({
    ...layout("darwin", [
      { ...macApp("WorkBuddy AI"), release: "global" as const },
      { ...macApp("WorkBuddy"), release: "cn" as const },
    ]),
    distribution,
    readText: (file: string) => {
      const contents = files[file];
      if (contents === undefined) throw new Error("ENOENT");
      return contents;
    },
  });
  // Identity fields as an exported international snapshot declares them, with a private value.
  const international = JSON.stringify({
    dataFolderName: ".workbuddy-ai",
    endpoint: "https://www.workbuddy.ai",
    accountToken: "private-account-value",
  });
  const internationalFile = "/Users/test/.workbuddy-ai/cache/acc-product-config-v3.json";

  // Review repro 2: CN kept an international ACC_PRODUCT_CONFIG_PATH.
  it("rejects an explicit snapshot file of the other release and keeps it for its own", () => {
    const environment = { HOME: "/Users/test", ACC_PRODUCT_CONFIG_PATH: internationalFile };
    const files = { [internationalFile]: international };
    expect(() => workBuddyInvocation(environment, false, dependencies("cn", files))).toThrow(
      "ACC_PRODUCT_CONFIG_PATH declares WorkBuddy, not WorkBuddy CN; select the workbuddy Harness for it",
    );
    expect(
      workBuddyInvocation(environment, false, dependencies("global", files)).environment
        .ACC_PRODUCT_CONFIG_PATH,
    ).toBe(internationalFile);
  });

  // Review repro 3: CN forwarded an international inline V3 snapshot.
  it.each(["ACC_PRODUCT_CONFIG_V3", "ACC_PRODUCT_CONFIG_V2", "ACC_PRODUCT_CONFIG"])(
    "rejects inline %s of the other release without echoing it",
    (name) => {
      let error: unknown;
      try {
        workBuddyInvocation(
          { HOME: "/Users/test", [name]: international },
          false,
          dependencies("cn"),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: "invalidRequest",
        message: `${name} declares WorkBuddy, not WorkBuddy CN; select the workbuddy Harness for it`,
      });
      expect(String((error as Error).message)).not.toContain("private-account-value");
    },
  );

  it.each([
    ["global", { dataFolderName: ".workbuddy" }],
    ["global", { endpoint: "https://www.workbuddy.cn/" }],
    ["global", { authentication: { id: "workbuddy-desktop" } }],
    ["cn", { authentication: { id: "workbuddy-desktop-ai" } }],
    ["cn", { endpoint: "https://WWW.WORKBUDDY.AI/" }],
    ["cn", { endpoint: "https://www.workbuddy.ai/api/" }],
    ["cn", { dataFolderName: ".workbuddy", authentication: { id: "workbuddy-desktop-ai" } }],
  ] as const)("rejects foreign product identity for %s: %j", (distribution, product) => {
    const [own, foreign, foreignId] =
      distribution === "cn"
        ? ["WorkBuddy CN", "WorkBuddy", "workbuddy"]
        : ["WorkBuddy", "WorkBuddy CN", "workbuddy-cn"];
    expect(() =>
      workBuddyInvocation(
        { HOME: "/Users/test", ACC_PRODUCT_CONFIG_V3: JSON.stringify(product) },
        false,
        dependencies(distribution),
      ),
    ).toThrow(
      `ACC_PRODUCT_CONFIG_V3 declares ${foreign}, not ${own}; select the ${foreignId} Harness for it`,
    );
  });

  it.each([".codebuddy", ".unknown-product"])(
    "rejects configuration declaring the %s data root for both releases",
    (dataFolderName) => {
      for (const [distribution, displayName] of [
        ["global", "WorkBuddy"],
        ["cn", "WorkBuddy CN"],
      ] as const)
        expect(() =>
          workBuddyInvocation(
            { HOME: "/Users/test", ACC_PRODUCT_CONFIG_V2: JSON.stringify({ dataFolderName }) },
            false,
            dependencies(distribution),
          ),
        ).toThrow(`ACC_PRODUCT_CONFIG_V2 declares another product's data root, not ${displayName}`);
    },
  );

  it("does not assign an unknown custom service to either release", () => {
    const custom = JSON.stringify({
      endpoint: "https://models.example.test/",
      authentication: { id: "custom-provider" },
      models: [],
    });
    for (const distribution of ["global", "cn"] as const)
      expect(
        workBuddyInvocation(
          { HOME: "/Users/test", ACC_PRODUCT_CONFIG_V3: custom },
          false,
          dependencies(distribution),
        ).environment.ACC_PRODUCT_CONFIG_V3,
      ).toBe(custom);
  });

  it("keeps explicit configuration of its own release and region-less Model configuration", () => {
    const china = JSON.stringify({
      dataFolderName: ".workbuddy",
      endpoint: "https://www.workbuddy.cn",
    });
    const models = JSON.stringify({ models: [{ id: "m", name: "M" }], agents: [] });
    for (const [distribution, value] of [
      ["cn", china],
      ["cn", models],
      ["global", models],
    ] as const)
      expect(
        workBuddyInvocation(
          { HOME: "/Users/test", ACC_PRODUCT_CONFIG_V3: value },
          false,
          dependencies(distribution),
        ).environment.ACC_PRODUCT_CONFIG_V3,
      ).toBe(value);
  });

  it("rejects explicit configuration it cannot verify without echoing it", () => {
    for (const environment of [
      { ACC_PRODUCT_CONFIG_V3: "{not json private-account-value" },
      { ACC_PRODUCT_CONFIG_PATH: "/missing/product.json" },
    ])
      expect(() =>
        workBuddyInvocation({ HOME: "/Users/test", ...environment }, false, dependencies("cn")),
      ).toThrow(
        /^(?!.*private-account-value).*cannot be verified as WorkBuddy CN product configuration$/u,
      );
  });

  it.each([
    { dataFolderName: ".workbuddy", endpoint: "https://www.workbuddy.ai" },
    { dataFolderName: ".codebuddy", endpoint: "https://www.workbuddy.cn" },
    { dataFolderName: ".unknown-product", endpoint: "https://www.workbuddy.cn" },
  ])("does not identify a CLI with conflicting product metadata: %j", (product) => {
    expect(workBuddyDistributionOf("/opt/mixed/bin/codebuddy", () => product)).toBeUndefined();
  });
});

/** A standalone CLI package on disk: `bin/codebuddy` plus its `product.json`. */
async function standaloneCli(release: WorkBuddyDistribution | "codebuddy") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "wb-release-")));
  roots.push(root);
  const pkg = path.join(root, "package");
  await mkdir(path.join(pkg, "bin"), { recursive: true });
  const script = path.join(pkg, "bin", "codebuddy");
  await writeFile(script, "#!/bin/sh\nexit 1\n");
  await chmod(script, 0o755);
  await writeFile(
    path.join(pkg, "product.json"),
    JSON.stringify({
      dataFolderName: release === "codebuddy" ? ".codebuddy" : dataFolder[release],
    }),
  );
  // Package managers expose the script through a link outside the package.
  const link = path.join(root, "workbuddy");
  await symlink(script, link);
  return { root, link };
}

describe.runIf(process.platform !== "win32")("WorkBuddy release product metadata on disk", () => {
  it.each(["global", "cn", "codebuddy"] as const)(
    "reads a linked %s CLI's own package metadata",
    async (release) => {
      const { link } = await standaloneCli(release);
      expect(workBuddyDistributionOf(link)).toBe(release === "codebuddy" ? undefined : release);
    },
  );

  it("treats missing metadata as no WorkBuddy release", async () => {
    expect(workBuddyDistributionOf("/missing/bin/codebuddy")).toBeUndefined();
  });
});

function fakeClient(sessionId: string): CodeBuddyClientFactory {
  return () => ({
    initialize: async () => ({}),
    open: async (_cwd, requested) => ({
      sessionId: requested ?? sessionId,
      configOptions: [
        { id: "model", currentValue: "fast", options: [{ value: "fast", name: "Fast" }] },
        { id: "mode", currentValue: "default", options: [{ value: "default", name: "Default" }] },
      ],
    }),
    prompt: async () => ({ stopReason: "end_turn" }),
    configure: async () => ({}),
    cancel: async () => {},
    answer: async () => {},
    close: async () => {},
  });
}

describe("WorkBuddy release Harness identity", () => {
  it.each([
    ["global", "workbuddy", "workbuddy-cn"],
    ["cn", "workbuddy-cn", "workbuddy"],
  ] as const)(
    "keeps %s Sessions and Native Refs in their own identity",
    async (distribution, id, foreign) => {
      const adapter = new WorkBuddyAdapter({
        distribution,
        environment: { HOME: tmpdir() },
        clientFactory: fakeClient(`${id}-native`),
      });
      adapters.push(adapter);
      expect(adapter.harnessId).toBe(id);
      const created = await adapter.open({ kind: "create", cwd: process.cwd() });
      if (!created.ok) throw new Error(created.error.message);
      expect(created.value.initialState.nativeRef?.harnessId).toBe(id);
      expect(created.value.capabilities.history).toEqual({
        fork: true,
        forkAcrossCwd: true,
        rollbackLastTurn: true,
      });
      await created.value.close();

      const foreignRef = nativeSessionRefSchema.parse({
        harnessId: foreign,
        nativeSessionId: "foreign-native",
        formatVersion: 1,
      });
      for (const input of [
        { kind: "resume" as const, cwd: process.cwd(), nativeRef: foreignRef },
        { kind: "fork" as const, cwd: process.cwd(), sourceRef: foreignRef, checkpoint: null },
        { kind: "rollbackLastTurn" as const, cwd: process.cwd(), sourceRef: foreignRef },
      ])
        expect(await adapter.open(input as Parameters<typeof adapter.open>[0])).toMatchObject({
          ok: false,
          error: {
            code: "invalidRequest",
            message: expect.stringContaining("Native Session identity"),
          },
        });
    },
  );

  it.runIf(process.platform !== "win32")(
    "starts inspection through the selected release's explicit CLI only",
    async () => {
      const international = await standaloneCli("global");
      const adapter = createWorkBuddyAdapter(
        {
          environment: { HOME: international.root },
          platform: process.platform,
          managedRemoteHost: false,
          launchCommand: international.link,
        },
        "cn",
      );
      adapters.push(adapter);
      expect(adapter.harnessId).toBe("workbuddy-cn");
      expect(await adapter.inspect({ cwd: international.root })).toMatchObject({
        status: "unavailable",
        error: { message: expect.stringContaining("is WorkBuddy, not WorkBuddy CN") },
      });
    },
  );

  it.each([
    ["global", "workbuddy"],
    ["cn", "workbuddy-cn"],
  ] as const)(
    "brokers the managed macOS %s release under its own Harness ID",
    async (distribution, id) => {
      const adapter = createWorkBuddyAdapter(
        {
          environment: {},
          platform: "darwin",
          managedRemoteHost: true,
          brokerDescriptorPath: path.join(tmpdir(), `${id}-broker-v1.json`),
        },
        distribution,
      );
      adapters.push(adapter);
      expect(adapter.constructor.name).toBe("BrokeredHarnessAdapter");
      expect(adapter.harnessId).toBe(id);
    },
  );
});
