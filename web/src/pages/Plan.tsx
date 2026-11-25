import type { ApplyPreview, ApplyResult, PlaceInfo, Plan, PlanCounts, PlanItem } from "@contract";
import { useParams } from "@solidjs/router";
import { type Accessor, For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { api } from "../api";
import { useApp } from "../app-context";
import { type Choice, DestinationSelect } from "../components/destination";
import { FileIcon } from "../components/file-icon";
import { PlanFacts, ReopenPlan, UndoPlan } from "../components/plan-facts";
import { ApplyResultView } from "../components/results";
import { Collapsible, ConfirmButton, ErrorText, Loaded, PathText, createAction, createFlash } from "../components/ui";
import { COUNT_WORDS, basename, describeTrash, dirname, isDone, isUnsure, listing, needsAttention, planStatus, plural, relative } from "../format";

export function PlanPage() {
  const params = useParams<{ id: string }>();
  const app = useApp();
  const [plan, { mutate, refetch }] = createResource(
    () => params.id,
    (id) => api.plans.get({ id }),
  );
  const [places] = createResource(() => api.places.list());

  /** After a change: show the plan the server sent back, and update the counts in the header. */
  const updated = (p: Plan) => {
    mutate(p);
    app.refreshStatus();
  };
  /** After an undo, which changes the history but not the plan file: get the plan's new counts. */
  const reload = () => {
    void refetch();
    app.refreshStatus();
  };

  return <Loaded resource={plan}>{(p) => <PlanView plan={p} places={places.latest?.places ?? []} onChange={updated} onReload={reload} />}</Loaded>;
}

interface Group {
  key: string;
  title: string;
  detail?: string;
  tone?: "attention" | "quiet";
  open: boolean;
  rank: number;
  items: PlanItem[];
}

function PlanView(props: { plan: Accessor<Plan>; places: PlaceInfo[]; onChange: (plan: Plan) => void; onReload: () => void }) {
  const app = useApp();
  // A store matched by file keeps each row, and a rename box that is open, when the plan reloads.
  const [state, setState] = createStore<{ plan: Plan }>({ plan: structuredClone(props.plan()) });
  createEffect(() => setState("plan", reconcile(props.plan(), { key: "file" })));
  const plan = () => state.plan;

  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [flash, showFlash] = createFlash();
  const [applied, setApplied] = createSignal<ApplyResult>();

  const trashEnabled = () => app.status()?.trash.enabled ?? false;
  const editable = (i: PlanItem) => !plan().discarded && !isDone(i);
  /** Selected files that are still in the plan and can change. */
  const selection = () =>
    plan()
      .items.filter((i) => editable(i) && selected().has(i.file))
      .map((i) => i.file);
  const setChecked = (files: string[], on: boolean) => {
    const next = new Set(selected());
    for (const f of files) {
      if (on) next.add(f);
      else next.delete(f);
    }
    setSelected(next);
  };

  const retarget = createAction(
    (files: string[], target: Choice & { kind: "target" }) => api.plans.retarget({ planId: plan().id, files, target: target.target }),
    props.onChange,
  );
  const rename = createAction(
    (file: string, name: string | null) => api.plans.retarget({ planId: plan().id, files: [file], target: { name } }),
    props.onChange,
  );
  const skip = createAction((files: string[]) => api.plans.skip({ planId: plan().id, files }), props.onChange);
  const discard = createAction(() => api.plans.discard({ planId: plan().id }), props.onChange);
  const putBack = createAction(
    async (item: PlanItem) => {
      const r = await api.history.undo({ ids: [item.operationId ?? ""] });
      const failed = r.failed[0];
      if (failed) throw new Error(failed.error);
      return item;
    },
    (item) => {
      showFlash(`Put back ${basename(item.file)}.`);
      props.onReload();
    },
  );
  const busy = () => retarget.pending() || rename.pending() || skip.pending() || putBack.pending();
  const actionError = () => retarget.error() ?? rename.error() ?? skip.error() ?? discard.error() ?? putBack.error();

  const change = async (files: string[], choice: Choice): Promise<boolean> => {
    retarget.clearError();
    skip.clearError();
    const done = choice.kind === "skip" ? await skip.run(files) : await retarget.run(files, choice);
    if (!done) return false;
    showFlash(`${files.length === 1 ? basename(files[0] ?? "") : plural(files.length, "file")}: ${choice.label}.`);
    return true;
  };
  const changeSelection = async (choice: Choice) => {
    const ok = await change(selection(), choice);
    if (ok) setSelected(new Set<string>());
    return ok;
  };
  const renameItem = async (file: string, name: string | null) => {
    rename.clearError();
    const done = await rename.run(file, name);
    if (done) showFlash(name ? `Renamed to ${name}.` : `${basename(file)} keeps its name.`);
    return done !== undefined;
  };

  const groups = createMemo(() => groupItems(plan(), props.places, app.tildify, app.status()?.trash));
  const groupOf = (key: string) => groups().find((g) => g.key === key);
  // Stays true after an undo, so the undo's result stays on the page.
  const showUndo = createMemo((shown: boolean) => shown || plan().counts.canUndo > 0 || plan().counts.inSystemTrash > 0, false);

  return (
    <div class="plan">
      <a class="back button quiet" href="/">
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6.5 1.5 3 5l3.5 3.5" />
        </svg>
        Plans
      </a>
      <h1>
        Tidy {basename(plan().source)} <span class={`tag ${plan().state}`}>{planStatus(plan())}</span>
      </h1>
      <PlanFacts plan={plan()} />
      <p class="muted small">
        Plan id <code>{plan().id}</code>
        <Show when={plan().reopenedFrom}>
          {(from) => (
            <>
              {" "}
              · reopened from <a href={`/plans/${from()}`}>plan {from()}</a>
            </>
          )}
        </Show>
      </p>

      <Show when={applied()}>
        {(r) => (
          <section class="box success">
            <h2>Done</h2>
            <ApplyResultView result={r()} />
          </section>
        )}
      </Show>
      <Show when={showUndo()}>
        <div class="row">
          <UndoPlan planId={plan().id} counts={plan().counts} onUndone={props.onReload} />
        </div>
      </Show>
      <Show when={plan().discarded}>
        <p class="box">This plan was discarded. Nothing in it moves.</p>
      </Show>
      <Show when={plan().state !== "open"}>
        <div class="row">
          <ReopenPlan plan={plan()} onReopened={props.onReload} />
        </div>
      </Show>
      <Show when={plan().state === "open"}>
        <p class="muted">Check where each file goes. Change it with the menu on its row, or select several files. Nothing moves until you apply the plan.</p>
      </Show>

      <Show when={!plan().discarded}>
        <Destinations plan={plan()} />
      </Show>

      <For each={groups().map((g) => g.key)}>
        {(key) => (
          <Show when={groupOf(key)}>
            {(group) => (
              <Collapsible
                class={group().tone ?? ""}
                open={group().open}
                header={
                  <Show when={group().items.some(editable)}>
                    <input
                      type="checkbox"
                      aria-label={`Select all in ${group().title}`}
                      checked={group()
                        .items.filter(editable)
                        .every((i) => selected().has(i.file))}
                      onChange={(e) =>
                        setChecked(
                          group()
                            .items.filter(editable)
                            .map((i) => i.file),
                          e.currentTarget.checked,
                        )
                      }
                    />
                  </Show>
                }
                title={
                  <>
                    <strong>{group().title}</strong> <span class="count">{group().items.length}</span>
                  </>
                }
                detail={<span class="muted">{group().detail}</span>}
              >
                <ul class="items">
                  <For each={group().items}>
                    {(item) => (
                      <ItemRow
                        item={item}
                        source={plan().source}
                        places={props.places}
                        trashEnabled={trashEnabled()}
                        editable={editable(item)}
                        busy={busy()}
                        selected={selected().has(item.file)}
                        onSelect={(on) => setChecked([item.file], on)}
                        onChoose={(choice) => change([item.file], choice)}
                        onRename={(name) => renameItem(item.file, name)}
                        onPutBack={() => void putBack.run(item)}
                      />
                    )}
                  </For>
                </ul>
              </Collapsible>
            )}
          </Show>
        )}
      </For>

      <Show when={plan().context}>
        {(ctx) => (
          <details class="context">
            <summary>What the agent knew when it made this plan</summary>
            <p>
              Renaming: {ctx().rename}
              {ctx().naming ? ` · naming style: ${ctx().naming}` : ""}
              {ctx().extensionCase === "lower" ? " · extensions in lowercase" : ""}
            </p>
            <Show when={ctx().rules.length}>
              <p>Rules:</p>
              <ul>
                <For each={ctx().rules}>{(r) => <li>{r}</li>}</For>
              </ul>
            </Show>
            {/* Plans from before v0.1.0 kept the places under another name, so they can have none here. */}
            <Show when={ctx().places?.length}>
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
            </Show>
          </details>
        )}
      </Show>

      <Show when={selection().length || plan().state === "open" || flash() || actionError()}>
        <div class="bar">
          <div class="bar-status" aria-live="polite">
            <ErrorText error={actionError()} />
            <Show when={!actionError() && flash()}>{(m) => <span class="flash">{m()}</span>}</Show>
          </div>
          <Switch>
            <Match when={selection().length}>
              <div class="bar-row">
                <strong>{plural(selection().length, "file")} selected</strong>
                <DestinationSelect
                  places={props.places}
                  trashEnabled={trashEnabled()}
                  disabled={busy()}
                  label="Move selected files to"
                  onChoose={changeSelection}
                />
                <button type="button" class="link" onClick={() => setSelected(new Set<string>())}>
                  Clear selection
                </button>
              </div>
            </Match>
            <Match when={plan().state === "open"}>
              <ApplyBar
                plan={plan()}
                counts={plan().counts}
                discarding={discard.pending()}
                onDiscard={() => void discard.run()}
                onStale={props.onReload}
                onApplied={(result, next) => {
                  setApplied(result);
                  props.onChange(next);
                  window.scrollTo({ top: 0 });
                }}
              />
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
  );
}

/**
 * Put items in groups in the order of the counts: problems first, then one group per destination (in
 * the order of the places), then deletions, then what was done, and last what stays.
 */
function groupItems(plan: Plan, places: PlaceInfo[], tildify: (p: string) => string, trash: Parameters<typeof describeTrash>[0] | undefined): Group[] {
  const groups = new Map<string, Group>();
  const add = (item: PlanItem, key: string, make: () => Omit<Group, "key" | "items">) => {
    const g = groups.get(key) ?? { key, items: [], ...make() };
    g.items.push(item);
    groups.set(key, g);
  };
  const placeRank = (name: string) => {
    const i = places.findIndex((p) => p.name === name);
    return 10 + (i < 0 ? places.length : i);
  };
  // Applied plans can be long: their groups start folded, and the counts say what is in them.
  const applied = plan.state !== "open";
  // Titles start with the words of the counts above (COUNT_WORDS), so the numbers match.
  const word = (k: keyof typeof COUNT_WORDS) => COUNT_WORDS[k].charAt(0).toUpperCase() + COUNT_WORDS[k].slice(1);

  for (const item of plan.items) {
    if (needsAttention(item)) {
      add(item, "attention", () => ({
        title: word("attention"),
        detail: "Pick another destination, or leave the file where it is.",
        tone: "attention",
        open: true,
        rank: 0,
      }));
    } else if (item.undo === "putBack") {
      add(item, "putBack", () => ({ title: word("putBack"), detail: "moved, then undone", tone: "quiet", open: false, rank: 1200 }));
    } else if (item.status === "moved") {
      // One group, as in the counts; each row says where its file went.
      add(item, "moved", () => ({ title: word("moved"), open: false, rank: 1000 }));
    } else if (item.status === "trashed") {
      add(item, "deleted", () => ({ title: word("deleted"), open: false, rank: 1100 }));
    } else if (item.status === "skipped") {
      add(item, "skipped", () => ({ title: word("left"), tone: "quiet", open: false, rank: 1300 }));
    } else if (item.delete) {
      add(item, "delete", () => ({ title: word("toDelete"), detail: trash ? describeTrash(trash) : undefined, open: true, rank: 800 }));
    } else if (applied) {
      // Pending files in a plan that can't be applied (discarded).
      add(item, "pending", () => ({ title: "Not applied", tone: "quiet", open: false, rank: 900 }));
    } else if (item.place) {
      const name = item.place;
      add(item, `place:${name}`, () => ({ title: name, detail: item.destination ? tildify(item.destination) : undefined, open: true, rank: placeRank(name) }));
    } else if (item.destination === dirname(item.file)) {
      add(item, "stay", () => ({ title: "Renamed, stays in its folder", open: true, rank: 700 }));
    } else {
      const dest = item.destination ?? "";
      add(item, `path:${dest}`, () => ({ title: tildify(dest), detail: "(not one of your places)", open: true, rank: 600 }));
    }
  }
  // Guesses the agent wasn't sure about go to the top of their group.
  for (const g of groups.values()) g.items.sort((a, b) => Number(isUnsure(b)) - Number(isUnsure(a)));
  return [...groups.values()].sort((a, b) => a.rank - b.rank);
}

/** How many destinations the chart names. The others are added up in one last row. */
const MOST_DESTINATIONS = 8;

/** A bar per destination, longest first: where the files of this plan go, or went. */
function Destinations(props: { plan: Plan }) {
  const app = useApp();
  const rows = createMemo(() => {
    const counts = new Map<string, number>();
    for (const i of props.plan.items) {
      const moves = (i.status === "pending" && !i.delete && !needsAttention(i)) || (i.status === "moved" && i.undo !== "putBack");
      if (!moves || !i.destination) continue;
      const name = i.place ?? (i.destination === dirname(i.file) ? "Renamed, stays in its folder" : app.tildify(i.destination));
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const rest = sorted.slice(MOST_DESTINATIONS);
    const other = rest.reduce((sum, [, n]) => sum + n, 0);
    return [
      ...sorted.slice(0, MOST_DESTINATIONS).map(([name, n]) => ({ name, n, rest: false })),
      ...(other ? [{ name: plural(rest.length, "other folder"), n: other, rest: true }] : []),
    ];
  });
  const most = () => Math.max(...rows().map((r) => r.n));
  return (
    <Show when={rows().length > 1}>
      <section class="box">
        <h2>{props.plan.state === "open" ? "Where the files go" : "Where the files went"}</h2>
        <ul class="bars" classList={{ "planned-bars": props.plan.state === "open" }}>
          <For each={rows()}>
            {(row) => (
              <li title={`${row.name}: ${plural(row.n, "file")}`} classList={{ rest: row.rest }}>
                <span class="bars-label">{row.name}</span>
                <span class="bars-track">
                  <span class="bars-fill" style={{ width: `${(row.n / most()) * 100}%` }} />
                </span>
                <span class="bars-value">{row.n}</span>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

function ItemRow(props: {
  item: PlanItem;
  source: string;
  places: PlaceInfo[];
  trashEnabled: boolean;
  editable: boolean;
  busy: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onChoose: (choice: Choice) => Promise<boolean>;
  onRename: (name: string | null) => Promise<boolean>;
  onPutBack: () => void;
}) {
  const rel = () => relative(props.item.file, props.source);
  const subfolder = () => (rel() === basename(rel()) ? "" : dirname(rel()));
  const canRename = () => props.editable && props.item.status === "pending" && !props.item.delete;
  const app = useApp();

  return (
    <li class="item" classList={{ unsure: isUnsure(props.item), problem: needsAttention(props.item), selected: props.selected }}>
      <input
        type="checkbox"
        aria-label={`Select ${basename(props.item.file)}`}
        disabled={!props.editable}
        checked={props.selected}
        onChange={(e) => props.onSelect(e.currentTarget.checked)}
      />
      <div class="item-main">
        <FileIcon name={basename(props.item.file)} />
        <div class="item-text">
          <ItemName item={props.item} canRename={canRename()} busy={props.busy} onRename={props.onRename} />
          <Show when={subfolder()}>
            <div class="muted path">in {subfolder()}</div>
          </Show>
          <ItemNotes item={props.item} />
        </div>
      </div>
      <div class="item-where">
        <Show
          when={props.editable}
          fallback={
            <span class="row tight">
              <span class="muted">{isDone(props.item) ? doneLabel(props.item, app.tildify) : "Not moved"}</span>
              <Show when={props.item.undo === "available"}>
                <button type="button" disabled={props.busy} onClick={() => props.onPutBack()}>
                  Put back
                </button>
              </Show>
            </span>
          }
        >
          <DestinationSelect
            item={props.item}
            places={props.places}
            trashEnabled={props.trashEnabled}
            disabled={props.busy}
            label={`Where ${basename(props.item.file)} goes`}
            onChoose={props.onChoose}
          />
        </Show>
      </div>
    </li>
  );
}

/** Where a moved or deleted file is now. */
function doneLabel(item: PlanItem, tildify: (p: string) => string): string {
  if (item.undo === "putBack") return "Back where it was";
  // A forgotten entry no longer says which trash the file went to.
  const trash = item.undo === "systemTrash" ? "In the system Trash" : item.undo === "forgotten" ? "Deleted" : "In the trash folder";
  const where = item.status === "trashed" ? trash : `In ${tildify(item.destination ?? "")}`;
  return item.undo === "forgotten" ? `${where} (no longer in History, so it can't be put back)` : where;
}

/** The file's name, or its new name with the old one under it. Click "Rename" to change it in place. */
function ItemName(props: { item: PlanItem; canRename: boolean; busy: boolean; onRename: (name: string | null) => Promise<boolean> }) {
  const original = () => basename(props.item.file);
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const start = () => {
    setDraft(props.item.newName ?? original());
    setEditing(true);
  };
  const save = async (e: SubmitEvent) => {
    e.preventDefault();
    const wanted = draft().trim();
    const name = wanted === "" || wanted === original() ? null : wanted;
    if (name === (props.item.newName ?? null) || (await props.onRename(name))) setEditing(false);
  };

  return (
    <Show
      when={editing()}
      fallback={
        <div class="name">
          <strong title={props.item.file}>{props.item.newName ?? original()}</strong>
          <Show when={props.item.newName}>
            <span class="muted"> was {original()}</span>
          </Show>
          <Show when={props.canRename}>
            {" "}
            <button type="button" class="link" onClick={start}>
              Rename
            </button>
          </Show>
        </div>
      }
    >
      <form class="inline" onSubmit={save}>
        <input
          type="text"
          size={40}
          aria-label={`New name for ${original()}`}
          value={draft()}
          ref={(el) => queueMicrotask(() => el.select())}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
        />
        <button type="submit" class="primary" disabled={props.busy}>
          Save
        </button>
        <Show when={props.item.newName}>
          <button type="button" disabled={props.busy} onClick={() => setDraft(original())}>
            Use old name
          </button>
        </Show>
        <button type="button" class="link" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <span class="muted">The extension stays.</span>
      </form>
    </Show>
  );
}

function ItemNotes(props: { item: PlanItem }) {
  const problem = () => props.item.status === "invalid" || props.item.status === "failed";
  return (
    <div class="notes">
      <Show when={isUnsure(props.item)}>
        <span class="tag unsure" title={`The agent is ${Math.round((props.item.confidence ?? 0) * 100)}% sure`}>
          unsure
        </span>{" "}
      </Show>
      <Show when={props.item.reason}>
        <span class="muted">{props.item.reason}</span>
      </Show>
      <Show when={props.item.note && props.item.note !== "edited by user"}>
        <div class={problem() ? "warn" : "muted"}>{problem() ? `⚠ ${props.item.note}` : props.item.note}</div>
      </Show>
      <For each={props.item.warnings ?? []}>{(w) => <div class="warn">⚠ {w.replace(/^conflict:\s*/, "")}</div>}</For>
    </div>
  );
}

type ApplyStage = { step: "idle" } | { step: "confirm"; preview: ApplyPreview };

/** The plan's totals and its main action. Apply takes two steps: a summary of what happens, then confirm. */
function ApplyBar(props: { plan: Plan; counts: PlanCounts; discarding: boolean;
  onDiscard: () => void;
  /** The plan on the server is not the one on the page. */
  onStale: () => void;
  onApplied: (result: ApplyResult, plan: Plan) => void;
}) {
  const [stage, setStage] = createSignal<ApplyStage>({ step: "idle" });
  const [freeName, setFreeName] = createSignal(false);
  const preview = createAction(
    () => api.plans.preview({ planId: props.plan.id }),
    (p) => setStage({ step: "confirm", preview: p }),
  );
  const apply = createAction(
    async () => {
      try {
        return await api.plans.apply({ planId: props.plan.id, onConflict: freeName() ? "rename" : "fail", revision: confirming()?.revision });
      } catch (err) {
        if ((err as { code?: unknown }).code === "plan_changed") {
          setStage({ step: "idle" });
          props.onStale();
        }
        throw err;
      }
    },
    ({ result, plan }) => {
      setStage({ step: "idle" });
      props.onApplied(result, plan);
    },
  );
  // The sheet shows what the plan was when it opened. A change to a row closes it. A change from
  // outside this page (the agent, through the CLI) is caught by the server: the apply sends the
  // revision of the preview.
  const planned = () => JSON.stringify(props.plan.items.map((i) => [i.file, i.status, i.destination, i.delete, i.newName]));
  createEffect(on(planned, () => setStage({ step: "idle" }), { defer: true }));
  const confirming = () => {
    const s = stage();
    return s.step === "confirm" ? s.preview : undefined;
  };
  const summary = () =>
    listing((["toMove", "toDelete"] as const).filter((k) => props.counts[k] > 0).map((k) => `${plural(props.counts[k], "file")} ${COUNT_WORDS[k]}`));
  const applyLabel = (p: ApplyPreview) =>
    listing(
      [p.wouldMove.length ? `Move ${plural(p.wouldMove.length, "file")}` : "", p.wouldTrash.length ? `delete ${p.wouldTrash.length}` : ""].filter(Boolean),
    );

  return (
    <>
      <Show when={confirming()}>
        {(p) => (
          <div class="sheet">
            <h2>Apply this plan?</h2>
            <ul class="plain">
              <For each={byFolder(p().wouldMove)}>
                {([folder, n]) => (
                  <li>
                    {plural(n, "file")} → <PathText path={folder} />
                  </li>
                )}
              </For>
              <Show when={p().wouldTrash.length}>
                <li>
                  {plural(p().wouldTrash.length, "file")} deleted ({describeTrash(p().trash)})
                </li>
              </Show>
            </ul>
            <details>
              <summary>Show every file</summary>
              <ul class="plain small">
                <For each={p().wouldMove}>
                  {(m) => (
                    <li>
                      <code>{relative(m.file, props.plan.source)}</code> → <PathText path={m.to} />
                    </li>
                  )}
                </For>
                <For each={p().wouldTrash}>
                  {(f) => (
                    <li>
                      <code>{relative(f, props.plan.source)}</code> → trash
                    </li>
                  )}
                </For>
              </ul>
            </details>
            <Show when={props.counts.attention}>
              <p class="warn">{plural(props.counts.attention, "file")} that need attention are left out or may fail.</p>
            </Show>
            <label>
              <input type="checkbox" checked={freeName()} onChange={(e) => setFreeName(e.currentTarget.checked)} /> If a file with the same name is already
              there, add a number to the name (for example "photo (1).jpg"). If not checked, that file stays where it is.
            </label>
            <div class="row">
              <button type="button" class="primary" disabled={apply.pending()} onClick={() => void apply.run()}>
                {apply.pending() ? "Working…" : applyLabel(p())}
              </button>
              <button type="button" disabled={apply.pending()} onClick={() => setStage({ step: "idle" })}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Show>
      <div class="bar-row">
        <span>
          <strong>{summary() || "Nothing to apply"}</strong>
          <Show when={props.counts.attention}>
            <span class="warn">
              {" "}
              · {props.counts.attention} {COUNT_WORDS.attention}
            </span>
          </Show>
        </span>
        <span class="spacer" />
        <Show when={!confirming()}>
          <ConfirmButton
            label="Discard plan"
            class="link"
            question="Discard this plan? Nothing moves."
            confirmLabel="Discard"
            disabled={props.discarding}
            onConfirm={props.onDiscard}
          />
          <button type="button" class="primary big" disabled={preview.pending()}
            onClick={() => {
              apply.clearError();
              void preview.run();
            }}
          >
            Apply plan…
          </button>
        </Show>
      </div>
      <ErrorText error={preview.error() ?? apply.error()} />
    </>
  );
}

/** Files per destination folder, biggest first. */
function byFolder(moves: { to: string }[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const m of moves) {
    const folder = dirname(m.to);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
