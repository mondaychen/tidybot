import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import { api } from "../api";
import { Loaded, PathText } from "../components/ui";
import { basename } from "../format";

/** Wait this long after the last key before searching. */
const DEBOUNCE_MS = 250;

export function FindPage() {
  const [text, setText] = createSignal("");
  const [includeMissing, setIncludeMissing] = createSignal(false);
  const [query, setQuery] = createSignal<{ query: string; includeMissing: boolean }>();
  const [hits] = createResource(query, (q) => api.find({ ...q, limit: 50 }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const search = (now = false) => {
    clearTimeout(timer);
    const run = () => setQuery(text().trim() ? { query: text().trim(), includeMissing: includeMissing() } : undefined);
    if (now) run();
    else timer = setTimeout(run, DEBOUNCE_MS);
  };

  return (
    <>
      <h1>Find a file</h1>
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          search(true);
        }}
      >
        <input
          type="search"
          class="big"
          size={40}
          placeholder="What is it about? For example: lease 2025"
          aria-label="Search"
          value={text()}
          ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(e) => {
            setText(e.currentTarget.value);
            search();
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={includeMissing()}
            onChange={(e) => {
              setIncludeMissing(e.currentTarget.checked);
              search(true);
            }}
          />{" "}
          Also show files that are no longer where they were
        </label>
      </form>
      <p class="muted">Searches the summary and keywords your agent wrote for each file, and its name. Only files with a summary can be found.</p>
      <Show when={query()}>
        <Loaded resource={hits}>
          {(list) => (
            <Show when={list().length} fallback={<p class="empty">No matches. Try other words, or fewer.</p>}>
              <p class="muted">{list().length === 50 ? "The best 50 matches" : `${list().length} found`}</p>
              <ul class="hits">
                <For each={list()}>
                  {(h) => (
                    <li class="box">
                      <strong>{h.paths[0] ? basename(h.paths[0]) : h.name}</strong>
                      <Show when={h.paths.length} fallback={<div class="muted">Location unknown (moved or deleted)</div>}>
                        <For each={h.paths}>{(p) => <PathRow path={p} />}</For>
                      </Show>
                      <p>{h.summary}</p>
                      <Show when={h.keywords.length}>
                        <div class="tags">
                          <For each={h.keywords}>{(k) => <span class="tag">{k}</span>}</For>
                        </div>
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

function PathRow(props: { path: string }) {
  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard access: the path is on the page to select by hand.
    }
  };
  return (
    <div class="row tight">
      <PathText path={props.path} />
      <button type="button" class="link" onClick={() => void copy()}>
        {copied() ? "Copied" : "Copy path"}
      </button>
    </div>
  );
}
