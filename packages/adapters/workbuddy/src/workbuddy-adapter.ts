import {
  CodeBuddyAdapter,
  type CodeBuddyAdapterOptions,
  type CodeBuddyInvocationFactory,
} from "@codexhost/adapter-codebuddy";
import type {
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { harnessInspectionSchema } from "@codexhost/shared-contracts";
import { workBuddyInvocation } from "./command.js";
import { workBuddyRuntimeProfile } from "./common.js";
import type { WorkBuddyDistribution } from "./distribution.js";
import {
  loadWorkBuddyProductModels,
  mergeWorkBuddyProductModels,
  type WorkBuddyProductModel,
} from "./product-models.js";

export type WorkBuddyAdapterOptions = Omit<
  CodeBuddyAdapterOptions,
  "profile" | "invocationFactory"
> & {
  productModels?: () => Promise<readonly WorkBuddyProductModel[]>;
  platform?: NodeJS.Platform;
  /** The existing `workbuddy` identity is the international release. */
  distribution?: WorkBuddyDistribution;
};

export class WorkBuddyAdapter extends CodeBuddyAdapter {
  readonly #productModels: () => Promise<readonly WorkBuddyProductModel[]>;

  constructor(options: WorkBuddyAdapterOptions = {}) {
    const {
      productModels,
      platform = process.platform,
      distribution = "global",
      ...codeBuddyOptions
    } = options;
    const environment = { ...(codeBuddyOptions.environment ?? process.env) };
    const profile = workBuddyRuntimeProfile(distribution);
    // Session, history copy, Fork and native child processes all start this release only.
    const invocation: CodeBuddyInvocationFactory = (invocationEnvironment, ephemeral, args) =>
      workBuddyInvocation(invocationEnvironment, ephemeral, { distribution }, args);
    super({
      ...codeBuddyOptions,
      profile: platform === "win32" ? { ...profile, allowUnlistedModelSelection: true } : profile,
      invocationFactory: invocation,
    });
    this.#productModels =
      platform === "win32"
        ? (productModels ?? (() => loadWorkBuddyProductModels(environment, distribution)))
        : async () => [];
  }

  override async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    const inspection = await super.inspect(input);
    if (inspection.status !== "ready") return inspection;
    const productModels = await this.#productModels().catch(() => []);
    if (productModels.length === 0) return inspection;
    return harnessInspectionSchema.parse({
      ...inspection,
      catalog: mergeWorkBuddyProductModels(inspection.catalog, productModels),
    });
  }

  override async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (
      input.kind === "create" &&
      input.executionPolicy === "unattended-full-access" &&
      input.permissionModeId &&
      input.permissionModeId !== "fullAccess"
    ) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "WorkBuddy: unattended execution requires native fullAccess permissions",
          retryable: false,
        },
      };
    }
    return super.open(input);
  }
}
