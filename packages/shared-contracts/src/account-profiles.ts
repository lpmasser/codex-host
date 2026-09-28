import { z } from "zod";

export const ACCOUNT_PROFILES_METHOD = "codexhost/harness/account-profiles";
export const ACCOUNT_PROFILE_IMPORT_MAX_BYTES = 1_048_576;

/** File contents are transient input; responses contain metadata only. */
export const accountProfilesParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), harnessId: z.literal("antigravity") }).strict(),
  z
    .object({
      action: z.literal("import"),
      harnessId: z.literal("antigravity"),
      content: z.string().min(1).max(ACCOUNT_PROFILE_IMPORT_MAX_BYTES),
    })
    .strict(),
]);
export type AccountProfilesParams = z.infer<typeof accountProfilesParamsSchema>;

export const accountProfileImportEntrySchema = z
  .object({
    label: z.string().max(320),
    status: z.enum(["imported", "updated", "failed"]),
    error: z
      .enum([
        "invalidEntry",
        "conflictingEntries",
        "authenticationFailed",
        "identityMismatch",
        "profileBusy",
        "writeFailed",
      ])
      .optional(),
  })
  .strict();
export type AccountProfileImportEntry = z.infer<typeof accountProfileImportEntrySchema>;

export const accountProfilesResultSchema = z
  .object({
    available: z.boolean(),
    results: z.array(accountProfileImportEntrySchema),
  })
  .strict();
export type AccountProfilesResult = z.infer<typeof accountProfilesResultSchema>;
