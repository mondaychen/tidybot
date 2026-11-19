import type { PlanSummary } from "@contract";
import { For, Show, createMemo, createResource } from "solid-js";
import { api } from "../api";
import { useApp } from "../app-context";
import { PlanFacts, UndoPlan } from "../components/plan-facts";
import { Recovery } from "../components/recovery";
import { Loaded } from "../components/ui";
import { basename, planStatus } from "../format";

/** The start page: what needs the user now (plans to review, cut-off moves), and the last plan applied. */
export function HomePage() {
  const app = useApp();
  return (
    <Loaded resource={app.status}>
      {(s) => (
        <>
          <Recovery />
          <Show when={s().places === 0}>
            <section class="box attention">
              <h2>Set up places first</h2>
              <p>
                Places are the folders your files go to. Ask your agent to set up tidybot (<code>tidybot guide onboard</code>), or{" "}
                <a href="/setup/places">add places yourself</a>.
              </p>
            </section>
          </Show>

          <h1>Plans to review</h1>
          <Show
            when={s().openPlans.length}
            fallback={
              <p class="empty">
                Nothing to review. Ask your agent to tidy a folder, such as <em>"tidy my Downloads"</em>. Its plan shows up here, and nothing moves until you
                apply it.
              </p>
            }
          >
            <div class="cards">
              <For each={s().openPlans}>
                {(p) => (
                  <a class="card" href={`/plans/${p.id}`}>
                    <strong>Tidy {basename(p.source)}</strong>
                    <PlanFacts plan={p} />
                    <span class="button primary">Review</span>
                  </a>
                )}
              </For>
            </div>
          </Show>

          <LastApplied />
        </>
      )}
    </Loaded>
  );
}

/** The plan applied last, with the same facts and undo as on History and on the plan's page. */
function LastApplied() {
  const app = useApp();
  // Reloads when the status changes: after an apply or an undo.
  const [plans] = createResource(
    () => app.status.latest,
    () => api.plans.list({ all: true }),
  );
  const last = createMemo(() =>
    (plans.latest ?? []).reduce<PlanSummary | undefined>(
      (best, p) => (p.appliedAt && (!best?.appliedAt || p.appliedAt > best.appliedAt) ? p : best),
      undefined,
    ),
  );
  return (
    <Show when={last()}>
      {(p) => (
        <section class="box">
          <h2>
            Last applied: <a href={`/plans/${p().id}`}>Tidy {basename(p().source)}</a> <span class="tag">{planStatus(p())}</span>
          </h2>
          <PlanFacts plan={p()} />
          <div class="row">
            <UndoPlan planId={p().id} counts={p().counts} onUndone={app.refreshStatus} />
          </div>
          <a href="/history">All past plans</a>
        </section>
      )}
    </Show>
  );
}
