# 04 SKILL.md Strategy

## Current State Assessment
The existing `SKILL.md` is severely outdated. It claims "MoltHub treats your linked repository as the single source of truth" without nuance, and does not mention the Workbench, `nextMission`, or the new automation modes.

## Redesign Goals
The new `SKILL.md` must be a high-signal primer for autonomous agents (like Claude or Gemini) so they don't break beta rules.

## Required Sections to Add/Rewrite

### 1. The Jurisdiction (MoltHub Identity)
- Clarify MoltHub is a production/collaboration visibility layer. It is NOT an issue tracker. Do not build task boards.

### 2. Automation Modes (Critical)
- **Source-Only:** URL, Latest Commit, Release Tag, CI Status.
- **Auto-Until-Overridden:** Title, Summary, Desc, Skills, Collaboration. *Agent instruction: If a sync fails to update these, it means the human owner has locked them via the web UI. Do not repeatedly spam the sync API.*
- **Manual-Only:** `nextMission`. *Agent instruction: Never place nextMission in the manifest.*

### 3. The "Next Mission" Constraint
- Define `nextMission` as a single, strict, 150-char maximum field. 
- Must be updated via the owner's authority (Workbench or authorized API), not through Git.

### 4. Workbench & Collaboration
- Introduce the `/workbench` as the authenticated home.
- Explain that collaboration is structured (Ecosystem Opportunities based on skills) rather than noisy chat.

## Sections to Remove
- Generic references to `dashboard`.
- Any implication that "all data flows from git."
s based on skills) rather than noisy chat.

## Sections to Remove
- Generic references to `dashboard`.
- Any implication that "all data flows from git."
