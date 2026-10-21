import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { harnessIdSchema } from "@codexhost/shared-contracts";

export type WorkBuddyDistribution = "global" | "cn";

// The international and China releases are separate products with their own
// authentication, services and native data root. Each is an independent Harness.
// Host-side overrides are keyed per release; only the spawned native CLI sees its
// single-product WORKBUDDY_CONFIG_DIR/CODEBUDDY_CONFIG_DIR.
export const WORKBUDDY_DISTRIBUTIONS = {
  global: {
    harnessId: harnessIdSchema.parse("workbuddy"),
    displayName: "WorkBuddy",
    commandEnvironmentVariable: "CODEXHOST_WORKBUDDY_COMMAND",
    configDirectoryEnvironmentVariable: "WORKBUDDY_CONFIG_DIR",
    dataFolderName: ".workbuddy-ai",
    endpoint: "https://www.workbuddy.ai",
    authenticationId: "workbuddy-desktop-ai",
  },
  cn: {
    harnessId: harnessIdSchema.parse("workbuddy-cn"),
    displayName: "WorkBuddy CN",
    commandEnvironmentVariable: "CODEXHOST_WORKBUDDYCN_COMMAND",
    configDirectoryEnvironmentVariable: "WORKBUDDYCN_CONFIG_DIR",
    dataFolderName: ".workbuddy",
    endpoint: "https://www.workbuddy.cn",
    authenticationId: "workbuddy-desktop",
  },
} as const;

const RELEASES = Object.keys(WORKBUDDY_DISTRIBUTIONS) as WorkBuddyDistribution[];

/** Product metadata shipped next to a native CLI script (`<package>/bin/codebuddy` → `<package>/product.json`). */
export function readWorkBuddyProduct(cliScript: string): unknown {
  const packageRoot = path.dirname(path.dirname(realpathSync(cliScript)));
  return JSON.parse(readFileSync(path.join(packageRoot, "product.json"), "utf8"));
}

function serviceOrigin(endpoint: unknown): string | undefined {
  if (typeof endpoint !== "string") return;
  try {
    // URL semantics: host case and trailing slashes do not change the declared service.
    return new URL(endpoint).origin;
  } catch {
    return;
  }
}

/**
 * Releases whose public identity a product file or snapshot declares: its native data folder,
 * service endpoint or authentication identity. A partial configuration without these fields,
 * or with an unrecognized custom service, declares no release.
 */
export function workBuddyReleasesDeclaredBy(product: unknown): WorkBuddyDistribution[] {
  if (product === null || typeof product !== "object") return [];
  const { dataFolderName, endpoint, authentication } = product as Record<string, unknown>;
  const service = serviceOrigin(endpoint);
  const authenticationId =
    authentication !== null && typeof authentication === "object"
      ? (authentication as Record<string, unknown>).id
      : undefined;
  return RELEASES.filter((release) => {
    const identity = WORKBUDDY_DISTRIBUTIONS[release];
    return (
      identity.dataFolderName === dataFolderName ||
      new URL(identity.endpoint).origin === service ||
      identity.authenticationId === authenticationId
    );
  });
}

/**
 * Product identity a configuration declares that is not `distribution`: the other release, or
 * a native data root of another product such as plain CodeBuddy's `.codebuddy`.
 */
export function foreignWorkBuddyProduct(
  product: unknown,
  distribution: WorkBuddyDistribution,
): WorkBuddyDistribution | "other" | undefined {
  const foreign = workBuddyReleasesDeclaredBy(product).find((release) => release !== distribution);
  if (foreign) return foreign;
  const dataFolderName =
    product !== null && typeof product === "object"
      ? (product as Record<string, unknown>).dataFolderName
      : undefined;
  return dataFolderName !== undefined &&
    dataFolderName !== WORKBUDDY_DISTRIBUTIONS[distribution].dataFolderName
    ? "other"
    : undefined;
}

/**
 * The release a native CLI belongs to, from its own product metadata. Both releases ship the
 * same `codebuddy` entry name, and installation folder names are not a reliable region marker.
 * Plain CodeBuddy declares neither release; contradictory metadata identifies none.
 */
export function workBuddyDistributionOf(
  cliScript: string,
  readProduct: (cliScript: string) => unknown = readWorkBuddyProduct,
): WorkBuddyDistribution | undefined {
  let product: unknown;
  try {
    product = readProduct(cliScript);
  } catch {
    // Missing or unreadable third-party metadata identifies no WorkBuddy release.
    return undefined;
  }
  const declared = workBuddyReleasesDeclaredBy(product);
  const release = declared.length === 1 ? declared[0] : undefined;
  return release && !foreignWorkBuddyProduct(product, release) ? release : undefined;
}
