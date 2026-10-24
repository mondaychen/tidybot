import type { ApplyPreview, ApplyResult, PlaceInfo, Plan, PlanItem, PlanTarget, UndoResult } from "@contract";
import { useParams } from "@solidjs/router";
import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { api } from "../api";
import { useApp } from "../app-context";
import { ApplyResultView, UndoResultView } from "../components/results";
import { ConfirmButton, ErrorText, Loaded, PathText, createAction } from "../components/ui";
import { basename, dateTime, describeTrash, destinationLabel, isDone, plural, relative } from "../format";

type Filter = "all" | "review" | "pending" | "skipped" | "invalid" | "failed" | "done";

const FILTERS: { value: Filter; label: string; test: (i: PlanItem) => boolean }[] = [
  { value: "all", label: "All", test: () => true },
  { value: "review", label: "To review (pending, invalid, failed)", test: (i) => ["pending", "invalid", "failed"].includes(i.status) },
  { value: "pending", label: "Pending", test: (i) => i.status === "pending" },
  { value: "skipped", label: "Skipped", test: (i) => i.status === "skipped" },
  { value: "invalid", label: "Invalid", test: (i) => i.status === "invalid" },
  { value: "failed", label: "Failed", test: (i) => i.status === "failed" },
  { value: "done", label: "Done (moved or deleted)", test: isDone },
];

export function PlanPage() {
  const params = useParams<{ id: string }>();
  const app = useApp();
  const [plan, { mutate }] = createResource(() => params.id, (id) => api.plans.get({ id }));
  const [places] = createResource(() => api.places.list());

  /** After a change: show the plan the server sent back, and update the counts in the header. */
  const updated = (p: Plan) => {
    mutate(p);
    app.refreshStatus();
  };

  return (
    <Loaded resource={plan}>
      {(p) => <PlanView plan={p()} places={places.latest?.places ?? []} onChange={updated} />}
    </Loaded>
  );
}

function PlanView(props: { plan: Plan; places: PlaceInfo[]; onChange: (plan: Plan) => void }) {
  const app = useApp();
  const [filter, setFilter] = createSignal<Filter>("all");
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = createSignal<string>();

  const editable = (i: PlanItem) => !props.plan.discarded && !isDone(i);
  const visible = createMemo(() => {
    const test = FILTERS.find((f) => f.value === filter())?.test ?? (() => true);
    return props.plan.items.filter(test);
  });
  const selectable = () => visible().filter(editable);
  /** Selected files that are still in the plan and can change. */
  const selection = () => props.plan.items.filter((i) => editable(i) && selected().has(i.file)).map((i) => i.file);
  const counts = createMemo(() => {
    const c = new Map<string, number>();
    for (const i of props.plan.items) c.set(i.status, (c.get(i.status) ?? 0) + 1);
    return [...c.entries()];
  });

  const toggle = (file: string, on: boolean) => {
    const next = new Set(selected());
    if (on) next.add(file);
    else next.delete(file);
    setSelected(next);
  };

  const done = (p: Plan) => {
    props.onChange(p);
    setEditing(undefined);
    setSelected(new Set<string>());
  };
  const retarget = createAction((files: string[], target: PlanTarget) => api.plans.retarget({ planId: props.plan.id, files, target }), done);
  const skip = createAction((files: string[]) => api.plans.skip({ planId: props.plan.id, files }), done);
  const discard = createAction(() => api.plans.discard({ planId: props.plan.id }), done);

  const hasDone = () => props.plan.items.some(isDone);
  const trashEnabled = () => app.status()?.trash.enabled ?? false;

  return (
    <>
      <h1>
        Plan {props.plan.id} <span class={`tag ${props.plan.state}`}>{props.plan.state}</span>
      </h1>
      <p>
        Folder <PathText path={props.plan.source} /> · created <span title={dateTime(props.plan.createdAt)}>{dateTime(props.plan.createdAt)}</span> ·{" "}
        {counts()
          .map(([status, n]) => `${n} ${status}`)
          .join(", ")}
      </p>

      <section class="box">
        <h2>Actions</h2>
        <div class="row">
          <Show when={!props.plan.discarded}>
            <ApplyPanel plan={props.plan} onApplied={done} />
          </Show>
          <Show when={hasDone()}>
            <UndoPlanButton planId={props.plan.id} />
          </Show>
          <Show when={!props.plan.discarded}>
            <ConfirmButton
              label="Discard plan"
              question="Discard this plan? Nothing moves, and it can't be applied later."
              confirmLabel="Discard"
              disabled={discard.pending()}
              onConfirm={() => void discard.run()}
            />
          </Show>
        </div>
        <ErrorText error={discard.error()} />
      </section>

      <section class="box">
        <h2>Files</h2>
        <div class="row">
          <label>
            Show{" "}
            <select value={filter()} onChange={(e) => setFilter(FILTERS.find((f) => f.value === e.currentTarget.value)?.value ?? "all")}>
              <For each={FILTERS}>{(f) => <option value={f.value}>{f.label}</option>}</For>
            </select>
          </label>
          <span class="muted">
            {visible().length} of {props.plan.items.length} shown
          </span>
        </div>

        <Show when={selection().length}>
          <BulkBar
            count={selection().length}
            places={props.places}
            trashEnabled={trashEnabled()}
            pending={retarget.pending() || skip.pending()}
            onTarget={(target) => void retarget.run(selection(), target)}
            onSkip={() => void skip.run(selection())}
            onClear={() => setSelected(new Set<string>())}
          />
        </Show>
        <ErrorText error={retarget.error() ?? skip.error()} />

        <table class="items">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all shown"
                  disabled={selectable().length === 0}
                  checked={selectable().length > 0 && selectable().every((i) => selected().has(i.file))}
                  onChange={(e) => setSelected(new Set(e.currentTarget.checked ? selectable().map((i) => i.file) : []))}
                />
              </th>
              <th>Status</th>
              <th>File</th>
              <th>Goes to</th>
              <th>New name</th>
              <th>Why</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <For each={visible()}>
              {(item) => (
                <>
                  <tr class={`status-${item.status}`}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${basename(item.file)}`}
                        disabled={!editable(item)}
                        checked={selected().has(item.file)}
                        onChange={(e) => toggle(item.file, e.currentTarget.checked)}
                      />
                    </td>
                    <td>
                      <span class={`tag ${item.status}`}>{item.status}</span>
                    </td>
                    <td>
                      <code title={item.file}>{relative(item.file, props.plan.source)}</code>
                    </td>
                    <td>{destinationLabel(item, app.status()?.userHome ?? "")}</td>
                    <td>{item.newName ? <code>{item.newName}</code> : <span class="muted">—</span>}</td>
                    <td>
                      <ItemNotes item={item} />
                    </td>
                    <td class="actions">
                      <Show when={editable(item)}>
                        <button type="button" onClick={() => setEditing(editing() === item.file ? undefined : item.file)}>
                          {editing() === item.file ? "Close" : "Change"}
                        </button>
                        <Show when={item.status !== "skipped"}>
                          <button type="button" disabled={skip.pending()} onClick={() => void skip.run([item.file])} title="Leave this file where it is">
                            Skip
                          </button>
                        </Show>
                      </Show>
                      <Show when={item.operationId}>
                        <a href="/history">history</a>
                      </Show>
                    </td>
                  </tr>
                  <Show when={editing() === item.file}>
                    <tr class="editor">
                      <td colSpan={7}>
                        <ItemEditor
                          item={item}
                          places={props.places}
                          trashEnabled={trashEnabled()}
                          pending={retarget.pending()}
                          onSave={(target) => void retarget.run([item.file], target)}
                          onCancel={() => setEditing(undefined)}
                        />
                      </td>
                    </tr>
                  </Show>
                </>
              )}
            </For>
          </tbody>
        </table>
      </section>

      <Show when={props.plan.context}>
        {(ctx) => (
          <details class="box">
            <summary>Settings when the agent proposed this plan ({dateTime(ctx().recordedAt)})</summary>
            <p>
              Rename: {ctx().rename}
              {ctx().naming ? ` · naming: ${ctx().naming}` : ""}
              {ctx().extensionCase === "lower" ? " · extensions: lowercase" : ""}
            </p>
            <Show when={ctx().rules.length}>
              <p>Rules:</p>
              <ul>
                <For each={ctx().rules}>{(r) => <li>{r}</li>}</For>
              </ul>
            </Show>
            <p>Places:</p>
            <ul>
              <For each={ctx().places}>
                {(pl) => (
                  <li>
                    {pl.name} → <PathText path={pl.path} />
                    {pl.rule ? ` (${pl.rule})` : ""}
                  </li>
                )}
              </For>
            </ul>
          </details>
        )}
      </Show>
    </>
  );
}

function ItemNotes(props: { item: PlanItem }) {
  return (
    <div class="notes">
      <Show when={props.item.confidence !== undefined}>
        <span class="muted">{Math.round((props.item.confidence ?? 0) * 100)}%</span>{" "}
      </Show>
      <Show when={props.item.reason}>
        <span>{props.item.reason}</span>
      </Show>
      <Show when={props.item.note}>
        <div class="muted">[{props.item.note}]</div>
      </Show>
      <Show when={props.item.summarySkipped}>
        <div class="muted">[no summary: {props.item.summarySkipped}]</div>
      </Show>
      <For each={props.item.warnings ?? []}>{(w) => <div class="warn">⚠ {w}</div>}</For>
    </div>
  );
}

type Where = "keep" | "place" | "path" | "delete";

/** Change one item: where it goes (a place, any folder, or the trash) and its new name. */
function ItemEditor(props: {
  item: PlanItem;
  places: PlaceInfo[];
  trashEnabled: boolean;
  pending: boolean;
  onSave: (target: PlanTarget) => void;
  onCancel: () => void;
}) {
  const original = basename(props.item.file);
  const [where, setWhere] = createSignal<Where>(props.item.status === "pending" ? "keep" : "place");
  const [place, setPlace] = createSignal(props.item.place ?? props.places[0]?.name ?? "");
  const [folder, setFolder] = createSignal(props.item.destination ?? "");
  const [name, setName] = createSignal(props.item.newName ?? original);
  const [problem, setProblem] = createSignal<string>();

  /** A name is meaningless for a file that is (or stays) set for deletion. */
  const nameOff = () => where() === "delete" || (where() === "keep" && !!props.item.delete);

  const save = (e: SubmitEvent) => {
    e.preventDefault();
    const target: PlanTarget = {};
    if (where() === "place") target.place = place();
    if (where() === "path") target.path = folder().trim();
    if (where() === "delete") target.delete = true;
    if (!nameOff()) {
      const wanted = name().trim();
      const current = props.item.newName ?? original;
      if (wanted === "" || wanted === original) {
        if (props.item.newName) target.name = null;
      } else if (wanted !== current) target.name = wanted;
    }
    if (where() === "path" && !target.path) return setProblem("Type a folder.");
    if (Object.keys(target).length === 0) return props.onCancel();
    setProblem(undefined);
    props.onSave(target);
  };

  return (
    <form class="stack" onSubmit={save}>
      <fieldset>
        <legend>Goes to</legend>
        <Show when={props.item.status === "pending"}>
          <label>
            <input type="radio" name="where" checked={where() === "keep"} onChange={() => setWhere("keep")} /> Keep: {props.item.delete ? "delete" : (props.item.place ?? "current folder")}
          </label>
        </Show>
        <label>
          <input type="radio" name="where" checked={where() === "place"} disabled={props.places.length === 0} onChange={() => setWhere("place")} /> Place{" "}
          <select value={place()} disabled={where() !== "place"} onChange={(e) => setPlace(e.currentTarget.value)}>
            <For each={props.places}>{(pl) => <option value={pl.name}>{pl.name}</option>}</For>
          </select>
        </label>
        <label>
          <input type="radio" name="where" checked={where() === "path"} onChange={() => setWhere("path")} /> Other folder{" "}
          <input type="text" size={50} value={folder()} disabled={where() !== "path"} placeholder="~/Documents/…" onInput={(e) => setFolder(e.currentTarget.value)} />
        </label>
        <label title={props.trashEnabled ? "" : "Deleting is off; see Settings"}>
          <input type="radio" name="where" checked={where() === "delete"} disabled={!props.trashEnabled} onChange={() => setWhere("delete")} /> Delete (to the trash)
        </label>
      </fieldset>
      <fieldset disabled={nameOff()}>
        <legend>Name</legend>
        <input type="text" size={50} value={name()} onInput={(e) => setName(e.currentTarget.value)} />{" "}
        <button type="button" onClick={() => setName(original)}>
          Use original name
        </button>
        <p class="muted">The extension is always kept. Original: {original}</p>
      </fieldset>
      <ErrorText error={problem()} />
      <div class="row">
        <button type="submit" class="primary" disabled={props.pending}>
          Save
        </button>
        <button type="button" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Changes for all selected items at once. */
function BulkBar(props: {
  count: number;
  places: PlaceInfo[];
  trashEnabled: boolean;
  pending: boolean;
  onTarget: (target: PlanTarget) => void;
  onSkip: () => void;
  onClear: () => void;
}) {
  const [place, setPlace] = createSignal(props.places[0]?.name ?? "");
  const [folder, setFolder] = createSignal("");
  return (
    <div class="bulk">
      <strong>{plural(props.count, "file")} selected:</strong>
      <span>
        <select value={place()} onChange={(e) => setPlace(e.currentTarget.value)}>
          <For each={props.places}>{(pl) => <option value={pl.name}>{pl.name}</option>}</For>
        </select>{" "}
        <button type="button" disabled={props.pending || !place()} onClick={() => props.onTarget({ place: place() })}>
          Move to place
        </button>
      </span>
      <span>
        <input type="text" placeholder="Other folder" value={folder()} onInput={(e) => setFolder(e.currentTarget.value)} />{" "}
        <button type="button" disabled={props.pending || !folder().trim()} onClick={() => props.onTarget({ path: folder().trim() })}>
          Move to folder
        </button>
      </span>
      <button type="button" disabled={props.pending || !props.trashEnabled} onClick={() => props.onTarget({ delete: true })}>
        Delete
      </button>
      <button type="button" disabled={props.pending} onClick={() => props.onSkip()}>
        Skip
      </button>
      <button type="button" onClick={() => props.onClear()}>
        Clear selection
      </button>
    </div>
  );
}

type ApplyStage = { step: "idle" } | { step: "preview"; preview: ApplyPreview } | { step: "done"; result: ApplyResult };

/** Apply in two steps: see exactly what will move or be deleted, then confirm. */
function ApplyPanel(props: { plan: Plan; onApplied: (plan: Plan) => void }) {
  const [stage, setStage] = createSignal<ApplyStage>({ step: "idle" });
  const [onConflict, setOnConflict] = createSignal<"fail" | "rename">("fail");
  const preview = createAction(
    () => api.plans.preview({ planId: props.plan.id }),
    (p) => setStage({ step: "preview", preview: p }),
  );
  const apply = createAction(
    () => api.plans.apply({ planId: props.plan.id, onConflict: onConflict() }),
    ({ result, plan }) => {
      setStage({ step: "done", result });
      props.onApplied(plan);
    },
  );

  const previewOf = () => {
    const s = stage();
    return s.step === "preview" ? s.preview : undefined;
  };
  const resultOf = () => {
    const s = stage();
    return s.step === "done" ? s.result : undefined;
  };

  return (
    <div class="apply">
      <Show when={stage().step !== "preview" && props.plan.state === "open"}>
        <button type="button" class="primary" disabled={preview.pending()} onClick={() => void preview.run()}>
          Apply plan…
        </button>
      </Show>
      <ErrorText error={preview.error()} />
      <Show when={previewOf()}>
        {(p) => (
          <div class="panel">
            <Show when={p().wouldMove.length + p().wouldTrash.length > 0} fallback={<p>Nothing pending in this plan.</p>}>
              <Show when={p().wouldMove.length}>
                <p>Move {plural(p().wouldMove.length, "file")}:</p>
                <ul>
                  <For each={p().wouldMove}>
                    {(m) => (
                      <li>
                        <code>{relative(m.file, props.plan.source)}</code> → <PathText path={m.to} />
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={p().wouldTrash.length}>
                <p>
                  Delete {plural(p().wouldTrash.length, "file")} ({describeTrash(p().trash)}):
                </p>
                <ul>
                  <For each={p().wouldTrash}>{(f) => <li><code>{relative(f, props.plan.source)}</code></li>}</For>
                </ul>
              </Show>
              <fieldset>
                <legend>If a file with the same name is already there</legend>
                <label>
                  <input type="radio" name="conflict" checked={onConflict() === "fail"} onChange={() => setOnConflict("fail")} /> Don't move that file (it fails)
                </label>
                <label>
                  <input type="radio" name="conflict" checked={onConflict() === "rename"} onChange={() => setOnConflict("rename")} /> Use a free name, such as "file (1).pdf"
                </label>
              </fieldset>
            </Show>
            <div class="row">
              <Show when={p().wouldMove.length + p().wouldTrash.length > 0}>
                <button type="button" class="primary" disabled={apply.pending()} onClick={() => void apply.run()}>
                  {apply.pending() ? "Working…" : "Confirm"}
                </button>
              </Show>
              <button type="button" disabled={apply.pending()} onClick={() => setStage({ step: "idle" })}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Show>
      <ErrorText error={apply.error()} />
      <Show when={resultOf()}>{(r) => <ApplyResultView result={r()} />}</Show>
    </div>
  );
}

function UndoPlanButton(props: { planId: string }) {
  const app = useApp();
  const [result, setResult] = createSignal<UndoResult>();
  const undo = createAction(
    () => api.history.undo({ planId: props.planId }),
    (r) => {
      setResult(r);
      app.refreshStatus();
    },
  );
  return (
    <div>
      <ConfirmButton
        label="Undo this plan"
        question="Move this plan's files back and restore their names?"
        confirmLabel="Undo"
        disabled={undo.pending()}
        onConfirm={() => void undo.run()}
      />
      <ErrorText error={undo.error()} />
      <Show when={result()}>{(r) => <UndoResultView result={r()} />}</Show>
    </div>
  );
}
