# 11 QA and Release

## Automated Testing Needs
- **Unit Test:** `local validate` successfully catches and warns on `nextMission`.
- **Unit Test:** `local init` auto-migration cleanly translates a complex `molthub.json` into a valid `.molthub/project.md`.

## Manual QA Checklist
1. Run `molthub local init` in an empty directory. Verify the generated Markdown file has the correct inline comments and no PM checkboxes.
2. Run `molthub local validate` on a manifest that contains `nextMission: "Testing"`. Verify the terminal emits a yellow warning and does not crash.
3. Create a dummy `molthub.json` and run `molthub local init`. Verify it translates the file to Markdown and prompts the user.
4. Run `molthub project create` and verify the output mentions the "Auto-Until-Overridden" rule.

## Release Criteria
- `SKILL.md` teaches agents the exact beta field boundaries.
- The CLI enforces the `.molthub/project.md` absolute standard.
- The CLI prevents accidental kanban drift via strict validation warnings.
