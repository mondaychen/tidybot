import type { ApplyResult, UndoResult } from "@contract";
import { For, Show } from "solid-js";
import { api } from "../api";
import { useApp } from "../app-context";
import { plural } from "../format";
import { ErrorText, PathText, createAction } from "./ui";

/** What an undo did, with a way to drop history entries that can't be undone. */
export function UndoResultView(props: { result: UndoResult; onForgotten?: () => void }) {
  const app = useApp();
  const forget = createAction(
    (id: string) => api.history.forget({ ids: [id] }),
    () => {
      app.refreshStatus();
      props.onForgotten?.();
    },
  );
  return (
    <div class="result">
      <p>{props.result.undone.length || props.result.failed.length ? `Put back ${plural(props.result.undone.length, "file")}.` : "Nothing to put back."}</p>
      <Show when={props.result.failed.length}>
        <p>Couldn't put back:</p>
        <ul>
          <For each={props.result.failed}>
            {(f) => (
              <li>
                <code>{f.id}</code>: {f.error}{" "}
                <button type="button" disabled={forget.pending()} onClick={() => void forget.run(f.id)} title="Drop this history entry; files stay where they are">
                  Forget entry
                </button>
              </li>
            )}
          </For>
        </ul>
        <ErrorText error={forget.error()} />
      </Show>
    </div>
  );
}

export function ApplyResultView(props: { result: ApplyResult }) {
  const toSystem = () => props.result.trashed.filter((t) => t.to === null).length;
  return (
    <div class="result">
      <p>
        Moved {plural(props.result.moved.length, "file")}.
        <Show when={props.result.trashed.length}>
          {" "}
          Deleted {plural(props.result.trashed.length, "file")}
          {toSystem() ? `; ${toSystem()} went to the system Trash, restore those from there` : ""}.
        </Show>
      </p>
      <Show when={props.result.failed.length}>
        <p>Failed:</p>
        <ul>
          <For each={props.result.failed}>
            {(f) => (
              <li>
                <PathText path={f.file} />: {f.error}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
