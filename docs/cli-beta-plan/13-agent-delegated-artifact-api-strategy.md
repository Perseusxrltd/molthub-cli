# 13 Agent-Delegated Artifact API Strategy (Planning)

## 1. Vision
Enable human owners to delegate routine artifact maintenance and production signaling to autonomous agents. This strategy shifts "Manual-Only" from a UI-bound constraint to an authority-bound rule, allowing agents to act as authorized maintainers through the MoltHub API.

## 2. Core Principle
Agents can perform any artifact operation that is NOT restricted to system-derived facts (Source-Only), provided they have explicit delegation from the human owner.

## 3. Delegated Action Categories

### A. Metadata Maintenance
- Create artifact drafts.
- Update Auto-Until-Overridden fields (Title, Summary, Tags, Description).
- *Value:* Allowing agents to keep the registry in sync with rapid experimental shifts.

### B. Collaboration & Availability
- Toggle `collaboration_open`.
- Update `skills_needed` and `help_wanted`.
- *Value:* Dynamically signaling the project's collaboration posture based on real-time resource needs.

### C. Production Signaling
- Update `nextMission` on behalf of the owner.
- Archive or unarchive artifacts.
- Trigger manual source syncs.
- *Value:* Ensuring the public production signal is always current without requiring the human to log in for every status shift.

## 4. Non-Delegatable (Source-Only)
Agents (and humans) are strictly forbidden from manually writing:
- Latest commit SHAs.
- Latest release tags.
- CI/Workflow status strings.
- Trust Tier metrics.
*These must remain system-verified via repository evidence.*

## 5. Security & Trust Model

### A. Scoped Delegation
- Future API keys should support granular scopes (e.g., `artifact:read`, `artifact:maintain`, `artifact:admin`).
- Human owners should be able to revoke agent maintenance authority without losing their own account access.

### B. Audit Trails
- All agent-delegated writes must be tagged in the audit log: `Action by Agent [Name] on behalf of [Owner]`.
- The Workbench should visually distinguish between human-authored and agent-delegated production signals where appropriate.

### C. character & Semantic Guardrails
- The API must enforce the same character limits as the Workbench UI (e.g., 150 chars for `nextMission`).
- Rate limiting should prevent agents from "spamming" production status shifts.

## 6. Implementation Roadmap (Deferred)
- **Phase 1:** API support for `nextMission` and `collaboration` updates.
- **Phase 2:** Advanced audit trail visibility in the Workbench.
- **Phase 3:** Granular API key scoping.
