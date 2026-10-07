# dsh-reasoning-sync

English | [简体中文](README.md)

Sync the reasoning capability a model endpoint publishes into a DSH profile's model configuration —
so the levels in the model picker follow the endpoint instead of being hand-written into
`cordis.patch.yml` and drifting.

> **Status**: design phase. The behavioural contract lives in this repo's spec issue; implementation
> has not started.

## The gap it fills

DSH's built-in "fetch available models" flattens candidate metadata to `id` / `name` /
`contextWindow` / `maxTokens` / `inputModalities`, so the reasoning capability published by the
endpoint never reaches configuration. Reasoning levels are a **per-model** capability: with no
declaration, the picker offers no levels.

This plugin does **not** take over that discovery flow — one settings namespace admits a single
registered discovery implementation, so an outside plugin cannot displace it. It opens a **second,
separate sync channel**:

- the **Host half** resolves the credential, reads the endpoint catalog, plans, and writes;
- the **Client half** registers into the seat the Models settings page reserves for outside plugins,
  showing the difference and triggering a sync;
- the same operation is also exposed as an agent tool: **one operation, two callers**, one
  implementation.

## What it does / does not do

Does:

- shows, inside a provider card, the difference between the levels the endpoint publishes and the
  levels currently declared
- writes that difference with one action, touching only `reasoningEfforts` and never rebuilding a
  model row
- keeps levels following the endpoint: when it gains or drops a level, one re-run aligns them

Does not:

- **change what the "fetch available models" button returns.** That field whitelist lives inside the
  DSH application; only an upstream fix makes "discovery carries capability" true
- add or remove models — it syncs the capability of models **already declared**
- write an `off` key, which is a 400 against a mandatory model
- guess a capability the endpoint never published: unknown models are left alone

## Installing into a profile

To be filled in once implemented: mount as a bundle through `dsh.profile.bundles` in
`~/.dsh/profiles/<profile>/`.

## Running the tests

```bash
npm test
```
