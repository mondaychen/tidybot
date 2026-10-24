import type { PlaceInfo } from "@contract";
import { For, Show, createResource, createSignal } from "solid-js";
import { api } from "../api";
import { useApp } from "../app-context";
import { ConfirmButton, ErrorText, Loaded, PathText, createAction } from "../components/ui";

export function PlacesPage() {
  const app = useApp();
  const [places, { refetch }] = createResource(() => api.places.list());
  const [editing, setEditing] = createSignal<string>();
  const changed = () => {
    setEditing(undefined);
    void refetch();
    app.refreshStatus();
  };
  const update = createAction((name: string, patch: Partial<PlaceInfo>) => api.places.update({ name, patch }), changed);
  const remove = createAction((name: string) => api.places.remove({ name }), changed);

  return (
    <>
      <h1>Places</h1>
      <p class="muted">Folders that files go to. Your agent reads each rule to decide what belongs where. Removing a place doesn't touch files on disk.</p>
      <Loaded resource={places}>
        {(data) => (
          <>
            <p>
              {data().scope === "project" ? "Project places" : "Global places"}, saved in <PathText path={data().file} />
            </p>
            <Show when={data().places.length} fallback={<p class="muted">No places yet.</p>}>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Folder</th>
                    <th>Rule</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <For each={data().places}>
                    {(place) => (
                      <Show
                        when={editing() === place.name}
                        fallback={
                          <tr>
                            <td>{place.name}</td>
                            <td>
                              <PathText path={place.path} />
                            </td>
                            <td>{place.rule || <span class="muted">(no rule)</span>}</td>
                            <td class="actions">
                              <button type="button" onClick={() => setEditing(place.name)}>
                                Edit
                              </button>
                              <ConfirmButton
                                label="Remove"
                                question={`Remove ${place.name}?`}
                                confirmLabel="Remove"
                                disabled={remove.pending()}
                                onConfirm={() => void remove.run(place.name)}
                              />
                            </td>
                          </tr>
                        }
                      >
                        <tr class="editor">
                          <td colSpan={4}>
                            <PlaceForm
                              initial={place}
                              submitLabel="Save"
                              pending={update.pending()}
                              onSubmit={(next) => void update.run(place.name, next)}
                              onCancel={() => setEditing(undefined)}
                            />
                          </td>
                        </tr>
                      </Show>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
            <ErrorText error={update.error() ?? remove.error()} />
          </>
        )}
      </Loaded>
      <AddPlace onAdded={changed} />
    </>
  );
}

function AddPlace(props: { onAdded: () => void }) {
  const [formKey, setFormKey] = createSignal(0);
  const add = createAction(
    (place: PlaceInfo) => api.places.add(place),
    () => {
      setFormKey(formKey() + 1);
      props.onAdded();
    },
  );
  return (
    <section class="box">
      <h2>Add a place</h2>
      {/* Re-created after each add, so the fields start empty. */}
      <For each={[formKey()]}>{() => <PlaceForm initial={{ name: "", path: "", rule: "" }} submitLabel="Add" pending={add.pending()} onSubmit={(p) => void add.run(p)} />}</For>
      <ErrorText error={add.error()} />
    </section>
  );
}

function PlaceForm(props: { initial: PlaceInfo; submitLabel: string; pending: boolean; onSubmit: (place: PlaceInfo) => void; onCancel?: () => void }) {
  const [name, setName] = createSignal(props.initial.name);
  const [path, setPath] = createSignal(props.initial.path);
  const [rule, setRule] = createSignal(props.initial.rule);
  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit({ name: name().trim(), path: path().trim(), rule: rule().trim() });
      }}
    >
      <label>
        Name <input type="text" required value={name()} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        Folder <input type="text" required size={50} placeholder="~/Documents/Bills" value={path()} onInput={(e) => setPath(e.currentTarget.value)} />
      </label>
      <label>
        Rule <textarea rows={2} cols={60} placeholder="What belongs here, in your words" value={rule()} onInput={(e) => setRule(e.currentTarget.value)} />
      </label>
      <div class="row">
        <button type="submit" class="primary" disabled={props.pending}>
          {props.submitLabel}
        </button>
        <Show when={props.onCancel}>
          {(cancel) => (
            <button type="button" onClick={() => cancel()()}>
              Cancel
            </button>
          )}
        </Show>
      </div>
    </form>
  );
}
