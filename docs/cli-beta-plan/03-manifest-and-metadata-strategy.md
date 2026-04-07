# 03 Manifest and Metadata Strategy

## Canonical Format
**`.molthub/project.md` is the ultimate authority.** The CLI treats the repository as the primary "dev" interface for setting up and updating project information. Any modifications made directly on the website are treated as temporary or pending states that should eventually be reconciled into the repository manifest.

## Field Constraints & Precedence Education
The CLI must aggressively educate the user that while the Workbench allows quick edits, the repository is the gold standard for stability.

### Allowed Scaffolded Fields (Repo-First)
These should be present in the scaffold. Users should be encouraged to maintain these in Git:
- `title`
- `summary`
- `category`
- `tags`
- `collaboration_open` (boolean)
- `skills_needed` (array)
- `help_wanted` (string)

*Note: The CLI will warn if local changes are being ignored due to a web override, advising the user to either revert the web edit or update the manifest to match.*

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
