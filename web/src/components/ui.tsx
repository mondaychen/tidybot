import type { Scope } from "@contract";
import { type Accessor, type JSX, type Resource, Match, Show, Switch, createSignal, onCleanup } from "solid-js";
import { useApp } from "../app-context";

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface Action<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>;
  pending: () => boolean;
  error: () => string | undefined;
  clearError: () => void;
}

/**
 * One user action (a button or a form) that calls the server: tracks whether it's running and
 * keeps its last error. `run` resolves to undefined when the call failed.
 */
export function createAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, onDone?: (result: R) => void): Action<A, R> {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const run = async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(undefined);
    try {
      const result = await fn(...args);
      onDone?.(result);
      return result;
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      setPending(false);
    }
  };
  return { run, pending, error, clearError: () => setError(undefined) };
}

export function ErrorText(props: { error: string | undefined }) {
  return (
    <Show when={props.error}>
      {(message) => (
        <p class="error" role="alert">
          {message()}
        </p>
      )}
    </Show>
  );
}

/** Show a resource's value; its error or "Loading…" until it has one. Keeps the old value while it reloads. */
export function Loaded<T extends object>(props: { resource: Resource<T>; children: (value: Accessor<T>) => JSX.Element }) {
  const error = (): unknown => props.resource.error;
  return (
    <Switch fallback={<p class="muted">Loading…</p>}>
      <Match when={error()}>
        <ErrorText error={errorMessage(error())} />
      </Match>
      <Match when={props.resource.latest}>{(value) => props.children(value)}</Match>
    </Switch>
  );
}

/** A short message that goes away by itself: feedback after a change. */
export function createFlash(ms = 5000): [() => string | undefined, (message: string) => void] {
  const [message, setMessage] = createSignal<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const show = (m: string) => {
    clearTimeout(timer);
    setMessage(m);
    timer = setTimeout(() => setMessage(undefined), ms);
  };
  return [message, show];
}

/** A section whose body can be hidden. It keeps its open state while its content changes. */
export function Collapsible(props: {
  title: JSX.Element;
  /** Shown after the title, outside the toggle. */
  detail?: JSX.Element;
  open?: boolean;
  class?: string;
  header?: JSX.Element;
  children: JSX.Element;
}) {
  const [open, setOpen] = createSignal(props.open ?? true);
  return (
    <section class={`group ${props.class ?? ""}`}>
      <div class="group-head">
        {props.header}
        <button type="button" class="link" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <span aria-hidden="true">{open() ? "▾" : "▸"}</span> {props.title}
        </button>
        {props.detail}
      </div>
      <Show when={open()}>{props.children}</Show>
    </section>
  );
}

/** A button that asks "Are you sure?" in place before it acts. */
export function ConfirmButton(props: { label: string; question: string; confirmLabel?: string; disabled?: boolean; class?: string; onConfirm: () => void }) {
  const [asking, setAsking] = createSignal(false);
  return (
    <Show
      when={asking()}
      fallback={
        <button type="button" class={props.class} disabled={props.disabled} onClick={() => setAsking(true)}>
          {props.label}
        </button>
      }
    >
      <span class="confirm">
        {props.question}{" "}
        <button
          type="button"
          class="danger"
          onClick={() => {
            setAsking(false);
            props.onConfirm();
          }}
        >
          {props.confirmLabel ?? "Yes"}
        </button>{" "}
        <button type="button" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </span>
    </Show>
  );
}

/** Where a settings change is written. Only shown inside a project; otherwise it's always global. */
export function ScopePicker(props: { value: Scope; onChange: (scope: Scope) => void }) {
  const app = useApp();
  return (
    <Show when={app.status()?.project}>
      <label class="scope">
        Changes apply to{" "}
        <select value={props.value} onChange={(e) => props.onChange(e.currentTarget.value === "project" ? "project" : "global")}>
          <option value="project">this project only</option>
          <option value="global">everywhere (global)</option>
        </select>
      </label>
    </Show>
  );
}

/** A signal for a write scope that starts at the server's default (the project, if there is one). */
export function createScope(): [() => Scope, (scope: Scope) => void] {
  const app = useApp();
  const [chosen, setChosen] = createSignal<Scope>();
  return [() => chosen() ?? app.status()?.scope ?? "global", setChosen];
}

/** Show a path with `~` for the home directory. */
export function PathText(props: { path: string }) {
  const app = useApp();
  return (
    <code class="path" title={props.path}>
      {app.tildify(props.path)}
    </code>
  );
}
