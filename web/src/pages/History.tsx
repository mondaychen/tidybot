import type { Move, UndoResult } from "@contract";
import { For, Show, createResource, createSignal } from "solid-js";
import { api } from "../api";
import { useApp } from "../app-context";
import { UndoResultView } from "../components/results";
import { ConfirmButton, ErrorText, Loaded, PathText, createAction } from "../components/ui";
import { dateTime, dirname, plural, relativeTime } from "../format";

/** Only active moves into a folder can be undone; the system Trash restores its own files. */
const undoable = (m: Move) => m.state === "active" && m.to !== null;

export function HistoryPage() {
  const app = useApp();
  const [all, setAll] = createSignal(false);
  const [planId, setPlanId] = createSignal("");
  const query = () => ({ all: all(), planId: planId().trim() || undefined });
  const [moves, { refetch }] = createResource(query, (q) => api.history.list(q));
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [undone, setUndone] = createSignal<UndoResult>();

  const changed = () => {
    setSelected(new Set<string>());
    void refetch();
    app.refreshStatus();
  };
  const undo = createAction(
    (sel: { ids: string[] } | { last: true }) => api.history.undo(sel),
    (r) => {
      setUndone(r);
      changed();
    },
  );
  const forget = createAction((ids: string[]) => api.history.forget({ ids }), changed);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected());
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  const chosen = () => [...selected()];

  return (
    <>
      <h1>History</h1>
      <p class="muted">Every move tidybot made. Undo puts files back where they were, with their original names.</p>
      <div class="row">
        <label>
          <input type="checkbox" checked={all()} onChange={(e) => setAll(e.currentTarget.checked)} /> Include undone and forgotten
        </label>
        <label>
          Plan <input type="text" size={22} placeholder="any" value={planId()} onChange={(e) => setPlanId(e.currentTarget.value)} />
        </label>
      </div>
      <div class="row">
        <ConfirmButton
          label={`Undo selected (${selected().size})`}
          question={`Move ${plural(selected().size, "file")} back?`}
          confirmLabel="Undo"
          disabled={selected().size === 0 || undo.pending()}
          onConfirm={() => void undo.run({ ids: chosen() })}
        />
        <ConfirmButton
          label="Undo the last batch"
          question="Move the files of the last batch back?"
          confirmLabel="Undo"
          disabled={undo.pending() || (app.status()?.undoableMoves ?? 0) === 0}
          onConfirm={() => void undo.run({ last: true })}
        />
        <ConfirmButton
          label={`Forget selected (${selected().size})`}
          question="Drop these entries? They can't be undone after that. Files stay where they are."
          confirmLabel="Forget"
          disabled={selected().size === 0 || forget.pending()}
          onConfirm={() => void forget.run(chosen())}
        />
      </div>
      <ErrorText error={undo.error() ?? forget.error()} />
      <Show when={undone()}>{(r) => <UndoResultView result={r()} onForgotten={changed} />}</Show>

      <Loaded resource={moves}>
        {(list) => (
          <Show when={list().length} fallback={<p class="muted">No moves recorded.</p>}>
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Id</th>
                  <th>When</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Plan</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                <For each={list()}>
                  {(m) => (
                    <tr>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${m.id}`}
                          disabled={m.state !== "active"}
                          checked={selected().has(m.id)}
                          onChange={(e) => toggle(m.id, e.currentTarget.checked)}
                        />
                      </td>
                      <td>
                        <code>{m.id}</code>
                      </td>
                      <td title={dateTime(m.at)}>{relativeTime(m.at)}</td>
                      <td>
                        <PathText path={m.from} />
                      </td>
                      <td>
                        {m.to === null ? (
                          "system Trash"
                        ) : (
                          <>
                            <PathText path={dirname(m.to)} />
                            {m.trash ? " (trash folder)" : ""}
                          </>
                        )}
                      </td>
                      <td>{m.planId ? <a href={`/plans/${m.planId}`}>{m.planId}</a> : "—"}</td>
                      <td>
                        <span class={`tag ${m.state}`}>{m.state}</span>
                        <Show when={m.state === "active" && !undoable(m)}>
                          <span class="muted"> (restore from the Trash)</span>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        )}
      </Loaded>
    </>
  );
}
