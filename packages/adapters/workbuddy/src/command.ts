import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { CodeBuddyError, type CodeBuddyInvocationFactory } from "@codexhost/adapter-codebuddy";
import {
  commandInvocation,
  environmentValue,
  isExecutableFile,
  isDirectory,
  resolveHarnessExecutable,
  targetPath,
  withNodeRuntimeOnPath,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";
import { workBuddyDelegationArguments } from "./delegation.js";
import { WORKBUDDY_CREDENTIAL_PRELOAD } from "./credential-bootstrap.js";
import {
  WORKBUDDY_DISTRIBUTIONS,
  foreignWorkBuddyProduct,
  workBuddyDistributionOf,
  type WorkBuddyDistribution,
} from "./distribution.js";
import {
  resolveWorkBuddyBundle,
  resolveWorkBuddyInstallDirectory,
  WORKBUDDY_MACOS_ELECTRON,
} from "./discovery.js";
export { WORKBUDDY_MACOS_ELECTRON, WORKBUDDY_MACOS_CLI } from "./discovery.js";

export const workBuddyDiscoverySpec: HarnessDiscoverySpec = {
  id: "workbuddy",
  // An absolute app-owned default deliberately prevents discovery of an unrelated PATH codebuddy.
  command: WORKBUDDY_MACOS_ELECTRON,
  commandEnvironmentVariable: "CODEXHOST_WORKBUDDY_COMMAND",
};

interface WorkBuddyInvocationDependencies {
  /** The release this Harness identity runs; the existing `workbuddy` ID is international. */
  distribution?: WorkBuddyDistribution;
  platform?: NodeJS.Platform;
  readProduct?: (cliScript: string) => unknown;
  readText?: (file: string) => string;
  isExecutable?: (candidate: string) => boolean;
  isDirectory?: (candidate: string) => boolean;
  lstat?: (candidate: string) => {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
    mode: number;
    size: number;
    uid: number;
  };
  getuid?: () => number | undefined;
  isFile?: (candidate: string) => boolean;
}

const WORKBUDDY_PRODUCT_CONFIG_PATH_ENV = "ACC_PRODUCT_CONFIG_PATH";
const WORKBUDDY_PRODUCT_CONFIG_INLINE_ENVS = [
  "ACC_PRODUCT_CONFIG_V3",
  "ACC_PRODUCT_CONFIG_V2",
  "ACC_PRODUCT_CONFIG",
] as const;

function bundledProductConfigPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  dependencies: WorkBuddyInvocationDependencies,
): string | undefined {
  if (
    environment[WORKBUDDY_PRODUCT_CONFIG_PATH_ENV] !== undefined ||
    WORKBUDDY_PRODUCT_CONFIG_INLINE_ENVS.some((name) => environment[name] !== undefined)
  )
    return;

  const root = environment.WORKBUDDY_CONFIG_DIR;
  if (!root) return;
  const paths = targetPath(platform);
  const candidate = paths.join(root, "cache", "acc-product-config-v3.json");
  try {
    const inspect = dependencies.lstat ?? lstatSync;
    const uid = (dependencies.getuid ?? (() => process.getuid?.()))();
    for (const directory of [root, paths.dirname(candidate)]) {
      const metadata = inspect(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
      if (platform !== "win32") {
        if ((metadata.mode & 0o022) !== 0) return;
        if (uid !== undefined && metadata.uid !== uid) return;
      }
    }
    const metadata = inspect(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) return;
    if (platform !== "win32") {
      if ((metadata.mode & 0o077) !== 0) return;
      if (uid !== undefined && metadata.uid !== uid) return;
    }
    return candidate;
  } catch {
    return;
  }
}

/** Product configuration declaring another release or product identity is never forwarded. */
function rejectForeignProduct(
  source: string,
  product: unknown,
  distribution: WorkBuddyDistribution,
): void {
  const foreign = foreignWorkBuddyProduct(product, distribution);
  const { displayName } = WORKBUDDY_DISTRIBUTIONS[distribution];
  if (foreign === "other")
    throw new CodeBuddyError(
      "invalidRequest",
      `${source} declares another product's data root, not ${displayName}`,
    );
  if (foreign)
    throw new CodeBuddyError(
      "invalidRequest",
      `${source} declares ${WORKBUDDY_DISTRIBUTIONS[foreign].displayName}, not ${displayName}; select the ${WORKBUDDY_DISTRIBUTIONS[foreign].harnessId} Harness for it`,
    );
}

/**
 * The App-written snapshot under the selected root. An unreadable one keeps the bundled CLI
 * fallback; one declaring the other release means the root itself belongs to that release.
 */
function verifiedSnapshot(
  candidate: string | undefined,
  distribution: WorkBuddyDistribution,
  readText: (file: string) => string,
): string | undefined {
  if (!candidate) return;
  let product: unknown;
  try {
    product = JSON.parse(readText(candidate));
  } catch {
    return;
  }
  rejectForeignProduct("The product snapshot in this WorkBuddy root", product, distribution);
  return candidate;
}

/** Explicit inherited product configuration must belong to the selected release. */
function verifyExplicitProductConfiguration(
  environment: NodeJS.ProcessEnv,
  distribution: WorkBuddyDistribution,
  readText: (file: string) => string,
): void {
  const path = environment[WORKBUDDY_PRODUCT_CONFIG_PATH_ENV]?.trim();
  const sources: [string, () => string][] = [
    ...(path
      ? [[WORKBUDDY_PRODUCT_CONFIG_PATH_ENV, () => readText(path)] as [string, () => string]]
      : []),
    ...WORKBUDDY_PRODUCT_CONFIG_INLINE_ENVS.flatMap((name) => {
      const value = environment[name];
      return value?.trim() ? [[name, () => value] as [string, () => string]] : [];
    }),
  ];
  for (const [name, read] of sources) {
    let product: unknown;
    try {
      product = JSON.parse(read());
    } catch {
      // The value is never echoed: product configuration may carry account data.
      throw new CodeBuddyError(
        "invalidRequest",
        `${name} cannot be verified as ${WORKBUDDY_DISTRIBUTIONS[distribution].displayName} product configuration`,
      );
    }
    rejectForeignProduct(name, product, distribution);
  }
}

export function workBuddyEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  distribution: WorkBuddyDistribution = "global",
): NodeJS.ProcessEnv {
  const paths = targetPath(platform);
  const { configDirectoryEnvironmentVariable, dataFolderName } =
    WORKBUDDY_DISTRIBUTIONS[distribution];
  const configuredRoot = environment[configDirectoryEnvironmentVariable];
  const root = paths.resolve(
    configuredRoot?.trim()
      ? configuredRoot
      : paths.join(environment.HOME || environment.USERPROFILE || homedir(), dataFolderName),
  );
  return {
    ...environment,
    // The native CLI runs one product and reads WORKBUDDY_CONFIG_DIR/CODEBUDDY_CONFIG_DIR.
    // Force both to this release's root so neither a global CodeBuddy nor the other
    // release's Host override can leak history, authentication or settings.
    CODEBUDDY_CONFIG_DIR: root,
    WORKBUDDY_CONFIG_DIR: root,
    DISABLE_AUTOUPDATER: environment.DISABLE_AUTOUPDATER ?? "1",
  };
}

/** Select the same installation for native startup and application version checks. */
export function resolveWorkBuddyLaunch(
  environment: NodeJS.ProcessEnv,
  dependencies: WorkBuddyInvocationDependencies = {},
) {
  const platform = dependencies.platform ?? process.platform;
  const distribution = dependencies.distribution ?? "global";
  const { displayName, commandEnvironmentVariable } = WORKBUDDY_DISTRIBUTIONS[distribution];
  const releaseOf = (cli: string) => workBuddyDistributionOf(cli, dependencies.readProduct);
  const configured = environmentValue(environment, commandEnvironmentVariable)?.trim() || undefined;
  if (!configured && platform !== "darwin" && platform !== "win32")
    throw new CodeBuddyError(
      "notInstalled",
      `${displayName} app discovery is available on macOS and Windows; set ${commandEnvironmentVariable} for a compatible native runtime on this platform`,
    );
  const isExecutable =
    dependencies.isExecutable ?? ((candidate: string) => isExecutableFile(candidate, platform));
  const configuredDirectory =
    configured && (dependencies.isDirectory ?? isDirectory)(configured) ? configured : undefined;
  const explicitExecutable =
    configured && !configuredDirectory
      ? resolveHarnessExecutable(
          workBuddyDiscoverySpec,
          { environment, platform, command: configured },
          { isExecutable },
        )?.executable
      : undefined;
  const explicitDesktop =
    explicitExecutable &&
    ((platform === "win32" &&
      /^(?:WorkBuddy|WorkBuddy AI|WorkBuddyAI)\.exe$/iu.test(
        targetPath(platform).basename(explicitExecutable),
      )) ||
      (platform === "darwin" &&
        /\/(?:WorkBuddy|WorkBuddy AI)\.app\/Contents\/MacOS\/Electron$/u.test(explicitExecutable)));
  const bundle = configuredDirectory
    ? resolveWorkBuddyInstallDirectory(configuredDirectory, environment, platform, isExecutable)
    : !configured || explicitDesktop
      ? resolveWorkBuddyBundle(
          environment,
          platform,
          isExecutable,
          explicitExecutable,
          // Automatic discovery selects only this release; an explicit path is checked below.
          configured ? () => true : (cli) => releaseOf(cli) === distribution,
        )
      : undefined;
  const executable =
    configured && !explicitDesktop && !configuredDirectory
      ? explicitExecutable
      : bundle?.executable;
  if (!executable)
    throw new CodeBuddyError(
      "notInstalled",
      `${displayName} app or its bundled CLI is unavailable`,
    );
  if (configured) {
    // An explicit app, folder or standalone CLI must declare this release; plain CodeBuddy and
    // the other WorkBuddy release are rejected instead of silently changing the Harness.
    const release = releaseOf(bundle?.cli ?? executable);
    if (release !== distribution)
      throw new CodeBuddyError(
        "invalidRequest",
        release
          ? `${configured} is ${WORKBUDDY_DISTRIBUTIONS[release].displayName}, not ${displayName}; select the ${WORKBUDDY_DISTRIBUTIONS[release].harnessId} Harness for it`
          : `${configured} does not declare ${displayName} product metadata`,
      );
  }

  return { executable, bundle };
}

export function workBuddyInvocation(
  environment: NodeJS.ProcessEnv,
  ephemeral: boolean,
  dependenciesOrArguments: WorkBuddyInvocationDependencies | string[] = {},
  argumentsOverride?: string[],
): ReturnType<CodeBuddyInvocationFactory> & {
  /** App-owned CLI script, separate from the Electron executable and preload arguments. */
  bundledCliPath?: string;
} {
  const dependencies = Array.isArray(dependenciesOrArguments) ? {} : dependenciesOrArguments;
  const nativeArguments = Array.isArray(dependenciesOrArguments)
    ? dependenciesOrArguments
    : argumentsOverride;
  const platform = dependencies.platform ?? process.platform;
  const distribution = dependencies.distribution ?? "global";
  const { executable, bundle } = resolveWorkBuddyLaunch(environment, dependencies);
  const paths = targetPath(platform);
  const cliDist = bundle && paths.join(paths.dirname(paths.dirname(bundle.cli)), "dist");
  const isFile =
    dependencies.isFile ??
    ((candidate: string) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  const liteOnly = Boolean(
    cliDist &&
    isFile(paths.join(cliDist, "codebuddy-lite-wb.mjs")) &&
    !isFile(paths.join(cliDist, "codebuddy.js")) &&
    !isFile(paths.join(cliDist, "codebuddy-headless.js")),
  );
  const acpArguments = nativeArguments ?? [
    "--acp",
    ...(ephemeral ? ["--no-session-persistence"] : []),
    ...workBuddyDelegationArguments(environment, ephemeral),
  ];
  const serve = liteOnly && acpArguments.includes("--acp") && !acpArguments.includes("--serve");

  const configuredEnvironment = withNodeRuntimeOnPath(
    workBuddyEnvironment(environment, platform, distribution),
    process.execPath,
    platform,
  );
  const readText = dependencies.readText ?? ((file: string) => readFileSync(file, "utf8"));
  verifyExplicitProductConfiguration(configuredEnvironment, distribution, readText);
  const productConfigPath = bundle
    ? verifiedSnapshot(
        bundledProductConfigPath(configuredEnvironment, platform, dependencies),
        distribution,
        readText,
      )
    : undefined;
  const childEnvironment = bundle
    ? {
        ...configuredEnvironment,
        // EOF-only native Fork copies do no model work. The bundled CLI otherwise
        // waits for its telemetry channel before copying; normal ACP keeps its policy.
        ...(nativeArguments?.includes("--print") &&
        nativeArguments.includes("--fork-session") &&
        configuredEnvironment.DISABLE_TELEMETRY === undefined
          ? { DISABLE_TELEMETRY: "1" }
          : {}),
        ...(productConfigPath ? { [WORKBUDDY_PRODUCT_CONFIG_PATH_ENV]: productConfigPath } : {}),
        ...(liteOnly ? { CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1" } : {}),
        ...(serve
          ? {
              CODEBUDDY_GATEWAY_AUTH: "password",
              CODEBUDDY_GATEWAY_PASSWORD: randomBytes(32).toString("base64url"),
              CODEBUDDY_GATEWAY_BASE_PATH: "",
            }
          : {}),
        ELECTRON_RUN_AS_NODE: "1",
      }
    : configuredEnvironment;
  return {
    ...commandInvocation(
      executable,
      [
        ...(bundle
          ? ["--eval", `${WORKBUDDY_CREDENTIAL_PRELOAD}\nrequire(process.argv[1]);`, bundle.cli]
          : []),
        ...acpArguments,
        ...(serve ? ["--serve", "--host", "127.0.0.1", "--port", "0", "--auth", "password"] : []),
      ],
      childEnvironment,
      platform,
    ),
    environment: childEnvironment,
    ...(bundle ? { bundledCliPath: bundle.cli } : {}),
  };
}
