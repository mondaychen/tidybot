import type { PlaceInfo, PlanItem, PlanTarget } from "@contract";
import { For, Show, createSignal } from "solid-js";
import { useApp } from "../app-context";
import { basename, dirname } from "../format";

/** What the user picked for one or more files. */
export type Choice = { kind: "target"; target: PlanTarget; label: string } | { kind: "skip"; label: string };

const NONE = "";
const CURRENT = "current";
const OTHER = "other";
const DELETE = "delete";
const SKIP = "skip";
const place = (name: string) => `place:${name}`;

/**
 * Where a file goes, as one dropdown: a place, another folder, the trash, or nowhere. Picking an
 * option changes the plan at once. With no `item` it is for a selection of files, and shows a prompt.
 */
export function DestinationSelect(props: {
  item?: PlanItem;
  places: PlaceInfo[];
  trashEnabled: boolean;
  disabled?: boolean;
  label: string;
  /** Resolves to false when the change failed. */
  onChoose: (choice: Choice) => Promise<boolean>;
}) {
  const app = useApp();
  const [shown, setShown] = createSignal<string>();
  const [other, setOther] = createSignal(false);
  const [folder, setFolder] = createSignal("");

  const current = (): string => {
    const i = props.item;
    if (!i) return NONE;
    if (i.status === "skipped") return SKIP;
    if (i.delete) return DELETE;
    if (i.place && props.places.some((p) => p.name === i.place)) return place(i.place);
    if (i.destination) return CURRENT;
    return NONE;
  };
  /** The item's folder when it isn't one of the places. The full path is in the group's title. */
  const currentLabel = () => {
    const i = props.item;
    if (!i?.destination) return "";
    if (i.place === null && i.destination === dirname(i.file)) return "Stays in its folder";
    return `Folder ${basename(app.tildify(i.destination))}`;
  };

  const choose = async (choice: Choice, value: string) => {
    setShown(value);
    const ok = await props.onChoose(choice);
    setShown(undefined);
    if (ok) setOther(false);
  };

  const picked = (value: string) => {
    if (value === OTHER) {
      setFolder(props.item?.destination && current() === CURRENT ? props.item.destination : "");
      setOther(true);
      return;
    }
    setOther(false);
    if (value === SKIP) return void choose({ kind: "skip", label: "left where they are" }, value);
    if (value === DELETE) return void choose({ kind: "target", target: { delete: true }, label: "deleted" }, value);
    const name = value.startsWith("place:") ? value.slice("place:".length) : undefined;
    if (name) return void choose({ kind: "target", target: { place: name }, label: `moved to ${name}` }, value);
  };

  const submitFolder = (e: SubmitEvent) => {
    e.preventDefault();
    const path = folder().trim();
    if (path) void choose({ kind: "target", target: { path }, label: `moved to ${path}` }, OTHER);
  };

  return (
    <span class="destination">
      <select
        aria-label={props.label}
        value={other() ? OTHER : (shown() ?? current())}
        disabled={props.disabled || shown() !== undefined}
        onChange={(e) => {
          const value = e.currentTarget.value;
          // Show what the plan says until the server answers, not what was clicked.
          e.currentTarget.value = current();
          picked(value);
        }}
      >
        <Show when={current() === NONE}>
          <option value={NONE} disabled>
            {props.item ? "Choose where it goes…" : "Move to…"}
          </option>
        </Show>
        <Show when={props.places.length}>
          <optgroup label="Places">
            <For each={props.places}>{(p) => <option value={place(p.name)}>{p.name}</option>}</For>
          </optgroup>
        </Show>
        <optgroup label="Other">
          <Show when={current() === CURRENT}>
            <option value={CURRENT}>{currentLabel()}</option>
          </Show>
          <option value={OTHER}>Another folder…</option>
          <option value={DELETE} disabled={!props.trashEnabled}>
            Delete (to the trash){props.trashEnabled ? "" : " — off in Setup"}
          </option>
          <option value={SKIP}>Leave where it is</option>
        </optgroup>
      </select>
      <Show when={other()}>
        <form class="inline" onSubmit={submitFolder}>
          <input
            type="text"
            size={32}
            placeholder="~/Documents/…"
            aria-label="Folder"
            value={folder()}
            ref={(el) => queueMicrotask(() => el.focus())}
            onInput={(e) => setFolder(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Escape" && setOther(false)}
          />
          <button type="submit" disabled={!folder().trim() || shown() !== undefined}>
            Move
          </button>
          <button type="button" class="link" onClick={() => setOther(false)}>
            Cancel
          </button>
        </form>
      </Show>
    </span>
  );
}
