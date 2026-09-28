import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  accountProfilesParamsSchema,
  accountProfilesResultSchema,
  harnessIdSchema,
  jsonValueSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import type { HarnessAccountInspectionCache } from "./harness-accounts.js";

/** The import boundary owns validation, cache invalidation and credential-safe errors. */
export async function handleAccountProfiles(
  params: unknown,
  adapters: Iterable<HarnessAdapter>,
  inspections: HarnessAccountInspectionCache,
): Promise<JsonObject> {
  const input = accountProfilesParamsSchema.safeParse(params);
  if (!input.success) {
    return { error: { code: -32602, message: "Invalid account profile request" } };
  }
  try {
    const accountProfiles = [...adapters].find(
      (adapter) => adapter.harnessId === input.data.harnessId,
    )?.accountProfiles;
    if (!accountProfiles) return { result: { available: false, results: [] } };
    if (input.data.action === "status") return { result: { available: true, results: [] } };
    const result = accountProfilesResultSchema.parse({
      available: true,
      results: await accountProfiles.importJson(input.data.content),
    });
    if (result.results.some(({ status }) => status !== "failed")) {
      inspections.invalidate(harnessIdSchema.parse(input.data.harnessId));
    }
    return { result: jsonValueSchema.parse(result) };
  } catch {
    // Adapter and parser errors may echo tokens or file contents. Never forward them.
    return { error: { code: -32077, message: "Account profile operation failed" } };
  }
}
