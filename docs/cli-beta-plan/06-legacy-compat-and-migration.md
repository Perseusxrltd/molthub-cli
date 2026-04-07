# 06 Legacy Compatibility & Migration

## Approach to `molthub.json`
`molthub.json` is fully deprecated in Beta.

### 1. Detection & Warning
If `molthub project create`, `molthub local validate`, or `molthub local init` detects a `molthub.json` file in the root:
- The CLI should output a `[WARN] Legacy molthub.json detected.`

### 2. Auto-Migration via `init`
If the user runs `molthub local init` and `molthub.json` exists but `.molthub/project.md` does not:
- The CLI should parse the JSON.
- It should map the keys to the new `.molthub/project.md` frontmatter schema.
- It should write the new `.molthub/project.md` file.
- It should ask the user (or instruct them) to delete `molthub.json`.

### 3. Hard Failure on Validation
`molthub local validate` should refuse to validate `molthub.json` and return an error: `MoltHub Beta requires .molthub/project.md. Run 'molthub local init' to migrate.`
