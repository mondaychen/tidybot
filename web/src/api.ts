import type { contract } from "@contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";

const TOKEN_KEY = "tidybot.token";

/** The session token comes in the URL that `tidybot ui` opens (`#token=…`). Keep it for this tab
 * and take it out of the address bar. */
function readToken(): string | null {
  const fromUrl = /(?:^#|&)token=([^&]+)/.exec(location.hash)?.[1];
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // Storage can be off; the token still works until the tab reloads.
    }
    history.replaceState(history.state, "", location.pathname + location.search);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const token = readToken();
export const hasToken = () => token !== null;

/**
 * The typed client for the tidybot UI server, from the shared contract (type only: no schemas or
 * server code end up in the bundle). Failed calls reject with an ORPCError whose `code` is
 * tidybot's (for example `not_found`) and whose message is ready to show.
 */
export const api: ContractRouterClient<typeof contract> = createORPCClient(
  new RPCLink({
    url: `${location.origin}/api`,
    headers: () => ({ authorization: `Bearer ${token ?? ""}` }),
    fetch: (request, init) =>
      fetch(request, init).catch(() => {
        throw new Error("Can't reach the tidybot UI server. Is `tidybot ui` still running?");
      }),
  }),
);
