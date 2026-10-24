import { For, Show, createResource, createSignal } from "solid-js";
import { api } from "../api";
import { Loaded, PathText } from "../components/ui";

export function FindPage() {
  const [text, setText] = createSignal("");
  const [includeMissing, setIncludeMissing] = createSignal(false);
  const [query, setQuery] = createSignal<{ query: string; includeMissing: boolean }>();
  const [hits] = createResource(query, (q) => api.find({ ...q, limit: 50 }));

  return (
    <>
      <h1>Find</h1>
      <p class="muted">Searches file summaries, keywords and names. Only files that have a summary can be found.</p>
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (text().trim()) setQuery({ query: text().trim(), includeMissing: includeMissing() });
        }}
      >
        <input type="search" size={40} placeholder="lease 2025" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
        <label>
          <input type="checkbox" checked={includeMissing()} onChange={(e) => setIncludeMissing(e.currentTarget.checked)} /> Include files whose location is unknown
        </label>
        <button type="submit" class="primary">
          Search
        </button>
      </form>
      <Show when={query()}>
        <Loaded resource={hits}>
          {(list) => (
            <Show when={list().length} fallback={<p class="muted">No matches.</p>}>
              <ul class="hits">
                <For each={list()}>
                  {(h) => (
                    <li class="box">
                      <div>
                        <Show when={h.paths.length} fallback={<span class="muted">(moved or unknown: {h.name})</span>}>
                          <For each={h.paths}>
                            {(p) => (
                              <div>
                                <PathText path={p} />
                              </div>
                            )}
                          </For>
                        </Show>
                      </div>
                      <p>{h.summary}</p>
                      <Show when={h.keywords.length}>
                        <p class="muted">keywords: {h.keywords.join(", ")}</p>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Loaded>
      </Show>
    </>
  );
}
