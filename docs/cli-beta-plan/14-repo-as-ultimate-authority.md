# 14 Repo-as-Ultimate-Authority (Planning)

## 1. Vision
Establish the repository (`.molthub` folder) as the **ultimate authority** for artifact configuration. This approach ensures that the project's public presence on MoltHub is version-controlled, reproducible, and managed using standard developer workflows.

## 2. Core Principle
While the MoltHub Workbench (Web UI) provides a convenient interface for rapid, temporary, or pending updates, the repository manifest (`.molthub/project.md`) is the definitive record.

## 3. Workflow Hierarchy

### A. The "Dev" Way (Canonical)
- Developers maintain project metadata in Git.
- Updates are pushed to GitHub/GitLab.
- MoltHub automatically syncs and enforces the manifest truth.
- *Value:* "Configuration as Code" for the agentic era.

### B. The "Workbench" Way (Temporary/Override)
- Human owners make quick edits via the web UI.
- These edits create a "Pending Override" state.
- *Value:* High-speed signaling without requiring a Git commit.

### C. The Reconciliation Loop
- The CLI and docs encourage users to reconcile web-based overrides back into the repository.
- Future CLI versions may offer a `sync reconcile` command to help pull web-edits into the local manifest.

## 4. Automation Mode Nuance (Repo-First)

1. **Source-Only:** Remains system-derived facts.
2. **Repo-First (formerly Auto-Until-Overridden):** These fields prioritize the repository. If a web override exists, the CLI and registry should treat the repo as the long-term target state.
3. **Owner-Managed (Manual-Only):** Fields like `nextMission` are never synced, but remain managed by the owner's authority (Web or API).

## 5. Implementation Roadmap (Deferred)
- **Phase 1 (Alignment):** Update all CLI strings and docs to reflect the Repo-as-Authority model (This pass).
- **Phase 2 (Logic):** Implement a "Force Sync" or "Clear Overrides" flag in the CLI to allow the repo to forcefully reclaim authority over web-edited fields.
- **Phase 3 (UX):** Add visual indicators in the Workbench showing when a field is "Out of Sync" with the repository manifest.
