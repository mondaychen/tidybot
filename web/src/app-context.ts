import type { Status } from "@contract";
import { type Resource, createContext, useContext } from "solid-js";

/** App-wide state: the server's status, shown in the header and used by every page. */
export interface AppState {
  status: Resource<Status>;
  /** Reload the status, after anything that can change counts or plans. */
  refreshStatus: () => void;
  tildify: (path: string) => string;
}

export const AppContext = createContext<AppState>();

export function useApp(): AppState {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp() needs an <AppContext.Provider>");
  return app;
}
