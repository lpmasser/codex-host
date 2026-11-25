import { NATIVE_MODULE_CATALOG_UPDATED_EVENT } from "@codexhost/desktop-control/renderer-bindings";

type LogTags = { safe?: Record<string, unknown>; sensitive?: { error?: unknown } };
type DesktopLogger = { warning(message: string, tags?: LogTags): void };
type NativeCatalog = { documentUrl: string; complete: boolean; urls: readonly string[] };

const ERROR_NAMES = new Set([
  "AggregateError",
  "Error",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
]);
const STACK_LOCATION = /app:\/\/-\/assets\/(?:async\/)?[\w.-]+\.js:\d+:\d+/;
const KNOWN_ERROR =
  /^(?:Maximum call stack size exceeded|Maximum update depth exceeded|Cannot read properties of (?:undefined|null)|Invalid array length|Minified React error #\d{1,4})\b/;

function transcriptErrorDetails(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return { name: "NonError" };
  return {
    name: ERROR_NAMES.has(error.name) ? error.name : "Error",
    kind: error.message.match(KNOWN_ERROR)?.[0],
    frames: error.stack
      ?.split("\n", 10)
      .slice(1)
      .flatMap((line) => line.match(STACK_LOCATION)?.[0] ?? []),
    ...(error instanceof AggregateError && depth < 2
      ? {
          count: error.errors.length,
          errors: error.errors.slice(0, 4).map((inner) => transcriptErrorDetails(inner, depth + 1)),
        }
      : {}),
  };
}

export function logTranscriptCommitErrors(logger: DesktopLogger): () => void {
  const original = logger.warning;
  const warning: DesktopLogger["warning"] = function (this: DesktopLogger, message, tags) {
    if (message === "Transcript update failed" && tags?.safe?.updateType === "reset-commit") {
      try {
        const details = transcriptErrorDetails(tags.sensitive?.error);
        tags = {
          ...tags,
          safe: { ...tags.safe, codexhostTranscriptErrors: JSON.stringify(details) },
        };
      } catch {
        // Preserve the native warning if its exception cannot be summarized.
      }
    }
    return original.call(this, message, tags);
  };
  logger.warning = warning;
  return () => {
    if (logger.warning === warning) logger.warning = original;
  };
}

export function installRendererTranscriptDiagnostics(owner: Window): () => void {
  let disposed = false;
  let pending = false;
  let lastCatalog: NativeCatalog | undefined;
  let restore: (() => void) | undefined;
  const install = async (catalog: NativeCatalog) => {
    for (const url of catalog.urls) {
      if (!/^app:\/\/-\/assets\/[^/?#]+\.js$/.test(url)) continue;
      const entry = (await import(url).catch(() => null)) as {
        __webpack_require__?: { c?: { WFY2?: { exports?: { v?: DesktopLogger } } } };
      } | null;
      if (disposed) return;
      // In Codex Desktop 26.1117, the native logger flattens Errors before sending
      // warnings to the main process. Read the cached logger before that happens.
      const logger = entry?.__webpack_require__?.c?.WFY2?.exports?.v;
      if (logger && Object.getOwnPropertyDescriptor(logger, "warning")?.writable) {
        restore = logTranscriptCommitErrors(logger);
        owner.removeEventListener(NATIVE_MODULE_CATALOG_UPDATED_EVENT, refresh);
        return;
      }
    }
  };
  const refresh = (): void => {
    if (disposed || pending || restore || owner.document.readyState !== "complete") return;
    const catalog = Reflect.get(owner, "__codexhostLoadedModulesV1") as NativeCatalog | undefined;
    if (
      !catalog?.complete ||
      catalog.documentUrl !== owner.location.href ||
      catalog === lastCatalog
    )
      return;
    lastCatalog = catalog;
    pending = true;
    void install(catalog)
      .catch(() => undefined)
      .finally(() => {
        pending = false;
        // A new publication may have arrived during an import from the old catalog.
        refresh();
      });
  };
  owner.addEventListener("load", refresh, { once: true });
  owner.addEventListener(NATIVE_MODULE_CATALOG_UPDATED_EVENT, refresh);
  refresh();
  return () => {
    disposed = true;
    owner.removeEventListener("load", refresh);
    owner.removeEventListener(NATIVE_MODULE_CATALOG_UPDATED_EVENT, refresh);
    restore?.();
  };
}
