import type { InterruptedOperation } from "@contract";
import { For, Show, createSignal } from "solid-js";
import { api } from "../api";
import { useApp } from "../app-context";
import { plural } from "../format";
import { ConfirmButton, ErrorText, PathText, createAction } from "./ui";

/** Moves that were cut off and that tidybot couldn't finish or roll back safely. Shown only when there are some. */
export function Recovery() {
  const app = useApp();
  const [done, setDone] = createSignal<string>();
  const recover = createAction(
    () => api.recover.run(),
    (r) => {
      setDone(r.resolved ? `Resolved ${plural(r.resolved, "move")}.` : "Nothing more could be resolved.");
      app.refreshStatus();
    },
  );
  const abandon = createAction(
    (id: string) => api.recover.abandon({ ids: [id] }),
    () => {
      setDone("Record dropped. The files were left as they are.");
      app.refreshStatus();
    },
  );
  const interrupted = (): InterruptedOperation[] => app.status()?.interrupted ?? [];

  return (
    <Show when={interrupted().length || done()}>
      <section class="box attention" id="recovery">
        <h2>Some moves were cut off</h2>
        <Show when={interrupted().length} fallback={<p class="result">{done()}</p>}>
          <p>
            tidybot can't tell if these files were moved. Until this is resolved, nothing else can move or be undone. Check where each file is now, then try
            again, or drop the record (the files are not touched).
          </p>
          <ul>
            <For each={interrupted()}>
              {(op) => (
                <li>
                  <PathText path={op.from} /> → {op.to ? <PathText path={op.to} /> : "system Trash"}
                  <Show when={op.backup}>
                    {(b) => (
                      <div class="muted">
                        A copy may be at <PathText path={b()} />
                      </div>
                    )}
                  </Show>{" "}
                  <ConfirmButton
                    label="Drop record"
                    question="Did you check that the file is where you want it?"
                    confirmLabel="Yes, drop it"
                    disabled={abandon.pending()}
                    onConfirm={() => void abandon.run(op.id)}
                  />
                </li>
              )}
            </For>
          </ul>
          <button type="button" class="primary" disabled={recover.pending()} onClick={() => void recover.run()}>
            Try again
          </button>
          <Show when={done()}>{(m) => <p class="result">{m()}</p>}</Show>
        </Show>
        <ErrorText error={recover.error() ?? abandon.error()} />
      </section>
    </Show>
  );
}
