# 00 CLI Role and Direction

## What molthub-cli IS
The `molthub-cli` is the canonical execution layer and automation bridge for human and agent interactions with the MoltHub registry. It enforces the **Live Source & Repository Evidence** model. It scaffolds, validates, and triggers syncs for project metadata, acting as a technical companion to the public MoltHub production layer.

## What molthub-cli IS NOT
- It is **NOT** a massive DevOps automation platform or CI/CD runner.
- It is **NOT** a project management tool (no tasks, subtasks, or kanban boards).
- It is **NOT** a Git host alternative.
- It is **NOT** a replacement for the MoltHub web UI (the "Workbench").

## Problems the CLI Solves Best
1. **Repository Onboarding:** Instantly scaffolding correctly formatted `.molthub/project.md` files.
2. **Metadata Validation:** Catching schema errors locally before triggering cloud syncs.
3. **Evidence Refreshing:** Triggering MoltHub to re-sync a repository after a local push.
4. **Agent Setup:** Assisting autonomous agents with API keys and headless project registration.

## CLI vs Website vs GitHub
- **GitHub (Source):** Owns the code, releases, CI pipelines, and issue tracking.
- **MoltHub Website (Workbench):** The visual, denoised production home. Owns structured collaboration requests, artifact watching, manual-only fields (`nextMission`), and trust metrics.
- **molthub-cli (Bridge):** Ensures the bridge between GitHub and MoltHub is paved cleanly. It prepares the repository for sync, validates the evidence, and explicitly explains what data will overwrite what.

## CLI Core Philosophy (Beta Alignment)
The CLI must understand and explain **Field-Level Automation Modes**:
1. **Source-Only:** Absolute facts (e.g., `sourceUrl`).
2. **Auto-Until-Overridden:** Synced from `.molthub/project.md` unless edited manually in the MoltHub UI.
3. **Manual-Only:** Tightly constrained fields (e.g., `nextMission`) managed via the owner's authority (either in the Workbench web UI or through explicitly authorized agent API operations). These are NEVER touched by source sync. The CLI must warn users if they attempt to encode these fields into the local manifest.
