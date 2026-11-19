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
      <p class="muted">The folders your files go to. Your agent reads the description of each place to decide what belongs there.</p>
      <AddPlace onAdded={changed} />
      <Loaded resource={places}>
        {(data) => (
          <>
            <Show when={data().places.length} fallback={<p class="empty">No places yet. Add the folders where you keep things, such as Bills or Photos.</p>}>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Folder</th>
                    <th>What goes there</th>
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
                            <td>{place.rule || <span class="muted">(no description: the agent goes by the name)</span>}</td>
                            <td class="actions">
                              <button type="button" onClick={() => setEditing(place.name)}>
                                Edit
                              </button>
                              <ConfirmButton
                                label="Remove"
                                question={`Remove ${place.name}? The folder and its files stay.`}
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
            <p class="muted small">
              {data().scope === "project" ? "Project places" : "Global places"}, saved in <PathText path={data().file} />
            </p>
          </>
        )}
      </Loaded>
    </>
  );
}

function AddPlace(props: { onAdded: () => void }) {
  const [open, setOpen] = createSignal(false);
  const add = createAction(
    (place: PlaceInfo) => api.places.add(place),
    () => {
      setOpen(false);
      props.onAdded();
    },
  );
  return (
    <Show
      when={open()}
      fallback={
        <button type="button" class="primary" onClick={() => setOpen(true)}>
          Add a place
        </button>
      }
    >
      <section class="box">
        <h2>Add a place</h2>
        <PlaceForm
          initial={{ name: "", path: "", rule: "" }}
          submitLabel="Add"
          pending={add.pending()}
          onSubmit={(p) => void add.run(p)}
          onCancel={() => setOpen(false)}
        />
        <ErrorText error={add.error()} />
      </section>
    </Show>
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
        Name{" "}
        <input
          type="text"
          required
          placeholder="Bills"
          value={name()}
          ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </label>
      <label>
        Folder <input type="text" required size={50} placeholder="~/Documents/Bills" value={path()} onInput={(e) => setPath(e.currentTarget.value)} />
      </label>
      <label>
        What goes there{" "}
        <textarea
          rows={2}
          cols={60}
          placeholder="In your words, such as: utility bills and receipts"
          value={rule()}
          onInput={(e) => setRule(e.currentTarget.value)}
        />
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
