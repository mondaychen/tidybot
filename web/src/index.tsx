import { A, Navigate, Route, Router, type RouteSectionProps } from "@solidjs/router";
import type { Status } from "@contract";
import { type Resource, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { api, hasToken } from "./api";
import { AppContext, type AppState } from "./app-context";
import { ErrorText, errorMessage } from "./components/ui";
import { basename, tildify } from "./format";
import { FindPage } from "./pages/Find";
import { HistoryPage } from "./pages/History";
import { HomePage } from "./pages/Home";
import { PlacesPage } from "./pages/Places";
import { PlanPage } from "./pages/Plan";
import { RulesPage } from "./pages/Rules";
import { SensitivePage } from "./pages/Sensitive";
import { SettingsPage } from "./pages/Settings";
import { SetupLayout } from "./pages/Setup";
import "./styles.css";

const STATUS_EVERY_MS = 5000;

function Layout(props: RouteSectionProps) {
  const [statusError, setStatusError] = createSignal<string>();
  // A resource with an error throws when it is read, which would stop the whole page. So a failed
  // call keeps the last status and shows its message above the page.
  const [loaded, { refetch }] = createResource<Status | undefined>(async (_, info) => {
    try {
      const next = await api.status();
      setStatusError(undefined);
      // The same object when nothing changed, so lists (and a question that is open) stay as they are.
      return info.value && JSON.stringify(info.value) === JSON.stringify(next) ? info.value : next;
    } catch (err) {
      setStatusError(errorMessage(err));
      return info.value;
    }
  });
  const status = loaded as Resource<Status>;

  // The agent changes plans through the CLI, so look again: every few seconds while the page is
  // visible, and when the user comes back to it.
  onMount(() => {
    const visible = () => document.visibilityState === "visible";
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (visible()) await refetch();
      timer = setTimeout(tick, STATUS_EVERY_MS);
    };
    timer = setTimeout(tick, STATUS_EVERY_MS);
    const onVisible = () => visible() && void refetch();
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    });
  });

  const app: AppState = {
    status,
    refreshStatus: () => void refetch(),
    tildify: (p) => tildify(p, status.latest?.userHome ?? ""),
  };
  const openPlans = () => status.latest?.openPlans.length ?? 0;
  // The plan pages belong to "Plans" in the menu.
  const onPlans = () => props.location.pathname === "/" || props.location.pathname.startsWith("/plans/");
  return (
    <AppContext.Provider value={app}>
      <header class="top">
        <strong class="brand">tidybot</strong>
        <nav>
          <A href="/" classList={{ active: onPlans() }} end>
            Plans
            <Show when={openPlans()}>
              <span class="badge" title={`${openPlans()} waiting for review`}>
                {openPlans()}
              </span>
            </Show>
          </A>
          <A href="/history">History</A>
          <A href="/find">Find</A>
          <A href="/setup">Setup</A>
        </nav>
        <Show when={status.latest?.project}>
          {(project) => (
            <span class="muted project" title={project()}>
              project: {basename(project())}
            </span>
          )}
        </Show>
      </header>
      <Show when={(status.latest?.interrupted.length ?? 0) > 0 && props.location.pathname !== "/"}>
        <p class="warning">
          Some moves were cut off. Nothing can move or be undone until you check them. <a href="/">Check them</a>
        </p>
      </Show>
      <main>
        <ErrorText error={statusError()} />
        {/* With no status at all, the pages have nothing to show but "Loading…". */}
        <Show when={!statusError() || status.latest}>{props.children}</Show>
      </main>
    </AppContext.Provider>
  );
}

function NoToken() {
  return (
    <main>
      <h1>tidybot</h1>
      <p>
        This page needs the session key. Open the link that <code>tidybot ui</code> printed in your terminal.
      </p>
    </main>
  );
}

const root = document.getElementById("app");
if (!root) throw new Error("#app is missing from index.html");

render(
  () => (
    <Show when={hasToken()} fallback={<NoToken />}>
      <Router root={Layout}>
        <Route path="/" component={HomePage} />
        <Route path="/plans/:id" component={PlanPage} />
        <Route path="/history" component={HistoryPage} />
        <Route path="/find" component={FindPage} />
        <Route path="/setup" component={SetupLayout}>
          <Route path="/" component={() => <Navigate href="/setup/places" />} />
          <Route path="/places" component={PlacesPage} />
          <Route path="/naming" component={RulesPage} />
          <Route path="/sensitive" component={SensitivePage} />
          <Route path="/more" component={SettingsPage} />
        </Route>
        <Route
          path="*"
          component={() => (
            <p>
              No such page. <a href="/">Back to plans</a>
            </p>
          )}
        />
      </Router>
    </Show>
  ),
  root,
);
