import { NATIVE_MODULE_CATALOG_UPDATED_EVENT } from "@codexhost/desktop-control/renderer-bindings";

type LogTags = { safe?: Record<string, unknown>; sensitive?: { error?: unknown } };
type DesktopLogger = { warning(message: string, tags?: LogTags): void };
type NativeCatalog = { documentUrl: string; complete: boolean; urls: readonly string[] };

const ERROR_NAMES = new Set([
  "AbortError",
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
const MAX_LEAVES = 4;
const MAX_VISITED = 10_000;

function errorSummary(error: unknown) {
  if (!(error instanceof Error)) {
    const thenable = typeof (error as { then?: unknown } | null)?.then === "function";
    return { name: "NonError", type: thenable ? "thenable" : typeof error };
  }
  return {
    name: ERROR_NAMES.has(error.name) ? error.name : "Error",
    kind: error.message.match(KNOWN_ERROR)?.[0],
    frames: error.stack
      ?.split("\n", 10)
      .slice(1)
      .filter((line) => line.trimStart().startsWith("at "))
      .map((line) => line.match(STACK_LOCATION)?.[0] ?? "other"),
  };
}

function transcriptErrorDetails(error: unknown): unknown {
  const leaves: unknown[] = [];
  const pending: Array<[unknown, number]> = [[error, 0]];
  const expanded = new Set<AggregateError>();
  let visited = 0;
  let leafCount = 0;
  let maxDepth = 0;
  let truncated = false;
  for (let next = pending.pop(); next != null; next = pending.pop()) {
    if (visited++ >= MAX_VISITED) {
      truncated = true;
      break;
    }
    const [current, depth] = next;
    maxDepth = Math.max(maxDepth, depth);
    if (current instanceof AggregateError && current.errors.length > 0 && !expanded.has(current)) {
      expanded.add(current);
      for (const inner of [...current.errors].reverse()) pending.push([inner, depth + 1]);
      continue;
    }
    leafCount += 1;
    if (leaves.length < MAX_LEAVES) leaves.push({ depth, ...errorSummary(current) });
  }
  return {
    ...errorSummary(error),
    maxDepth,
    leafCount,
    leaves,
    ...(truncated ? { truncated } : {}),
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
