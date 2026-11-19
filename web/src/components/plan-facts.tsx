import type { PlanCounts, PlanState, UndoResult } from "@contract";
import { Show, createSignal } from "solid-js";
import { api } from "../api";
import { countsText, dateTime, listing, plural, when } from "../format";
import { UndoResultView } from "./results";
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
      <div>{countsText(props.plan.counts)}</div>
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
