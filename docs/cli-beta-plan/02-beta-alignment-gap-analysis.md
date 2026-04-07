# 02 Beta Alignment Gap Analysis

## 1. Automation Mode Ignorance (High Priority)
**Gap:** The CLI blindly creates and syncs manifests without warning users that manual web edits will cause syncs to skip certain fields (Auto-Until-Overridden).
**Impact:** Users will edit `.molthub/project.md`, trigger a sync, and get frustrated when the web UI doesn't update, not realizing they overrode the field on the web.
**Fix Type:** CLI Logic (Warning outputs), Documentation, SKILL.md.

## 2. `nextMission` vs Project Management Noise (High Priority)
**Gap:** The `local init` template includes an empty checklist under `# Capabilities`. The CLI has no concept of the new, highly constrained `nextMission` field.
**Impact:** Encourages users/agents to treat the README/manifest as an issue tracker, directly violating beta product direction. Users may also try to put `nextMission: ...` in their YAML and wonder why it doesn't sync.
**Fix Type:** Templates, Validation logic (warning on illegal fields).

## 3. Stale SKILL.md (Medium Priority)
**Gap:** `SKILL.md` pre-dates the Workbench and the three automation modes. It still implies the repository rules everything entirely.
**Impact:** Agents operating on MoltHub repos will give humans incorrect advice and fail to understand why certain fields aren't updating.
**Fix Type:** Documentation.

## 4. Scaffolded Template Keys (Medium Priority)
**Gap:** `molthub local init` produces keys that aren't perfectly mapped or are outdated (`collaboration` vs `collaboration_open`, `looking_for` vs `help_wanted`).
**Impact:** Data loss on sync.
**Fix Type:** Templates.

## 5. Legacy `molthub.json` Handling (Low Priority)
**Gap:** While the CLI doesn't create `molthub.json`, it also doesn't detect it or help users migrate.
**Impact:** Minor friction for early alpha users migrating to beta.
**Fix Type:** CLI Logic (Migration prompt in `doctor` or `init`).
