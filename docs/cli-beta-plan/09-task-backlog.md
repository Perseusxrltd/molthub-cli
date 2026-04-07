# 09 Task Backlog

## WS-1: SKILL.md and Documentation Alignment
- **T-1.1:** Rewrite `SKILL.md` to introduce the 3 automation modes and the Workbench.
- **T-1.2:** Update `SKILL.md` to explicitly forbid encoding kanban/tasks or `nextMission` in `.molthub/project.md`.
- **T-1.3:** Update `README.md` to use beta terminology and reflect the updated `local init` outputs.

## WS-2: Manifest Validator and Scaffold Hardening
- **T-2.1:** Update the template string in `molthub local init` to use beta keys (`collaboration_open`, `help_wanted`) and include inline comments explaining automation rules.
- **T-2.2:** Update `molthub local validate` to enforce max lengths on `title`, `summary`, etc.
- **T-2.3:** Add logic to `molthub local validate` to detect `nextMission` and issue a `[WARN]` that it is a Manual-Only field.

## WS-3: Legacy Migration
- **T-3.1:** Add detection logic to `local init` to check for `molthub.json`.
- **T-3.2:** Implement translation function from `molthub.json` keys to `.molthub/project.md` YAML.
- **T-3.3:** Update `local validate` to throw an error if `molthub.json` is used instead of `.molthub/project.md`.

## WS-4: Command Output Terminology
- **T-4.1:** Audit `src/index.ts` for any hardcoded strings mentioning "dashboard" and replace with "Workbench" or "registry".
- **T-4.2:** Append a warning in `molthub project create` output: `Note: Web-edited fields (Title, Summary, etc.) are Auto-Until-Overridden and will not be overwritten by this CLI.`
