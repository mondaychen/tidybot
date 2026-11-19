import type { PlanCounts, PlanItem, PlanState, TrashStatus } from "@contract";

/** Paths come from the server's OS, so both separators count. */
const SEP = /[\\/]/;

export const basename = (p: string) => p.split(SEP).at(-1) ?? p;

export const dirname = (p: string) => {
  const parts = p.split(SEP);
  return parts.length > 1 ? p.slice(0, p.length - (parts.at(-1)?.length ?? 0) - 1) : p;
};

/** `p` relative to `base`, or `p` itself when it isn't inside `base`. */
export function relative(p: string, base: string): string {
  if (p.startsWith(base) && SEP.test(p.charAt(base.length))) return p.slice(base.length + 1);
  return p;
}

/** Show the home directory as `~`. */
export function tildify(p: string, home: string): string {
  if (!home) return p;
  if (p === home) return "~";
  if (p.startsWith(home) && SEP.test(p.charAt(home.length))) return `~${p.slice(home.length)}`;
  return p;
}

/**
 * A point in time that reads the same on every page: "5 minutes ago" within the hour, "today, 16:20",
 * "yesterday, 16:20", then the date ("Oct 17"). Always with what happened then, such as "applied".
 */
export function when(iso: string, now = new Date()): string {
  const t = new Date(iso);
  const minutes = Math.floor((now.getTime() - t.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const time = t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(t)) / 86_400_000);
  if (days === 0) return `today, ${time}`;
  if (days === 1) return `yesterday, ${time}`;
  return t.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(t.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

export const dateTime = (iso: string) => new Date(iso).toLocaleString();

export const describeTrash = (t: TrashStatus) => (!t.enabled ? `off: ${t.reason}` : t.target === "system" ? "to the system Trash" : `to ${t.target}`);

export const isDone = (item: PlanItem) => item.status === "moved" || item.status === "trashed";

/** A guess the agent wasn't sure about, and that the user hasn't changed: worth a second look. */
export const UNSURE_BELOW = 0.6;
export const isUnsure = (item: PlanItem) =>
  item.status === "pending" && item.note !== "edited by user" && item.confidence !== undefined && item.confidence < UNSURE_BELOW;

/** Problems the user has to look at: the item can't be applied as it is, or it would clash with another file. */
export const needsAttention = (item: PlanItem) =>
  item.status === "invalid" || item.status === "failed" || (item.status === "pending" && (item.warnings ?? []).some((w) => w.startsWith("conflict:")));

/** A plan's state in words, the same on every page. */
export function planStatus(p: { state: PlanState; counts: PlanCounts }): string {
  const c = p.counts;
  if (p.state === "discarded") return "Discarded";
  if (p.state === "open") return "Waiting for review";
  const applied = c.moved + c.deleted + c.putBack;
  if (applied === 0) return "Nothing applied";
  if (c.putBack === applied) return "Undone";
  return c.putBack ? "Partly undone" : "Applied";
}

/** The words for each count. The same words name the groups on a plan's page. */
export const COUNT_WORDS = {
  attention: "need attention",
  toMove: "to move",
  toDelete: "to delete",
  moved: "moved",
  deleted: "deleted",
  putBack: "put back",
  left: "left where they are",
} as const satisfies Partial<Record<keyof PlanCounts, string>>;

/** "332 files: 284 moved, 20 deleted and 28 left where they are". The parts add up to the total. */
export function countsText(c: PlanCounts): string {
  const parts = (Object.keys(COUNT_WORDS) as (keyof typeof COUNT_WORDS)[]).filter((k) => c[k] > 0).map((k) => `${c[k]} ${COUNT_WORDS[k]}`);
  return `${plural(c.total, "file")}${parts.length ? `: ${listing(parts)}` : ""}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "a, b and c" */
export function listing(parts: string[]): string {
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
