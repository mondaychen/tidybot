import type { UndoResult } from "@contract";
import { For, Show, createSignal } from "solid-js";
import { api } from "../api";
import { useApp } from "../app-context";
import { UndoResultView } from "../components/results";
import { ConfirmButton, ErrorText, Loaded, PathText, createAction } from "../components/ui";
import { describeTrash, plural, relativeTime } from "../format";

export function OverviewPage() {
  const app = useApp();
  const [undone, setUndone] = createSignal<UndoResult>();
  const undoLast = createAction(
    () => api.history.undo({ last: true }),
    (result) => {
      setUndone(result);
      app.refreshStatus();
    },
  );

  return (
    <Loaded resource={app.status}>
      {(s) => (
        <>
          <h1>Overview</h1>
          <section class="box">
            <h2>Setup</h2>
            <dl>
              <dt>Settings</dt>
              <dd>
                <Show when={s().project} fallback="global">
                  {(project) => (
                    <>
                      project <PathText path={project()} />
                    </>
                  )}
                </Show>{" "}
                · state in <PathText path={s().home} />
              </dd>
              <dt>Folder to tidy</dt>
              <dd>
                <PathText path={s().source} />
              </dd>
              <dt>Places</dt>
              <dd>
                {s().places} <a href="/places">edit</a>
                <Show when={s().places === 0}>
                  {" "}
                  <span class="muted">(none yet: ask your agent to run `tidybot guide onboard`)</span>
                </Show>
              </dd>
              <dt>Rules</dt>
              <dd>
                {s().rules} · rename: {s().rename}
                {s().naming ? ` · naming: ${s().naming}` : ""} <a href="/rules">edit</a>
              </dd>
              <dt>Deleting</dt>
              <dd>{describeTrash(s().trash)}</dd>
            </dl>
          </section>

          <section class="box">
            <h2>Open plans</h2>
            <Show when={s().openPlans.length} fallback={<p class="muted">No open plans. Ask your agent to tidy a folder; its plan shows up here for review.</p>}>
              <ul>
                <For each={s().openPlans}>
                  {(p) => (
                    <li>
                      <a href={`/plans/${p.id}`}>{p.id}</a> · {p.pending}/{p.total} pending · <PathText path={p.source} /> ·{" "}
                      <span class="muted">{relativeTime(p.createdAt)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>

          <section class="box">
            <h2>Undo</h2>
            <p>
              {plural(s().undoableMoves, "move")} can be undone.{" "}
              <Show when={s().lastUndoablePlan}>{(id) => <>Latest plan: <a href={`/plans/${id()}`}>{id()}</a>. </>}</Show>
              <a href="/history">History</a>
            </p>
            <Show when={s().undoableMoves > 0}>
              <ConfirmButton
                label="Undo the last batch"
                question="Move the files of the last batch back?"
                confirmLabel="Undo"
                disabled={undoLast.pending()}
                onConfirm={() => void undoLast.run()}
              />
            </Show>
            <ErrorText error={undoLast.error()} />
            <Show when={undone()}>{(r) => <UndoResultView result={r()} />}</Show>
          </section>
        </>
      )}
    </Loaded>
  );
}
