import { A, Route, Router, type RouteSectionProps } from "@solidjs/router";
import { Show, createResource } from "solid-js";
import { render } from "solid-js/web";
import { api, hasToken } from "./api";
import { AppContext, type AppState } from "./app-context";
import { tildify } from "./format";
import { FindPage } from "./pages/Find";
import { HistoryPage } from "./pages/History";
import { OverviewPage } from "./pages/Overview";
import { PlacesPage } from "./pages/Places";
import { PlanPage } from "./pages/Plan";
import { PlansPage } from "./pages/Plans";
import { RulesPage } from "./pages/Rules";
import { SensitivePage } from "./pages/Sensitive";
import { SettingsPage } from "./pages/Settings";
import "./styles.css";

function Layout(props: RouteSectionProps) {
  const [status, { refetch }] = createResource(() => api.status());
  const app: AppState = {
    status,
    refreshStatus: () => void refetch(),
    tildify: (p) => tildify(p, status.latest?.userHome ?? ""),
  };
  const openPlans = () => status.latest?.openPlans.length ?? 0;
  return (
    <AppContext.Provider value={app}>
      <header class="top">
        <strong>tidybot</strong>
        <Show when={status.latest}>
          {(s) => (
            <span class="muted">
              v{s().version} · {s().project ? `project ${app.tildify(s().project ?? "")}` : "global settings"}
            </span>
          )}
        </Show>
        <nav>
          <A href="/" end>
            Overview
          </A>
          <A href="/plans">Plans{openPlans() ? ` (${openPlans()})` : ""}</A>
          <A href="/history">History</A>
          <A href="/find">Find</A>
          <A href="/places">Places</A>
          <A href="/rules">Rules</A>
          <A href="/sensitive">Sensitive files</A>
          <A href="/settings">Settings</A>
        </nav>
      </header>
      <Show when={(status.latest?.interrupted.length ?? 0) > 0}>
        <p class="warning">
          Some moves were interrupted and need attention. Moves and undo are blocked until they're resolved. <a href="/settings#recovery">Resolve them</a>
        </p>
      </Show>
      <main>{props.children}</main>
    </AppContext.Provider>
  );
}

function NoToken() {
  return (
    <main>
      <h1>tidybot</h1>
      <p>This page needs the session key. Open the link that <code>tidybot ui</code> printed in your terminal.</p>
    </main>
  );
}

const root = document.getElementById("app");
if (!root) throw new Error("#app is missing from index.html");

render(
  () => (
    <Show when={hasToken()} fallback={<NoToken />}>
      <Router root={Layout}>
        <Route path="/" component={OverviewPage} />
        <Route path="/plans" component={PlansPage} />
        <Route path="/plans/:id" component={PlanPage} />
        <Route path="/history" component={HistoryPage} />
        <Route path="/find" component={FindPage} />
        <Route path="/places" component={PlacesPage} />
        <Route path="/rules" component={RulesPage} />
        <Route path="/sensitive" component={SensitivePage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="*" component={() => <p>No such page. <a href="/">Overview</a></p>} />
      </Router>
    </Show>
  ),
  root,
);
