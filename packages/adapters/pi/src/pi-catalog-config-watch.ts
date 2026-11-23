import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** User-level files whose content decides Pi's Model catalog: endpoints, credentials, defaults. */
const CATALOG_FILES = ["models.json", "auth.json", "settings.json"] as const;
/** Editors save in several filesystem steps; read once they settle. */
const SETTLE_MS = 150;

async function fingerprint(agentDir: string): Promise<string> {
  const contents = await Promise.all(
    CATALOG_FILES.map((name) => readFile(path.join(agentDir, name), "utf8").catch(() => "")),
  );
  return JSON.stringify(contents);
}

/**
 * Calls `onChange` when the content of a catalog file in Pi's agent directory changes.
 * Rewrites with identical content, such as Pi persisting an unchanged setting, are ignored.
 * Returns the function that stops watching; a missing agent directory is not watched.
 */
export function watchPiCatalogConfig(agentDir: string, onChange: () => void): () => void {
  let known = fingerprint(agentDir);
  let timer: NodeJS.Timeout | undefined;
  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(agentDir, { persistent: false }, (_event, name) => {
      if (name && !(CATALOG_FILES as readonly string[]).includes(name.toString())) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const previous = known;
        known = fingerprint(agentDir);
        void Promise.all([previous, known]).then(([before, after]) => {
          if (before !== after) onChange();
        });
      }, SETTLE_MS);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return () => undefined;
    throw error;
  }
  watcher.on("error", () => watcher.close());
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
