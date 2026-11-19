import { A, type RouteSectionProps } from "@solidjs/router";
import { Show } from "solid-js";
import { useApp } from "../app-context";
import { PathText } from "../components/ui";

/** Everything the user sets up once and changes rarely, under one menu item. */
export function SetupLayout(props: RouteSectionProps) {
  const app = useApp();
  return (
    <>
      <h1>Setup</h1>
      <Show when={app.status()?.project}>
        {(project) => (
          <p class="muted">
            You started tidybot in the project <PathText path={project()} />. Here, its places and settings are used in place of your global ones. Its rules and
            sensitive-file rules are added to the global ones.
          </p>
        )}
      </Show>
      <nav class="tabs">
        <A href="/setup/places">Places</A>
        <A href="/setup/naming">Naming and rules</A>
        <A href="/setup/sensitive">Sensitive files</A>
        <A href="/setup/more">More settings</A>
      </nav>
      {props.children}
    </>
  );
}
