import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_TEMPLATE,
  buildCompletionEvidence,
  buildSourceEvidencePayload,
  parseEvidenceTemplate,
} from '../evidence.js';

describe('local bridge evidence parsing', () => {
  it('exports the exact v0 evidence template', () => {
    expect(EVIDENCE_TEMPLATE).toBe(`# MoltHub Mission Evidence

Mission:
Packet checksum:
Executor used:
Branch:
Commit:
PR URL:
Changed paths:
Tests run:
Result summary:
Issues / blockers:
Memory update notes:
`);
  });

  it('maps branch, commit, PR, paths, tests, and summary to source evidence', () => {
    const fields = parseEvidenceTemplate(`# MoltHub Mission Evidence

Mission: Local Bridge MVP
Packet checksum: packet-123
Executor used: Codex CLI manually
Branch: local-bridge-v0
Commit: abcdef1234567890
PR URL: https://github.com/example/repo/pull/12
Changed paths: src/bridge/evidence.ts, src/index.ts
Tests run: npm test
Result summary: Added bridge evidence submission.
Issues / blockers: None.
Memory update notes: Remember that bridge v0 does not execute tools.
`);

    expect(fields.changedPaths).toEqual(['src/bridge/evidence.ts', 'src/index.ts']);
    expect(buildSourceEvidencePayload(fields)).toMatchObject({
      branchName: 'local-bridge-v0',
      workBranch: 'local-bridge-v0',
      headCommitSha: 'abcdef1234567890',
      pullRequestUrl: 'https://github.com/example/repo/pull/12',
      changedPaths: ['src/bridge/evidence.ts', 'src/index.ts'],
      evidenceSummary: expect.stringContaining('Tests run: npm test'),
    });
  });

  it('maps commit URLs separately from commit SHAs', () => {
    const fields = parseEvidenceTemplate(`# MoltHub Mission Evidence

Mission: Local Bridge MVP
Packet checksum: packet-123
Executor used: Codex CLI manually
Branch: local-bridge-v0
Commit: https://github.com/example/repo/commit/abcdef1234567890
PR URL:
Changed paths:
- src/bridge/evidence.ts
- src/index.ts
Tests run: npm test
Result summary: Added bridge evidence submission.
Issues / blockers:
Memory update notes:
`);

    expect(buildSourceEvidencePayload(fields)).toMatchObject({
      headCommitUrl: 'https://github.com/example/repo/commit/abcdef1234567890',
      changedPaths: ['src/bridge/evidence.ts', 'src/index.ts'],
    });
  });

  it('omits non-URL PR notes from the source evidence URL field', () => {
    for (const prText of ['No PR was opened.', 'No PR created', 'no pull request', 'N/A', 'none', 'No PR; committed directly to master.']) {
      const fields = parseEvidenceTemplate(`# MoltHub Mission Evidence

Mission: Local Bridge MVP
Packet checksum: packet-123
Executor used: Codex CLI manually
Branch: local-bridge-v0
Commit: abcdef1234567890
PR URL: ${prText}
Changed paths: src/bridge/evidence.ts
Tests run: npm test
Result summary: Added bridge evidence submission.
Issues / blockers:
Memory update notes:
`);

      expect(buildSourceEvidencePayload(fields)).not.toHaveProperty('pullRequestUrl');
    }
  });

  it('only maps GitHub PR and GitLab MR links as pull request URLs', () => {
    const githubCommit = parseEvidenceTemplate(`# MoltHub Mission Evidence

Mission: Local Bridge MVP
Packet checksum: packet-123
Executor used: Codex CLI manually
Branch: local-bridge-v0
Commit: abcdef1234567890
PR URL: https://github.com/example/repo/commit/abcdef1234567890
Changed paths: src/bridge/evidence.ts
Tests run: npm test
Result summary: Added bridge evidence submission.
Issues / blockers:
Memory update notes:
`);
    const gitlabMr = parseEvidenceTemplate(`# MoltHub Mission Evidence

Mission: Local Bridge MVP
Packet checksum: packet-123
Executor used: Codex CLI manually
Branch: local-bridge-v0
Commit: abcdef1234567890
PR URL: https://gitlab.com/acme/platform/app/-/merge_requests/17
Changed paths: src/bridge/evidence.ts
Tests run: npm test
Result summary: Added bridge evidence submission.
Issues / blockers:
Memory update notes:
`);

    expect(buildSourceEvidencePayload(githubCommit)).not.toHaveProperty('pullRequestUrl');
    expect(buildSourceEvidencePayload(gitlabMr)).toMatchObject({
      pullRequestUrl: 'https://gitlab.com/acme/platform/app/-/merge_requests/17',
    });
  });

  it('preserves useful line breaks in evidence summaries', () => {
    const fields = parseEvidenceTemplate(`# MoltHub Mission Evidence

Mission: Local Bridge MVP
Packet checksum: packet-123
Executor used: Codex CLI manually
Branch: local-bridge-v0
Commit: abcdef1234567890
PR URL:
Changed paths: src/bridge/evidence.ts
Tests run: npm test
Result summary: Added bridge evidence submission.
  Preserved .molthub/project.md as canonical.
Issues / blockers: None.
Memory update notes: First line.
Second line.
`);

    expect(buildSourceEvidencePayload(fields).evidenceSummary).toContain(
      'Result summary: Added bridge evidence submission.\nPreserved .molthub/project.md as canonical.',
    );
    expect(buildSourceEvidencePayload(fields).evidenceSummary).toContain(
      'Memory update notes: First line.\nSecond line.',
    );
  });

  it('rejects evidence with no result summary before API mutation', () => {
    const fields = parseEvidenceTemplate(EVIDENCE_TEMPLATE);

    expect(() => buildSourceEvidencePayload(fields)).toThrow('Result summary');
  });

  it('builds completion evidence without including secrets or auth headers', () => {
    const fields = parseEvidenceTemplate(`# MoltHub Mission Evidence

Mission: Local Bridge MVP
Packet checksum: packet-123
Executor used: Codex CLI manually
Branch: local-bridge-v0
Commit: abcdef1234567890
PR URL:
Changed paths: src/index.ts
Tests run: npm test
Result summary: Added bridge evidence submission.
Issues / blockers: None.
Memory update notes: Keep owner-reviewed memory boundary.
`);

    const completion = buildCompletionEvidence(fields);

    expect(completion).toContain('Result summary: Added bridge evidence submission.');
    expect(completion).toContain('Memory update notes: Keep owner-reviewed memory boundary.');
    expect(completion).not.toContain('Authorization');
    expect(completion).not.toContain('Bearer');
  });
});
