# dsh-reasoning-sync

English | [简体中文](README.md)

Sync the reasoning capability a model endpoint publishes into a DSH profile's model configuration —
so the levels in the model picker follow the endpoint instead of being hand-written into
`cordis.patch.yml` and drifting.

Open Settings → Models and the OpenRouter card shows the difference between **the levels the endpoint
publishes** and **the levels currently declared** — both sides, plus the level the endpoint falls
back to; one click aligns them. The same operation is also
exposed as an agent tool: **one operation, two callers**, one implementation.

## The gap it fills

DSH's built-in "fetch available models" flattens candidate metadata to `id` / `name` /
`contextWindow` / `maxTokens` / `inputModalities`, so the reasoning capability published by the
endpoint never reaches configuration. Reasoning levels are a **per-model** capability: with no
declaration, the picker offers no levels.

This plugin does **not** take over that discovery flow — one settings namespace admits a single
registered discovery implementation, so an outside plugin cannot displace it. It opens a **second,
separate sync channel**: read the endpoint catalog, work out each model's level declaration, write it.

It syncs the capability of models **already declared**; the discovery flow governs **adopting
candidates**. The two do not conflict, and this plugin keeps earning its keep after an upstream fix.

## Installing into a profile

Use Plugin Manager's `install_bundle` with this package's absolute directory as the target. It writes
the profile's `package.json` and bundle selection for you — do **not** hand-edit the profile's
`package.json` or `cordis.patch.yml`, and do not run pnpm in the profile directory.

Afterwards the profile carries one `reasoning-sync` row, contributed by this package's own
`cordis.patch.yml`.

## Using it

### The card in Settings

In Settings → Models, the card of a route this plugin serves (one whose `baseURL` points at
`openrouter.ai`) grows a panel:

- it previews on open with **a row for every declared model**: one already in step says "up to date ·
  its current levels", one that drifts says "declared X → endpoint Y", and a model with no published
  capability, one missing from the catalog, and one publishing levels this adapter cannot read are
  each named in turn; when nothing on the route drifts, the headline itself says up to date;
- when something differs, "Sync into configuration" writes it and then re-reads, so "up to date" is
  the Host's answer rather than optimism;
- a failure is shown with its reason (no credential, endpoint 401/500, non-JSON, revision conflict,
  unwritable configuration) and **nothing is written**.

### What the picker's "Default" is

Besides the levels a sync puts there, the model menu carries a **Default** entry (locale key
`effort.providerDefault`). It is **not** part of `reasoningEfforts` and no sync wrote it: it is the
provider default, and choosing it sends no level instruction at all, leaving the endpoint to decide
by its own `default_effort` — the "default medium" the card reports is exactly where it lands.

**Where it lands is the endpoint's `default_effort`** — the "default medium / high" at the end of
each card row reports exactly that (and is absent when the endpoint publishes none).

It is always there, because this plugin writes neither "provider default" nor a route-level default
level (stories 29 / 30). Making it disappear would take a route-level `reasoning` (which changes the
default behaviour of every model on the route) or an `off` key (a straight 400 against a mandatory
model) — neither of which this plugin will do.

One more thing: `default` is not one of the names in `supported_efforts`, so `reasoningEfforts` has
no `default` key either — writing one is refused by the adapter's schema (measured: the key set is
those seven names). "Default" is expressed in configuration by not selecting anything.

### The agent tool

The tool is named `reasoning_sync`:

| Parameter | Meaning |
| --- | --- |
| `provider` | route key, e.g. `openrouter-live` (required) |
| `action` | `preview` reads and plans, `apply` writes (the default) |

Both paths call the same operation and return the same result, field for field.

## What it does / does not do

Does:

- touches **already declared** models only, and writes the `reasoningEfforts` field alone —
  `name`, `contextWindow`, `maxTokens`, `input` and `compat` are never rebuilt or reordered;
- adds a level the endpoint gained and removes one it dropped;
- treats a model the endpoint publishes no capability for as **unknown** and leaves it alone
  (unknown is not non-reasoning);
- leaves a model declared in configuration but absent from the endpoint catalog (a cloaked model,
  `stealth/*` for instance) exactly as it is, and names it in the report;
- writes `reasoningEfforts: false` when the endpoint explicitly publishes no declarable level
  (non-reasoning);
- reports a level the adapter does not know rather than guessing a mapping — and never deletes
  existing levels because of one;
- removes an already declared `off` on a model the endpoint publishes as `mandatory` (reasoning
  cannot be disabled), and names it in the report — keeping it is what produces that 400
  (ADR-0005). Where the endpoint does not say so, `off` rides through untouched.

Does not:

- **change what the "fetch available models" button returns.** That field whitelist lives inside the
  DSH application; only an upstream fix makes "discovery carries capability" true;
- **ever write an `off` key**, valueless `off:` included — against a mandatory model that is a
  straight 400. An existing `off` declaration rides through unrelated edits untouched: the plugin
  neither adds nor removes it;
- write a route-level default level (`providers.<route>.reasoning`), or write "provider default";
- sync on its own: every sync is triggered explicitly by the user or the agent.

## Known limits and risks

- **The card appears only on `openrouter.ai` routes.** The mapping is OpenRouter's
  `reasoning.supported_efforts`; another endpoint speaks a different vocabulary and this plugin does
  not guess at it. Every other provider card is untouched. To serve another endpoint, check its
  catalog shape before changing `CATALOG_HOSTS` in `lib/routes.js`.
- **The route list is read once when the page loads.** A newly added OpenRouter route needs a page
  refresh before its card appears; cards already on screen are unaffected (every action re-reads the
  configuration).
- **The write lands in the profile's `cordis.patch.yml`** — the same file the settings UI writes.
  Measured (the replay steps are in `docs/adr/0004`, Chinese): comments **inside** the
  written row's `config` block are lost, while the rest of the file — the header comment, other rows,
  key order, indentation — is preserved byte for byte. Keep commentary **above the row**, or in the
  repo's docs, rather than under `providers:`. The fields the plugin writes land precisely.
- It needs a usable credential for the route (read from the profile's `apiKeyEnv` through the
  credentials service, falling back to the launch environment). Without one it reports "no
  credential" and writes nothing.
- Writes are revision-checked: a configuration changed elsewhere is refused with a re-run hint rather
  than overwritten.

## Running the tests

```bash
npm test
```

Eight deterministic suites: the plan function's mapping rules exhausted; the Host operation against
injected doubles; the routes and the `apply` wiring; the client bundle loaded in a vm and driven
through rendering and actions; the package's own declarations and profile wiring.

`test/registration.test.mjs` is the one suite that reaches outside the repo: it lifts the Models
settings page's seat declaration, the slot registry, the tool registry's schema checker and its
endpoint-segment grammar out of the **installed DSH application**, and validates this plugin's seat
claim and tool schemas with them. Without the app installed it prints a loud SKIP and exits 0.
