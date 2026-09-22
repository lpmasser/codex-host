import type { AccountProfileImportEntry } from "@codexhost/shared-contracts";

/** Profile semantics and credentials belong to the concrete Adapter. */
export interface HarnessAccountProfiles {
  /** Called only for a new Thread. The Host persists the result before open(). */
  select(): Promise<string | undefined>;
  importJson(content: string): Promise<AccountProfileImportEntry[]>;
}
