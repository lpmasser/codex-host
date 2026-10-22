import type { DelegationStartInput } from "./delegation-types.js";

export function delegationTitle(
  input: Pick<DelegationStartInput, "taskName" | "task">,
  parent?: { title?: string },
): string {
  const taskName = (input.taskName ?? input.task.trim().split(/\r?\n/u)[0] ?? input.task)
    .replace(/\s+/gu, " ")
    .trim();
  const subtask = taskName.slice(0, 120).replace(/[\uD800-\uDBFF]$/u, "");
  if (!parent) return subtask;
  const parentTitle = (parent.title?.trim() || "Untitled Thread").replace(/\s+/gu, " ");
  return `${subtask} · ${parentTitle.slice(0, 200 - subtask.length - 3).replace(/[\uD800-\uDBFF]$/u, "")}`;
}

/** Bound notification suffixes without rewriting saved Thread titles or watch records. */
export function threadWatchLabel(title: string | undefined, threadId: string): string {
  if (!title) return threadId;
  const separator = " · ";
  const index = title.indexOf(separator);
  if (index < 0) return title;
  const suffix = Array.from(title.slice(index + separator.length));
  return suffix.length > 20
    ? `${title.slice(0, index)}${separator}${suffix.slice(0, 20).join("")}…`
    : title;
}
