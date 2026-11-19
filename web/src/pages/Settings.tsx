import type { Config, PersonalKind, ScalarKey } from "@contract";
import { For, type JSX, Show, createEffect, createResource, createSignal, on } from "solid-js";
import { api } from "../api";
import { useApp } from "../app-context";
import { Collapsible, ConfirmButton, ErrorText, Loaded, ScopePicker, createAction, createFlash, createScope } from "../components/ui";
import { plural } from "../format";

type Editor = { kind: "text"; placeholder?: string } | { kind: "number" } | { kind: "switch" } | { kind: "personal" };

interface Setting {
  key: ScalarKey;
  label: string;
  help: string;
  editor: Editor;
}

/** The settings, in words, in the groups a person looks for them. Renaming is on the "Naming and rules" page. */
const GROUPS: { title: string; open: boolean; settings: Setting[] }[] = [
  {
    title: "Tidying",
    open: true,
    settings: [
      { key: "source", label: "Folder to tidy", help: "Used when you don't name a folder.", editor: { kind: "text", placeholder: "~/Downloads" } },
      {
        key: "olderThan",
        label: "Leave recent files alone",
        help: "Only tidy files older than this, such as 14d, 2w or 3m. Empty: tidy all files.",
        editor: { kind: "text", placeholder: "14d" },
      },
      { key: "skipOrganized", label: "Skip files that are already in a place", help: "", editor: { kind: "switch" } },
    ],
  },
  {
    title: "Deleting",
    open: true,
    settings: [
      {
        key: "allowDelete",
        label: "Let the agent suggest files to delete",
        help: "Such as extra copies. They go to the trash, and you approve each plan.",
        editor: { kind: "switch" },
      },
      {
        key: "trashDir",
        label: "Trash folder",
        help: "Empty: the system Trash. Files in a trash folder can be put back from History.",
        editor: { kind: "text", placeholder: "system Trash" },
      },
    ],
  },
  {
    title: "Privacy",
    open: true,
    settings: [
      {
        key: "maskPersonal",
        label: "Hide from the agent",
        help: "Replaced with a label in what the agent reads and in summaries.",
        editor: { kind: "personal" },
      },
    ],
  },
  {
    title: "Advanced",
    open: false,
    settings: [
      { key: "excerptChars", label: "Characters the agent reads per file", help: "", editor: { kind: "number" } },
      { key: "previewChars", label: "Characters per file in a scan", help: "", editor: { kind: "number" } },
      { key: "maxFiles", label: "Files per scan page", help: "", editor: { kind: "number" } },
      { key: "historyMaxMoves", label: "Changes kept in History", help: "0: no limit. Older changes can't be undone.", editor: { kind: "number" } },
      { key: "summariesMax", label: "File summaries kept", help: "0: no limit.", editor: { kind: "number" } },
    ],
  },
];

const PERSONAL: { kind: PersonalKind; label: string }[] = [
  { kind: "ssn", label: "Social security numbers" },
  { kind: "passport", label: "Passport numbers" },
  { kind: "id-card", label: "ID card numbers" },
  { kind: "card", label: "Payment card numbers" },
  { kind: "iban", label: "Bank account numbers (IBAN)" },
  { kind: "birthday", label: "Birth dates" },
  { kind: "email", label: "Email addresses" },
];

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
  const pending = () => set.pending() || unset.pending();

  return (
    <>
      <ScopePicker value={scope()} onChange={setScope} />
      <ErrorText error={set.error() ?? unset.error()} />
      <Loaded resource={config}>
        {(data) => (
          <For each={GROUPS}>
            {(group) => (
              <Collapsible class="box" open={group.open} title={<strong>{group.title}</strong>}>
                <div class="settings">
                  <For each={group.settings.filter((s) => data().keys.includes(s.key))}>
                    {(setting) => (
                      <SettingRow
                        setting={setting}
                        // A global change starts from the global value, not from the project's.
                        value={valueText(scope() === "global" ? data().global : data().config, setting.key)}
                        pending={pending()}
                        onSet={async (v) => (await set.run(setting.key, v)) !== undefined}
                        onUnset={async () => (await unset.run(setting.key)) !== undefined}
                      />
                    )}
                  </For>
                </div>
                <Show when={group.title === "Advanced"}>
                  <Maintenance />
                </Show>
              </Collapsible>
            )}
          </For>
        )}
      </Loaded>
    </>
  );
}

/** One setting. Switches and checkboxes save at once; text saves with Enter or Save. */
function SettingRow(props: { setting: Setting; value: string; pending: boolean; onSet: (value: string) => Promise<boolean>; onUnset: () => Promise<boolean> }) {
  const [draft, setDraft] = createSignal(props.value);
  const [saved, showSaved] = createFlash(2000);
  // A new value from the server (after a save or a reset) replaces the draft.
  createEffect(on(() => props.value, setDraft, { defer: true }));
  const save = async (value: string) => {
    const ok = await props.onSet(value);
    if (ok) showSaved("Saved");
    return ok;
  };
  const id = `setting-${props.setting.key}`;

  const editor = (): JSX.Element => {
    const e = props.setting.editor;
    if (e.kind === "switch") {
      return (
        <input
          id={id}
          type="checkbox"
          checked={props.value === "true"}
          disabled={props.pending}
          onChange={async (ev) => {
            const box = ev.currentTarget;
            if (!(await save(String(box.checked)))) box.checked = props.value === "true";
          }}
        />
      );
    }
    if (e.kind === "personal") {
      const chosen = () => new Set(props.value === "none" ? [] : props.value.split(","));
      const toggle = (kind: PersonalKind, on: boolean) => {
        const next = PERSONAL.map((p) => p.kind).filter((k) => (k === kind ? on : chosen().has(k)));
        void save(next.join(",") || "none");
      };
      return (
        <div class="checks">
          <For each={PERSONAL}>
            {(p) => (
              <label>
                <input type="checkbox" checked={chosen().has(p.kind)} disabled={props.pending} onChange={(ev) => toggle(p.kind, ev.currentTarget.checked)} />{" "}
                {p.label}
              </label>
            )}
          </For>
        </div>
      );
    }
    return (
      <form
        class="inline"
        onSubmit={(ev) => {
          ev.preventDefault();
          void save(draft());
        }}
      >
        <input
          id={id}
          type={e.kind === "number" ? "number" : "text"}
          min={e.kind === "number" ? 0 : undefined}
          // An empty number would be saved as 0. Use Reset to remove a value.
          required={e.kind === "number"}
          size={e.kind === "number" ? 8 : 36}
          placeholder={e.kind === "text" ? e.placeholder : undefined}
          value={draft()}
          onInput={(ev) => setDraft(ev.currentTarget.value)}
          onKeyDown={(ev) => ev.key === "Escape" && setDraft(props.value)}
        />
        <Show when={draft() !== props.value}>
          <button type="submit" class="primary" disabled={props.pending}>
            Save
          </button>
        </Show>
      </form>
    );
  };

  return (
    <div class="setting">
      <label for={id}>{props.setting.label}</label>
      <div>
        <div class="row tight">
          {editor()}
          <Show when={saved()}>{(m) => <span class="flash">{m()}</span>}</Show>
          <button
            type="button"
            class="link"
            disabled={props.pending}
            title="Remove this value here, so the global value or the default applies"
            onClick={() => void props.onUnset()}
          >
            Reset
          </button>
        </div>
        <Show when={props.setting.help}>
          <div class="muted">{props.setting.help}</div>
        </Show>
      </div>
    </div>
  );
}

function Maintenance() {
  const [message, setMessage] = createSignal<string>();
  const compact = createAction(
    () => api.maintenance.compact(),
    (r) => setMessage(`Dropped ${plural(r.droppedMoves, "change")} and ${plural(r.droppedSummaries, "summary", "summaries")}.`),
  );
  const prune = createAction(
    () => api.maintenance.prune(),
    (r) => setMessage(`Forgot ${plural(r.pruned, "old location")}.`),
  );
  return (
    <div class="maintenance">
      <h3>Clean up</h3>
      <div class="row">
        <ConfirmButton
          label="Trim history and summaries now"
          question="Drop what is over the limits above? Dropped changes can't be undone."
          confirmLabel="Trim"
          disabled={compact.pending()}
          onConfirm={() => void compact.run()}
        />
        <button type="button" disabled={prune.pending()} onClick={() => void prune.run()} title="Summaries are kept">
          Forget locations of missing files
        </button>
      </div>
      <ErrorText error={compact.error() ?? prune.error()} />
      <Show when={message()}>{(m) => <p class="result">{m()}</p>}</Show>
    </div>
  );
}
