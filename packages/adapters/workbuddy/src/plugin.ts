import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { WorkBuddyAdapter } from "./workbuddy-adapter.js";
import { WORKBUDDY_COMMAND_CATALOG } from "./common.js";
import { workBuddyInvocation } from "./command.js";
import { WORKBUDDY_DISTRIBUTIONS, type WorkBuddyDistribution } from "./distribution.js";
import { CodeBuddyError } from "@codexhost/adapter-codebuddy";
import { createWorkBuddyInstallation } from "./installation.js";

export function createHarnessAdapter(
  context: HarnessPluginContext,
  distribution: WorkBuddyDistribution = "global",
) {
  const { harnessId, commandEnvironmentVariable } = WORKBUDDY_DISTRIBUTIONS[distribution];
  if (context.platform === "darwin" && context.managedRemoteHost) {
    const environment = {
      ...context.environment,
      ...(context.launchCommand ? { [commandEnvironmentVariable]: context.launchCommand } : {}),
    };
    return new BrokeredHarnessAdapter({
      sessionImport: true,
      accountCredits: false,
      harnessId,
      commandCatalog: WORKBUDDY_COMMAND_CATALOG,
      forwardDelegationEnvironment: true,
      environment: { ...context.environment },
      isInstalled: () => {
        try {
          workBuddyInvocation(environment, true, { distribution });
          return true;
        } catch (error) {
          return !(error instanceof CodeBuddyError && error.code === "notInstalled");
        }
      },
      ...(context.brokerDescriptorPath ? { descriptorPath: context.brokerDescriptorPath } : {}),
    });
  }
  const environment = {
    ...context.environment,
    ...(context.launchCommand ? { [commandEnvironmentVariable]: context.launchCommand } : {}),
  };
  return Object.assign(new WorkBuddyAdapter({ distribution, environment }), {
    installation: createWorkBuddyInstallation(environment, { distribution }),
  });
}
