import { harnessModelRefKey, type HarnessConfigurationState } from "@codexhost/shared-contracts";

type ThreadModelConfiguration = Pick<
  HarnessConfigurationState,
  "effectiveModel" | "effectiveThinkingOptionId" | "resolvedModelLabel" | "availableThinkingOptions"
> & { restoredModelLabel?: string | undefined };

export function threadModelProjection(
  provider: string,
  configuration: ThreadModelConfiguration,
  {
    fallbackModel,
    selectThinking,
  }: { fallbackModel?: string; selectThinking?: boolean | undefined } = {},
) {
  const model = configuration.effectiveModel
    ? harnessModelRefKey(configuration.effectiveModel)
    : fallbackModel;
  const selection = model
    ? {
        provider,
        model,
        ...(configuration.effectiveThinkingOptionId
          ? { reasoningEffort: configuration.effectiveThinkingOptionId }
          : {}),
      }
    : null;
  const restoredLabel = configuration.restoredModelLabel;
  const resolvedLabel = configuration.resolvedModelLabel;
  const thinkingOptions = configuration.availableThinkingOptions?.flatMap(({ id, label }) =>
    selectThinking === false ? [] : [{ id, name: label }],
  );
  return {
    lastUsed: selection,
    next: selection,
    ...(selection && (restoredLabel || resolvedLabel || thinkingOptions)
      ? {
          currentModelDisplay: {
            ...(restoredLabel ? { restoredLabel } : {}),
            ...(resolvedLabel ? { resolvedLabel } : {}),
            ...(thinkingOptions ? { thinkingOptions } : {}),
          },
        }
      : {}),
  };
}
