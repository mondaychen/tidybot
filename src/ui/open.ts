import { spawn } from "node:child_process";

/** Open a URL in the default browser. Best effort: the URL is printed anyway. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // No browser launcher here; the printed URL still works.
  }
}
