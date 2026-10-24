import type { PlanItem, TrashStatus } from "@contract";

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

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [604800, "week"],
  ];
  let [div, name] = units[0] as [number, string];
  for (const u of units) if (s >= u[0]) [div, name] = u;
  const n = Math.floor(s / div);
  return `${n} ${name}${n === 1 ? "" : "s"} ago`;
}

export const dateTime = (iso: string) => new Date(iso).toLocaleString();

export const describeTrash = (t: TrashStatus) => (!t.enabled ? `off: ${t.reason}` : t.target === "system" ? "to the system Trash" : `to ${t.target}`);

export const isDone = (item: PlanItem) => item.status === "moved" || item.status === "trashed";

/** Where an item goes, in words. */
export function destinationLabel(item: PlanItem, home: string): string {
  if (item.delete) return "delete (to the trash)";
  if (!item.destination) return item.place ?? "—";
  if (item.place === null && item.destination === dirname(item.file)) return "rename in place";
  return `${item.place ?? "(custom folder)"}  ${tildify(item.destination, home)}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
