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
