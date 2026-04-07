# 08 Workstreams

## WS-1: SKILL.md and Documentation Alignment
**Goal:** Rewrite `SKILL.md` to reflect the beta reality, instructing agents properly on automation modes and the Workbench.
**Rationale:** Agents reading this repo will make bad assumptions without it.
**Risk:** Low (Documentation only).

## WS-2: Manifest Validator and Scaffold Hardening
**Goal:** Update `molthub local init` and `molthub local validate`.
**Rationale:** Prevents bad data from entering the sync pipeline. Teaches users about `nextMission` constraints and automation overrides.
**Risk:** Medium (Changes local file creation and validation logic).

## WS-3: Legacy Migration
**Goal:** Add `molthub.json` detection and auto-migration to `local init`.
**Rationale:** Smooths the path for alpha users.
**Risk:** Low.

## WS-4: Command Output Terminology
**Goal:** Clean up terminal strings across all commands to use beta terms (e.g., replace `dashboard` with `Workbench`, add warnings about Auto-Until-Overridden).
**Rationale:** Consistent UX.
**Risk:** Low.
