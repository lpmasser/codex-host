import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  accountProfilesResultSchema,
  type AccountProfilesParams,
  type AccountProfilesResult,
} from "@codexhost/shared-contracts";

/**
 * Profile selection and import are Adapter capabilities reached through the public plugin
 * contract. Thrown Adapter errors may echo credentials or file contents, so the RPC caller must
 * map them to a fixed error without the cause.
 */
export async function handleAccountProfiles(
  params: AccountProfilesParams,
  adapters: Iterable<HarnessAdapter>,
): Promise<AccountProfilesResult> {
  const accountProfiles = [...adapters].find(
    (adapter) => adapter.harnessId === params.harnessId,
  )?.accountProfiles;
  if (!accountProfiles) return { available: false, results: [] };
  if (params.action === "status") return { available: true, results: [] };
  return accountProfilesResultSchema.parse({
    available: true,
    results: await accountProfiles.importJson(params.content),
  });
}
