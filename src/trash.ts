import trash from "trash";
import { TidyError } from "./errors.js";
import { contractHome, resolvePath } from "./paths.js";
import type { Config } from "./store/config.js";

/**
 * Where deleted files go. tidybot never deletes a file outright: it goes to the system Trash /
 * Recycle Bin (the `trash` package), or to a folder the user chose (`trashDir`), using the same
 * journaled move as everything else so it can be undone.
 */
export type TrashTarget = { kind: "system" } | { kind: "folder"; dir: string };

export type TrashStatus = { enabled: true; target: string } | { enabled: false; reason: string };

/** Why deleting is unavailable, or undefined when it's available. */
function disabledReason(config: Pick<Config, "allowDelete" | "trashDir">): string | undefined {
  if (!config.allowDelete) return "deleting is off (config allowDelete=false)";
  // Desktop trash on Linux varies by environment, so the user picks a folder there.
  if (!config.trashDir && process.platform === "linux") {
    return "on Linux, deleting needs a trash folder first: ask the user for one, then `tidybot config set trashDir <dir>`";
  }
  return undefined;
}

export function trashStatus(config: Pick<Config, "allowDelete" | "trashDir">): TrashStatus {
  const reason = disabledReason(config);
  if (reason) return { enabled: false, reason };
  return { enabled: true, target: config.trashDir ? contractHome(resolvePath(config.trashDir)) : "system" };
}

export function trashTarget(config: Pick<Config, "allowDelete" | "trashDir">): TrashTarget {
  const reason = disabledReason(config);
  if (reason) throw new TidyError(reason, "trash_disabled");
  return config.trashDir ? { kind: "folder", dir: resolvePath(config.trashDir) } : { kind: "system" };
}

/** Move one file to the system Trash. No globbing: brackets and stars in names are literal. */
export async function moveToSystemTrash(file: string): Promise<void> {
  await trash([file], { glob: false });
}
