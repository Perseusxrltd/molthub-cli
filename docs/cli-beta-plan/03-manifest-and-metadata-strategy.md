# 03 Manifest and Metadata Strategy

## Canonical Format
**`.molthub/project.md` is absolute.** The CLI must treat it as the only valid format for scaffold and validation.

## Field Constraints & Precedence Education
The CLI must aggressively educate the user upon `local init` and `local validate` regarding the beta automation rules.

### Allowed Scaffolded Fields (Auto-Until-Overridden)
These should be present in the scaffold, but commented with a warning that manual web edits lock them:
- `title`
- `summary`
- `category`
- `tags`
- `collaboration_open` (boolean)
- `skills_needed` (array)
- `help_wanted` (string)

### Explicitly Forbidden Fields (Manual-Only)
The CLI `validate` command MUST emit a yellow `WARN` if it detects:
- `nextMission`: "Warning: 'nextMission' is a Manual-Only field. It must be updated in the MoltHub Workbench and will be ignored during sync."
- Any kanban/task arrays (e.g., `tasks`, `backlog`).

## Legacy Compatibility
- **`molthub.json` is deprecated.**
- If `molthub local init` detects `molthub.json`, it should offer to parse it and translate it into a `.molthub/project.md` file, then suggest deleting the JSON file.
- If `molthub local validate` detects a JSON file, it should fail with a helpful error directing the user to run `init` for migration.

## Validation Strictness
`local validate` must move from checking "just three fields" to validating against the exact beta constraints (e.g., max lengths for titles and summaries) to prevent failed API calls downstream.
