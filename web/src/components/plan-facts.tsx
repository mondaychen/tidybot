import type { LeftOut, Plan, PlanCounts, PlanState, UndoResult } from "@contract";
import { For, Show, createSignal } from "solid-js";
import { api } from "../api";
import { COUNT_WORDS, basename, countsText, dateTime, listing, plural, when } from "../format";
import { UndoResultView } from "./results";
import { useApp } from "../app-context";
import { ConfirmButton, ErrorText, PathText, createAction } from "./ui";

/** What a plan is about, worded the same in each view: its folder, its times and its counts. */
export function PlanFacts(props: { plan: { source: string; createdAt: string; appliedAt: string | null; counts: PlanCounts; state: PlanState } }) {
  return (
    <div class="facts">
      <div class="muted">
        <PathText path={props.plan.source} /> · proposed <time title={dateTime(props.plan.createdAt)}>{when(props.plan.createdAt)}</time>
        <Show when={props.plan.appliedAt}>
          {(at) => (
            <>
              {" "}
              · applied <time title={dateTime(at())}>{when(at())}</time>
            </>
          )}
        </Show>
      </div>
      <CountsBar counts={props.plan.counts} />
    </div>
  );
}

/** The color of each count. A change that waits for the plan to be applied has stripes. */
const COUNT_LOOK: Record<keyof typeof COUNT_WORDS, string> = {
  attention: "attention",
  toMove: "move planned",
  toDelete: "delete planned",
  moved: "move",
  deleted: "delete",
  putBack: "putback",
  left: "left",
};

/** A plan's counts as one bar, with each part in proportion, and the numbers in words under it. */
export function CountsBar(props: { counts: PlanCounts }) {
  const parts = () => (Object.keys(COUNT_WORDS) as (keyof typeof COUNT_WORDS)[]).filter((k) => props.counts[k] > 0);
  return (
    <div class="counts">
      <Show when={parts().length}>
        <div class="counts-bar" aria-hidden="true">
          <For each={parts()}>
            {(k) => <span class={`seg ${COUNT_LOOK[k]}`} style={{ "flex-grow": props.counts[k] }} title={`${props.counts[k]} ${COUNT_WORDS[k]}`} />}
          </For>
        </div>
      </Show>
      <div class="counts-legend">
        <strong>{plural(props.counts.total, "file")}</strong>
        <For each={parts()}>
          {(k) => (
            <span class="key">
              <i class={`seg ${COUNT_LOOK[k]}`} />
              <b>{props.counts[k]}</b> {COUNT_WORDS[k]}
            </span>
          )}
        </For>
      </div>
    </div>
  );
}

/** "2 moved and 1 deleted files": what undo puts back, in the words of the counts. */
function putBackText(c: PlanCounts): string {
  const moved = c.canUndo - c.canUndoDeleted;
  const parts = [moved ? `${moved} moved` : "", c.canUndoDeleted ? `${c.canUndoDeleted} deleted` : ""].filter(Boolean);
  return `${listing(parts)} ${c.canUndo === 1 ? "file" : "files"}`;
}

/** Put a plan's files back, and say which deleted files undo can't reach. */
export function UndoPlan(props: { planId: string; counts: PlanCounts; onUndone: () => void }) {
  const [result, setResult] = createSignal<UndoResult>();
  const undo = createAction(
    () => api.history.undo({ planId: props.planId }),
    (r) => {
      setResult(r);
      props.onUndone();
    },
  );
  return (
    <div class="undo">
      <Show when={props.counts.canUndo > 0}>
        <ConfirmButton
          label={`Put back ${putBackText(props.counts)}`}
          question={`Put ${putBackText(props.counts)} back where they were, with their old names?`}
          confirmLabel="Put back"
          disabled={undo.pending()}
          onConfirm={() => void undo.run()}
        />
      </Show>
      <Show when={props.counts.inSystemTrash}>
        <p class="muted">
          {plural(props.counts.inSystemTrash, "deleted file")} {props.counts.inSystemTrash === 1 ? "is" : "are"} in the system Trash. Undo can't put{" "}
          {props.counts.inSystemTrash === 1 ? "it" : "them"} back: restore {props.counts.inSystemTrash === 1 ? "it" : "them"} from the Trash.
        </p>
      </Show>
      <ErrorText error={undo.error()} />
      <Show when={result()}>{(r) => <UndoResultView result={r()} onForgotten={props.onUndone} />}</Show>
    </div>
  );
}

/** Why a reopened plan left a file out, and what the user can do. */
function leftOutText(l: LeftOut, tildify: (p: string) => string): string {
  if (l.reason === "systemTrash") return `it is in the system Trash. Restore it to ${tildify(l.file)}, then reopen the plan again.`;
  if (l.reason === "missing") return "it is not where it was, and tidybot can't find it.";
  const where = `it is still in ${tildify(l.at ?? "")}.`;
  return l.undoId ? `${where} Put it back first.` : `${where} Undo can't put it back: move it back yourself.`;
}

/**
 * Copy a past plan into a new plan, to move its files again after they were put back. Shown for an
 * applied plan with files put back, and for a discarded plan. When an open copy exists, links to it.
 */
export function ReopenPlan(props: {
  plan: { id: string; state: PlanState; counts: PlanCounts; reopenedAs?: string };
  onReopened: () => void;
}) {
  const app = useApp();
  const [result, setResult] = createSignal<{ plan: Plan; left: LeftOut[] }>();
  const reopen = createAction(
    () => api.plans.reopen({ planId: props.plan.id }),
    (r) => {
      setResult(r);
      props.onReopened();
    },
  );
  const offered = () => props.plan.state !== "open" && (props.plan.counts.putBack > 0 || props.plan.state === "discarded");
  return (
    <div class="undo">
      <Show
        when={result()}
        fallback={
          <Show
            when={props.plan.reopenedAs}
            fallback={
              <Show when={offered()}>
                <button type="button" disabled={reopen.pending()} onClick={() => void reopen.run()} title="Make a new plan with the files that are back where they were">
                  Reopen as a new plan
                </button>
              </Show>
            }
          >
            {(id) => (
              <p class="muted">
                This plan was reopened as a new plan.{" "}
                <a class="button" href={`/plans/${id()}`}>
                  Review the new plan
                </a>
              </p>
            )}
          </Show>
        }
      >
        {(r) => (
          <div class="result">
            <p>
              New plan: {countsText(r().plan.counts)}.{" "}
              <a class="button" href={`/plans/${r().plan.id}`}>
                Review the new plan
              </a>
            </p>
            <Show when={r().left.length}>
              <p>Left out {plural(r().left.length, "file")}:</p>
              <ul>
                <For each={r().left}>
                  {(l) => (
                    <li>
                      <code class="path" title={l.file}>
                        {basename(l.file)}
                      </code>
                      : {leftOutText(l, app.tildify)}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        )}
      </Show>
      <ErrorText error={reopen.error()} />
    </div>
  );
}
