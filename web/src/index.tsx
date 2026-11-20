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
      <div class="app">
        <aside class="sidebar">
          <div class="brand">
            <Logo />
            <span>tidybot</span>
          </div>
          <nav>
            <A href="/" classList={{ active: onPlans() }} end>
              <Icon name="plans" />
              Plans
              <Show when={openPlans()}>
                <span class="badge" title={`${openPlans()} waiting for review`}>
                  {openPlans()}
                </span>
              </Show>
            </A>
            <A href="/history">
              <Icon name="history" />
              History
            </A>
            <A href="/find">
              <Icon name="find" />
              Find
            </A>
            <A href="/setup">
              <Icon name="setup" />
              Setup
            </A>
          </nav>
          <Show when={status.latest?.project}>
            {(project) => (
              <div class="muted project" title={project()}>
                Project <b>{basename(project())}</b>
              </div>
            )}
          </Show>
        </aside>
        <div class="content">
          <Show when={(status.latest?.interrupted.length ?? 0) > 0 && props.location.pathname !== "/"}>
            <p class="warning">
              Some moves were cut off. Nothing can move or be undone until you check them.{" "}
              <a class="button" href="/">
                Check them
              </a>
            </p>
          </Show>
          <main>
            <ErrorText error={statusError()} />
            {/* With no status at all, the pages have nothing to show but "Loading…". */}
            <Show when={!statusError() || status.latest}>{props.children}</Show>
          </main>
        </div>
      </div>
    </AppContext.Provider>
  );
}

const ICONS = {
  plans: (
    <>
      <path d="M2.5 9.5 4.4 3.7a1 1 0 0 1 1-.7h5.2a1 1 0 0 1 1 .7l1.9 5.8V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
      <path d="M2.5 9.5h3l.7 1.5h3.6l.7-1.5h3" />
    </>
  ),
  history: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2 1.3" />
    </>
  ),
  find: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3.3 3.3" />
    </>
  ),
  setup: (
    <>
      <path d="M2.5 5h6m3 0h2m-11 6h2m3 0h6" />
      <circle cx="10" cy="5" r="1.5" />
      <circle cx="6" cy="11" r="1.5" />
    </>
  ),
};

/** A menu icon, drawn as a line in the color of the text around it. */
function Icon(props: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {ICONS[props.name]}
    </svg>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="logo-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#4aa3ff" />
          <stop offset="1" stop-color="#0a6cf0" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" fill="url(#logo-fill)" />
      <path d="M12 8.5V6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="12" cy="5.4" r="1.3" fill="#fff" />
      <rect x="3.4" y="11.6" width="2" height="3.8" rx="1" fill="#fff" />
      <rect x="18.6" y="11.6" width="2" height="3.8" rx="1" fill="#fff" />
      <rect x="6" y="8.5" width="12" height="10" rx="3.2" fill="#fff" />
      <circle cx="9.7" cy="12.8" r="1.35" fill="#0a6cf0" />
      <circle cx="14.3" cy="12.8" r="1.35" fill="#0a6cf0" />
      <path d="M10.2 15.9h3.6" fill="none" stroke="#0a6cf0" stroke-width="1.2" stroke-linecap="round" />
    </svg>
  );
}

function NoToken() {
  return (
    <main class="alone">
      <section class="box">
        <h1 class="brand">
          <Logo />
          <span>tidybot</span>
        </h1>
        <p>
          This page needs the session key. Open the link that <code>tidybot ui</code> printed in your terminal.
        </p>
      </section>
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
              No such page.{" "}
              <a class="button" href="/">
                Back to plans
              </a>
            </p>
          )}
        />
      </Router>
    </Show>
  ),
  root,
);
