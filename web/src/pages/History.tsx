import type { PlanSummary } from "@contract";
import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { api } from "../api";
import { useApp } from "../app-context";
import { PlanFacts, UndoPlan } from "../components/plan-facts";
import { Loaded } from "../components/ui";
import { basename, planStatus } from "../format";

const PAGE = 20;

/** Newest first: by when the plan was applied, or proposed if it never was. */
const latest = (p: PlanSummary) => p.appliedAt ?? p.createdAt;

/**
 * Past plans, one card each, with the same facts and undo as on the start page and the plan's page.
 * Single files are put back from the plan's page.
 */
export function HistoryPage() {
  const app = useApp();
  const [plans] = createResource(
    () => app.status.latest,
    () => api.plans.list({ all: true }),
  );
  const past = createMemo(() => (plans.latest ?? []).filter((p) => p.state !== "open").sort((a, b) => latest(b).localeCompare(latest(a))));
  const [shown, setShown] = createSignal(PAGE);

  return (
    <>
      <h1>History</h1>
      <p class="muted">Plans you applied or discarded, newest first. To put back single files, open the plan.</p>
      <Loaded resource={plans}>
        {() => (
          <Show when={past().length} fallback={<p class="empty">No past plans yet. When you apply or discard a plan, it shows up here.</p>}>
            {/* By id, so a card (and the result of its undo) stays when the list reloads. */}
            <For
              each={past()
                .slice(0, shown())
                .map((p) => p.id)}
            >
              {(id) => (
                <Show when={past().find((p) => p.id === id)}>
                  {(p) => (
                    <section class="box">
                      <div class="head">
                        <h2>
                          Tidy {basename(p().source)} <span class="tag">{planStatus(p())}</span>
                        </h2>
                        <a class="button" href={`/plans/${id}`}>
                          Details
                        </a>
                      </div>
                      <PlanFacts plan={p()} />
                      <div class="row">
                        <UndoPlan planId={id} counts={p().counts} onUndone={app.refreshStatus} />
                      </div>
                    </section>
                  )}
                </Show>
              )}
            </For>
            <Show when={past().length > shown()}>
              <button type="button" onClick={() => setShown(shown() + PAGE)}>
                Show older plans
              </button>
            </Show>
          </Show>
        )}
      </Loaded>
    </>
  );
}
