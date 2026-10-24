import type { Config, InterruptedOperation, PersonalKind, ScalarKey } from "@contract";
import { For, type JSX, Show, createEffect, createResource, createSignal, on } from "solid-js";
import { api } from "../api";
import { useApp } from "../app-context";
import { ConfirmButton, ErrorText, Loaded, PathText, ScopePicker, createAction, createScope } from "../components/ui";
import { plural } from "../format";

type Editor = { kind: "text"; placeholder?: string } | { kind: "number" } | { kind: "choice"; options: string[] } | { kind: "personal" };

const KEYS: Record<ScalarKey, { help: string; editor: Editor }> = {
  source: { help: "Folder to tidy when none is given", editor: { kind: "text", placeholder: "~/Downloads" } },
  olderThan: { help: "Leave recent files alone, e.g. 14d, 2w, 3m (empty = off)", editor: { kind: "text", placeholder: "14d" } },
  skipOrganized: { help: "Skip files already inside a place when scanning", editor: { kind: "choice", options: ["true", "false"] } },
  rename: { help: "auto: only unhelpful names and conflicts; always: every file; off: never", editor: { kind: "choice", options: ["auto", "always", "off"] } },
  naming: { help: "Naming style for renames, in your words", editor: { kind: "text" } },
  extensionCase: { help: "keep: .HEIC stays; lower: .heic", editor: { kind: "choice", options: ["keep", "lower"] } },
  allowDelete: { help: "Let the agent propose files to delete (they go to the trash)", editor: { kind: "choice", options: ["true", "false"] } },
  trashDir: { help: "Folder for deleted files instead of the system Trash (empty = system). Moves there can be undone", editor: { kind: "text" } },
  maskPersonal: { help: "Personal data replaced with a label in what the agent sees and in summaries", editor: { kind: "personal" } },
  excerptChars: { help: "Characters of content read per file for the agent", editor: { kind: "number" } },
  previewChars: { help: "Characters of content per file in the compact scan", editor: { kind: "number" } },
  maxFiles: { help: "Files per scan page", editor: { kind: "number" } },
  historyMaxMoves: { help: "Moves kept in history (0 = unlimited). Older moves can't be undone", editor: { kind: "number" } },
  summariesMax: { help: "Summaries kept (0 = unlimited)", editor: { kind: "number" } },
};

const PERSONAL: PersonalKind[] = ["ssn", "passport", "id-card", "card", "iban", "birthday", "email"];

/** A setting's value as `config set` takes it. */
function valueText(config: Config, key: ScalarKey): string {
  if (key === "maskPersonal") return config.maskPersonal.join(",") || "none";
  return String(config[key]);
}

export function SettingsPage() {
  const app = useApp();
  const [scope, setScope] = createScope();
  const [config, { refetch }] = createResource(() => api.config.get());
  const changed = () => {
    void refetch();
    app.refreshStatus();
  };
  const set = createAction((key: ScalarKey, value: string) => api.config.set({ key, value, scope: scope() }), changed);
  const unset = createAction((key: ScalarKey) => api.config.unset({ key, scope: scope() }), changed);

  return (
    <>
      <h1>Settings</h1>
      <ScopePicker value={scope()} onChange={setScope} />
      <Loaded resource={config}>
        {(data) => (
          <section class="box">
            <h2>Values in effect</h2>
            <p class="muted">"Reset" removes the value from the chosen settings, so the global value or the default applies.</p>
            <table>
              <tbody>
                <For each={data().keys}>
                  {(key) => (
                    <ConfigRow
                      name={key}
                      value={valueText(data().config, key)}
                      pending={set.pending() || unset.pending()}
                      onSet={(v) => void set.run(key, v)}
                      onUnset={() => void unset.run(key)}
                    />
                  )}
                </For>
              </tbody>
            </table>
            <ErrorText error={set.error() ?? unset.error()} />
          </section>
        )}
      </Loaded>
      <Recovery />
      <Maintenance />
    </>
  );
}

function ConfigRow(props: { name: ScalarKey; value: string; pending: boolean; onSet: (value: string) => void; onUnset: () => void }) {
  const meta = KEYS[props.name];
  const [draft, setDraft] = createSignal(props.value);
  // A new value from the server (after Set or Reset) replaces the draft.
  createEffect(on(() => props.value, setDraft, { defer: true }));
  const editor = (): JSX.Element => {
    const e = meta.editor;
    if (e.kind === "choice") {
      return (
        <select value={draft()} onChange={(ev) => setDraft(ev.currentTarget.value)}>
          <For each={e.options}>{(o) => <option value={o}>{o}</option>}</For>
        </select>
      );
    }
    if (e.kind === "personal") {
      const chosen = () => new Set(draft() === "none" ? [] : draft().split(","));
      const toggle = (kind: PersonalKind, on: boolean) => {
        const next = PERSONAL.filter((k) => (k === kind ? on : chosen().has(k)));
        setDraft(next.join(",") || "none");
      };
      return (
        <span class="row">
          <For each={PERSONAL}>
            {(k) => (
              <label>
                <input type="checkbox" checked={chosen().has(k)} onChange={(ev) => toggle(k, ev.currentTarget.checked)} /> {k}
              </label>
            )}
          </For>
        </span>
      );
    }
    return (
      <input
        type={e.kind === "number" ? "number" : "text"}
        min={e.kind === "number" ? 0 : undefined}
        size={e.kind === "number" ? 8 : 40}
        placeholder={e.kind === "text" ? e.placeholder : undefined}
        value={draft()}
        onInput={(ev) => setDraft(ev.currentTarget.value)}
      />
    );
  };
  return (
    <tr>
      <th>
        <code>{props.name}</code>
      </th>
      <td>
        <div>{editor()}</div>
        <div class="muted">{meta.help}</div>
      </td>
      <td class="actions">
        <button type="button" class="primary" disabled={props.pending || draft() === props.value} onClick={() => props.onSet(draft())}>
          Set
        </button>
        <button
          type="button"
          disabled={props.pending}
          onClick={() => props.onUnset()}
        >
          Reset
        </button>
      </td>
    </tr>
  );
}

function Recovery() {
  const app = useApp();
  const [done, setDone] = createSignal<string>();
  const recover = createAction(
    () => api.recover.run(),
    (r) => {
      setDone(r.resolved ? `Resolved ${plural(r.resolved, "operation")}.` : "Nothing more to recover.");
      app.refreshStatus();
    },
  );
  const abandon = createAction(
    (id: string) => api.recover.abandon({ ids: [id] }),
    (r) => {
      setDone(`Abandoned ${r.map((o) => o.id).join(", ")}. Files were left as they are.`);
      app.refreshStatus();
    },
  );
  const interrupted = (): InterruptedOperation[] => app.status()?.interrupted ?? [];

  return (
    <section class="box" id="recovery">
      <h2>Interrupted moves</h2>
      <Show when={interrupted().length} fallback={<p class="muted">None. tidybot finishes or rolls back interrupted moves on its own.</p>}>
        <p>
          These moves or undos were cut off, and tidybot couldn't tell what to do safely. Check the files, then try again, or abandon the record (files are
          not touched).
        </p>
        <ul>
          <For each={interrupted()}>
            {(op) => (
              <li>
                <code>{op.id}</code>: <PathText path={op.from} /> → {op.to ? <PathText path={op.to} /> : "system Trash"}
                <Show when={op.backup}>{(b) => <div class="muted">A copy may be at <PathText path={b()} /></div>}</Show>{" "}
                <ConfirmButton
                  label="Abandon"
                  question="Have you checked these files? Abandon this record?"
                  confirmLabel="Abandon"
                  disabled={abandon.pending()}
                  onConfirm={() => void abandon.run(op.id)}
                />
              </li>
            )}
          </For>
        </ul>
        <button type="button" disabled={recover.pending()} onClick={() => void recover.run()}>
          Try recovery again
        </button>
      </Show>
      <ErrorText error={recover.error() ?? abandon.error()} />
      <Show when={done()}>{(m) => <p class="result">{m()}</p>}</Show>
    </section>
  );
}

function Maintenance() {
  const [message, setMessage] = createSignal<string>();
  const compact = createAction(
    () => api.maintenance.compact(),
    (r) => setMessage(`Dropped ${plural(r.droppedMoves, "move")} and ${plural(r.droppedSummaries, "summary record")}.`),
  );
  const prune = createAction(
    () => api.maintenance.prune(),
    (r) => setMessage(`Forgot ${plural(r.pruned, "stale location")}.`),
  );
  return (
    <section class="box">
      <h2>Maintenance</h2>
      <div class="row">
        <ConfirmButton
          label="Compact history and summaries"
          question="Apply historyMaxMoves and summariesMax now? Dropped moves can't be undone."
          confirmLabel="Compact"
          disabled={compact.pending()}
          onConfirm={() => void compact.run()}
        />
        <button type="button" disabled={prune.pending()} onClick={() => void prune.run()} title="Summaries are kept">
          Forget locations of missing files
        </button>
      </div>
      <ErrorText error={compact.error() ?? prune.error()} />
      <Show when={message()}>{(m) => <p class="result">{m()}</p>}</Show>
    </section>
  );
}
