import { For, Show, createResource, createSignal } from "solid-js";
import { api } from "../api";
import { Loaded, PathText } from "../components/ui";
import { dateTime, relativeTime } from "../format";

export function PlansPage() {
  const [all, setAll] = createSignal(false);
  // A source of `false` would stop the fetch, so wrap it.
  const [plans] = createResource(() => ({ all: all() }), (q) => api.plans.list(q));
  return (
    <>
      <h1>Plans</h1>
      <p class="muted">Your agent proposes a plan; you review and change it here, then apply it. Nothing moves before you apply.</p>
      <label>
        <input type="checkbox" checked={all()} onChange={(e) => setAll(e.currentTarget.checked)} /> Show finished and discarded plans
      </label>
      <Loaded resource={plans}>
        {(list) => (
          <Show when={list().length} fallback={<p class="muted">No plans{all() ? "" : " open"}.</p>}>
            <table>
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>State</th>
                  <th>Created</th>
                  <th>Folder</th>
                  <th>Pending</th>
                </tr>
              </thead>
              <tbody>
                <For each={list()}>
                  {(p) => (
                    <tr>
                      <td>
                        <a href={`/plans/${p.id}`}>{p.id}</a>
                      </td>
                      <td>
                        <span class={`tag ${p.state}`}>{p.state}</span>
                      </td>
                      <td title={dateTime(p.createdAt)}>{relativeTime(p.createdAt)}</td>
                      <td>
                        <PathText path={p.source} />
                      </td>
                      <td>
                        {p.pending}/{p.total}
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
