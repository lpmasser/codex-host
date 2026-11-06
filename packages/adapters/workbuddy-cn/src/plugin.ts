import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { createHarnessAdapter as createWorkBuddyAdapter } from "@codexhost/adapter-workbuddy/plugin";

export function createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter {
  return createWorkBuddyAdapter(context, "cn");
}
