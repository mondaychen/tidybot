import type { CustomRule } from "@contract";
import { For, Show, createResource, createSignal } from "solid-js";
import { api } from "../api";
import { ConfirmButton, ErrorText, Loaded, PathText, ScopePicker, createAction, createScope } from "../components/ui";
import { dateTime } from "../format";

export function SensitivePage() {
  const [scope, setScope] = createScope();
  const [data, { refetch }] = createResource(() => api.sensitive.get());
  const changed = () => void refetch();
  const setRule = createAction((id: string, allowed: boolean) => api.sensitive.setRule({ id, allowed, scope: scope() }), changed);
  const removeCustom = createAction((name: string) => api.sensitive.removeCustomRule({ name, scope: scope() }), changed);
  const revoke = createAction((hash: string) => api.sensitive.revoke({ hashes: [hash] }), changed);

  return (
    <>
      <h1>Sensitive files</h1>
      <p class="muted">
        Files that look like they hold credentials are never shown to the agent, summarized or cached. Turn a rule off only for false positives you're sure
        about.
      </p>
      <ScopePicker value={scope()} onChange={setScope} />
      <Loaded resource={data}>
        {(d) => (
          <>
            <section class="box">
              <h2>Detection rules</h2>
              <table>
                <thead>
                  <tr>
                    <th>On</th>
                    <th>Rule</th>
                    <th>Checks</th>
                    <th>Finds</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <For each={d().rules}>
                    {(r) => (
                      <tr>
                        <td>
                          <Show when={!r.custom} fallback="on">
                            <input
                              type="checkbox"
                              aria-label={`Rule ${r.id} on`}
                              checked={!r.allowed}
                              disabled={setRule.pending()}
                              onChange={(e) => void setRule.run(r.id, !e.currentTarget.checked)}
                            />
                          </Show>
                        </td>
                        <td>
                          <code>{r.id}</code>
                        </td>
                        <td>{r.kind === "name" ? "file name" : "content"}</td>
                        <td>
                          {r.reason}
                          <Show when={r.custom}>
                            {(c) => <span class="muted"> ({c().prefix ? `prefix ${c().prefix}` : `regex ${c().regex}`})</span>}
                          </Show>
                        </td>
                        <td>
                          <Show when={r.custom}>
                            <ConfirmButton
                              label="Remove"
                              question={`Remove ${r.id}?`}
                              confirmLabel="Remove"
                              disabled={removeCustom.pending()}
                              onConfirm={() => void removeCustom.run(r.id)}
                            />
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <ErrorText error={setRule.error() ?? removeCustom.error()} />
            </section>

            <AddCustomRule scope={scope()} onAdded={changed} />

            <section class="box">
              <h2>Allowed files</h2>
              <p class="muted">Exceptions for files that were flagged by mistake. Each one is tied to the file's content; if the file changes, it's checked again.</p>
              <Show when={d().files.length} fallback={<p class="muted">None.</p>}>
                <table>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Waives</th>
                      <th>Reason</th>
                      <th>Allowed</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    <For each={d().files}>
                      {(f) => (
                        <tr>
                          <td>
                            {f.name}
                            <For each={f.paths}>
                              {(p) => (
                                <div>
                                  <PathText path={p} />
                                </div>
                              )}
                            </For>
                          </td>
                          <td>
                            {f.content ? "all rules" : "file-name rules"}
                            {f.rule ? <span class="muted"> (flagged by {f.rule})</span> : ""}
                          </td>
                          <td>{f.reason}</td>
                          <td>{dateTime(f.at)}</td>
                          <td>
                            <ConfirmButton
                              label="Revoke"
                              question="Check this file again?"
                              confirmLabel="Revoke"
                              disabled={revoke.pending()}
                              onConfirm={() => void revoke.run(f.hash)}
                            />
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
              <ErrorText error={revoke.error()} />
            </section>
          </>
        )}
      </Loaded>
    </>
  );
}

function AddCustomRule(props: { scope: "global" | "project"; onAdded: () => void }) {
  const [name, setName] = createSignal("");
  const [kind, setKind] = createSignal<"prefix" | "regex">("prefix");
  const [pattern, setPattern] = createSignal("");
  const [reason, setReason] = createSignal("");
  const add = createAction(
    (rule: CustomRule) => api.sensitive.addCustomRule({ rule, scope: props.scope }),
    () => {
      setName("");
      setPattern("");
      setReason("");
      props.onAdded();
    },
  );
  return (
    <section class="box">
      <h2>Add your own rule</h2>
      <p class="muted">
        For a secret the built-in rules don't know, such as your company's tokens. Don't type a whole secret value here. A rule with the same name is
        replaced.
      </p>
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const value = pattern().trim();
          void add.run({
            name: name().trim(),
            ...(kind() === "prefix" ? { prefix: value } : { regex: value }),
            ...(reason().trim() ? { reason: reason().trim() } : {}),
          });
        }}
      >
        <label>
          Name <input type="text" required placeholder="acme-token" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          <span class="muted"> lowercase letters, digits and dashes; the id is custom.&lt;name&gt;</span>
        </label>
        <div class="row">
          <label>
            <input type="radio" name="kind" checked={kind() === "prefix"} onChange={() => setKind("prefix")} /> Values start with
          </label>
          <label>
            <input type="radio" name="kind" checked={kind() === "regex"} onChange={() => setKind("regex")} /> Regular expression
          </label>
          <input type="text" required size={30} placeholder={kind() === "prefix" ? "acme_" : "acme_[A-Za-z0-9]{32}"} value={pattern()} onInput={(e) => setPattern(e.currentTarget.value)} />
        </div>
        <label>
          Reason shown <input type="text" size={40} placeholder="secret value (custom: name)" value={reason()} onInput={(e) => setReason(e.currentTarget.value)} />
        </label>
        <div>
          <button type="submit" class="primary" disabled={add.pending()}>
            Add rule
          </button>
        </div>
      </form>
      <ErrorText error={add.error()} />
    </section>
  );
}
