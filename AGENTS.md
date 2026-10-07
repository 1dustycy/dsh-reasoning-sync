## Agent skills

### Issue tracker

Issues live as GitHub issues on `1dustycy/dsh-reasoning-sync`, driven with the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to same-named GitHub labels. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Verification

The agent runs the deterministic in-repo checks — `npm test`, `npm pack --dry-run`, whatever the repo
already scripts — and reports what they found. The user runs what needs their environment: a real DSH
profile, the real app, a real OpenRouter key.

`test/registration.test.mjs` is the one suite that reaches outside the repo: it loads the Models
settings page's slot declaration out of the installed DSH application, so the seat this plugin
registers into is validated by the shipped declaration rather than by this repo's idea of one.
Without the app installed it prints a SKIP line and exits 0, so the suite stays runnable anywhere; a
machine with DSH installed is where it earns its keep.

The **sandbox** is the first thing to rule out when a check looks blocked, and it is never a
finding about the repo or the machine: it bounds where writes land, so find the workaround and run
the check anyway (`npm pack --dry-run --cache /tmp/npm-cache` is the known one). Report a blocked
check as a sandbox limit, with the workaround tried.

## Documentation language

`README.md` is the only outward-facing document, so it is bilingual and the two halves ship together:

- `README.md` — Simplified Chinese; `README.en.md` — English.
- Each opens with switcher links (`English | 简体中文`) directly under the title: the current
  language is plain text, the other one is the link.
- Change both in the same commit and keep them in step — never update one half and leave the
  other stale. Terms follow `CONTEXT.md` (Chinese wording ↔ code identifiers) rather than being
  re-invented per language.

Everything else is internal, written for maintainers and agents, and stays Simplified Chinese:
`docs/`, `CONTEXT.md`, and `AGENTS.md`'s own references. Do not translate them and do not add
English mirrors — the English README may label those links as Chinese instead.
