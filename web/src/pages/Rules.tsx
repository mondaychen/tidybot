import type { Config, ScalarKey } from "@contract";
import { For, Show, createEffect, createResource, createSignal, on } from "solid-js";
import { api } from "../api";
import { useApp } from "../app-context";
import { ConfirmButton, ErrorText, Loaded, ScopePicker, createAction, createScope } from "../components/ui";

export function RulesPage() {
  const app = useApp();
  const [scope, setScope] = createScope();
  const [config, { refetch: refetchConfig }] = createResource(() => api.config.get());
  const [rules, { refetch: refetchRules }] = createResource(() => api.rules.list());
  const changed = () => {
    void refetchConfig();
    void refetchRules();
    app.refreshStatus();
  };
  const set = createAction((key: ScalarKey, value: string) => api.config.set({ key, value, scope: scope() }), changed);
  const unset = createAction((key: ScalarKey) => api.config.unset({ key, scope: scope() }), changed);
  const add = createAction((text: string) => api.rules.add({ text, scope: scope() }), changed);
  const remove = createAction((position: number, from: "global" | "project") => api.rules.remove({ position, scope: from }), changed);

  return (
    <>
      <ScopePicker value={scope()} onChange={setScope} />

      <Loaded resource={config}>
        {(data) => (
          <Naming config={scope() === "global" ? data().global : data().config} pending={set.pending() || unset.pending()} onSet={(k, v) => void set.run(k, v)} onUnset={(k) => void unset.run(k)} />
        )}
      </Loaded>
      <ErrorText error={set.error() ?? unset.error()} />

      <section class="box">
        <h2>Rules</h2>
        <p class="muted">Instructions your agent follows for every file, in your words. Project rules are added to the global ones.</p>
        <Loaded resource={rules}>
          {(data) => (
            <For each={data().byScope}>
              {(group) => (
                <>
                  <h3>{group.scope === "project" ? "Project rules" : "Global rules"}</h3>
                  <Show when={group.rules.length} fallback={<p class="muted">(none)</p>}>
                    <ol>
                      <For each={group.rules}>
                        {(rule, i) => (
                          <li>
                            {rule}{" "}
                            <ConfirmButton
                              label="Remove"
                              question="Remove this rule?"
                              confirmLabel="Remove"
                              disabled={remove.pending()}
                              onConfirm={() => void remove.run(i() + 1, group.scope)}
                            />
                          </li>
                        )}
                      </For>
                    </ol>
                  </Show>
                </>
              )}
            </For>
          )}
        </Loaded>
        <ErrorText error={remove.error()} />
        <AddRule pending={add.pending()} onAdd={(text) => add.run(text)} />
        <ErrorText error={add.error()} />
      </section>
    </>
  );
}

function Naming(props: { config: Config; pending: boolean; onSet: (key: ScalarKey, value: string) => void; onUnset: (key: ScalarKey) => void }) {
  const [naming, setNaming] = createSignal(props.config.naming);
  // A new value from the server, or the other scope's value, replaces the draft.
  createEffect(on(() => props.config.naming, setNaming, { defer: true }));
  return (
    <section class="box">
      <h2>Naming</h2>
      <div class="stack">
        <label>
          Rename files{" "}
          <select value={props.config.rename} disabled={props.pending} onChange={(e) => props.onSet("rename", e.currentTarget.value)}>
            <option value="auto">auto: only unhelpful names and name conflicts</option>
            <option value="always">always: every file, using the naming style</option>
            <option value="off">off: never</option>
          </select>
        </label>
        <label>
          Extension of a renamed file{" "}
          <select value={props.config.extensionCase} disabled={props.pending} onChange={(e) => props.onSet("extensionCase", e.currentTarget.value)}>
            <option value="keep">keep as it is (.HEIC)</option>
            <option value="lower">lowercase (.heic)</option>
          </select>
        </label>
      </div>
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (naming().trim()) props.onSet("naming", naming().trim());
          else props.onUnset("naming");
        }}
      >
        <label>
          Naming style
          <textarea
            rows={2}
            cols={60}
            placeholder="e.g. YYYY-MM-DD first, lowercase, words separated by dashes"
            value={naming()}
            onInput={(e) => setNaming(e.currentTarget.value)}
          />
        </label>
        <div class="row">
          <button type="submit" class="primary" disabled={props.pending}>
            Save naming style
          </button>
          <button
            type="button"
            disabled={props.pending || !props.config.naming}
            onClick={() => {
              setNaming("");
              props.onUnset("naming");
            }}
          >
            Clear
          </button>
        </div>
      </form>
    </section>
  );
}

function AddRule(props: { pending: boolean; onAdd: (text: string) => Promise<unknown> }) {
  const [text, setText] = createSignal("");
  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text().trim()) return;
        if ((await props.onAdd(text().trim())) !== undefined) setText("");
      }}
    >
      <label>
        New rule
        <textarea
          rows={2}
          cols={60}
          placeholder="e.g. never move files with 'draft' in the name"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </label>
      <div>
        <button type="submit" class="primary" disabled={props.pending}>
          Add rule
        </button>
      </div>
    </form>
  );
}
