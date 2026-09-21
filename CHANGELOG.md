# Changelog

## 3.6.0 — unpublished release candidate

This candidate is a local production reliability upgrade. It has not been tagged or published to npm by this work.

- Expand offline `doctor` with runtime, repository, metadata, run health, and actionable next steps while retaining legacy check fields.
- Add `mission run list` with project/status filters, proof readiness, and independent reporting of corrupt run folders.
- Add `mission evidence validate`, submission and completion dry runs, and optional manual/no-repo proof modes coordinated with the web API.
- Prevent run preparation from overwriting existing proof. Record the absolute worktree and preparation commit; capture committed, staged, and unstaged changes, preserving unusual filenames and filtering sensitive paths.
- Validate local run identity, packet binding, API limits, secret patterns, and proof paths before writes or submission. Preview and submit one validated evidence snapshot.
- Require concrete server receipts. Persist `submission.json` and `completion.json`; distinguish completed work from owner-review drafts and preserve partial server success if a subsequent step fails.
- Correct the commit URL API field, preserve saved source proof during combined completion, and reject empty or oversized completion before any API request.
- Return JSON usage errors consistently and flush machine-readable output synchronously before exit.
- Update Axios, js-yaml, fs-extra, Chalk, and Vitest within supported major versions; remove the nine vulnerabilities found in the initial dependency audit.
- Test the built package executable rather than starting a TypeScript compiler for every command. Add bounded Windows-friendly integration timeouts and Linux/Windows CI with Node 22.

Compatibility notes: existing command paths and JSON envelopes remain. Doctor's missing-auth condition is now an offline warning. Diagnostic report failures use a successful inspection envelope with exit 1. Local status setters can no longer invent server submission/completion. `Mission:` must contain the mission ID; older proof files containing only a display title must be corrected. Older runs without a resolvable preparation commit report limited history coverage. New optional proof modes require the coordinated web API update.

The local bridge still prepares files and reads Git proof; it does not launch coding agents, execute tests, create branches, deploy changes, or accept Project Memory. Runtime tests in this work use disposable local repositories and loopback HTTP fixtures. Production authorization and external service behavior require their own release verification.

## 3.5.1

Security hardening for local ledger and evidence collection trust boundaries.
