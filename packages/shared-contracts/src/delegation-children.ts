import { z } from "zod";

import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";

/** Threads started from each parent with `delegate start`, read from Host-local Delegation records. */
export const DELEGATION_CHILDREN_METHOD = "codexhost/thread/delegation-children";
export const DELEGATION_CHILDREN_MAX_PARENTS = 100;

export const delegationChildrenParamsSchema = z.strictObject({
  threadIds: z.array(hostThreadIdSchema).min(1).max(DELEGATION_CHILDREN_MAX_PARENTS),
  /** Titles of native Codex children cost an official read each; ask only when showing them. */
  includeTitles: z.boolean().optional(),
});
export type DelegationChildrenParams = z.infer<typeof delegationChildrenParamsSchema>;

export const delegationChildStatusSchema = z.enum([
  "creating",
  "running",
  "completed",
  "failed",
  "interrupted",
]);
export type DelegationChildStatus = z.infer<typeof delegationChildStatusSchema>;

export const delegationChildSchema = z.strictObject({
  threadId: hostThreadIdSchema,
  harnessId: harnessIdSchema,
  status: delegationChildStatusSchema,
  title: z.string().max(4096).optional(),
});
export type DelegationChild = z.infer<typeof delegationChildSchema>;

export const delegationChildrenResultSchema = z.strictObject({
  /** One entry per requested parent, in request order; parents without children list none. */
  parents: z
    .array(
      z.strictObject({
        threadId: hostThreadIdSchema,
        children: z.array(delegationChildSchema),
      }),
    )
    .max(DELEGATION_CHILDREN_MAX_PARENTS),
});
export type DelegationChildrenResult = z.infer<typeof delegationChildrenResultSchema>;
