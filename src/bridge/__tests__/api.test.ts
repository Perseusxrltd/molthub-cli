import { describe, expect, it, vi } from 'vitest';

import {
  completeMissionFromEvidence,
  completionReceiptState,
  fetchMissionPacket,
  submitSourceEvidence,
} from '../api.js';

describe('local bridge API helpers', () => {
  const headers = {
    Authorization: 'Bearer secret-token',
    'User-Agent': 'MoltHub-CLI/test',
  };

  it('fetches mission packets from the existing packet route', async () => {
    const http = {
      get: vi.fn().mockResolvedValue({ data: { packet: { id: 'packet-1' } } }),
    };

    const data = await fetchMissionPacket({
      http,
      baseUrl: 'https://molthub.info/api/v1',
      artifactId: 'artifact-1',
      missionId: 'mission-1',
      format: 'json',
      headers,
    });

    expect(data).toEqual({ packet: { id: 'packet-1' } });
    expect(http.get).toHaveBeenCalledWith(
      'https://molthub.info/api/v1/artifacts/artifact-1/missions/mission-1/packet?format=json',
      { headers },
    );
  });

  it('submits source evidence with PUT and never logs headers', async () => {
    const http = {
      put: vi.fn().mockResolvedValue({ data: { success: true, sourceEvidence: { id: 'evidence-1' } } }),
    };
    const payload = {
      branchName: 'local-bridge-v0',
      workBranch: 'local-bridge-v0',
      evidenceSummary: 'Result summary: Done.',
    };

    const data = await submitSourceEvidence({
      http,
      baseUrl: 'https://molthub.info/api/v1',
      artifactId: 'artifact-1',
      missionId: 'mission-1',
      headers,
      payload,
    });

    expect(data).toEqual({ success: true, sourceEvidence: { id: 'evidence-1' } });
    expect(http.put).toHaveBeenCalledWith(
      'https://molthub.info/api/v1/artifacts/artifact-1/missions/mission-1/source-evidence',
      payload,
      { headers },
    );
  });

  it('submits mission completion only through the existing completion route', async () => {
    const http = {
      post: vi.fn().mockResolvedValue({ data: { success: true, data: { mission: { status: 'completed' } } } }),
    };

    await completeMissionFromEvidence({
      http,
      baseUrl: 'https://molthub.info/api/v1',
      artifactId: 'artifact-1',
      missionId: 'mission-1',
      headers,
      evidence: 'Result summary: Done.',
    });

    expect(http.post).toHaveBeenCalledWith(
      'https://molthub.info/api/v1/artifacts/artifact-1/missions/mission-1/complete',
      { evidence: 'Result summary: Done.' },
      { headers },
    );
  });

  it('requires actual receipts and distinguishes a review draft from completion', async () => {
    for (const body of [{ success: true }, { success: false, sourceEvidence: { id: 'not-saved' } }, '<html>maintenance</html>']) {
      await expect(submitSourceEvidence({ http: { put: vi.fn().mockResolvedValue({ data: body }) }, baseUrl: 'https://molthub.info/api/v1', artifactId: 'project-1', missionId: 'mission-1', headers, payload: { evidenceSummary: 'Done' } })).rejects.toMatchObject({ code: 'ERR_INVALID_API_RECEIPT' });
    }
    expect(completionReceiptState({ success: true, data: { completionDraft: { id: 'draft-1' } } })).toBe('completion_requested');
    expect(completionReceiptState({ success: true, data: { mission: { status: 'completed' } } })).toBe('completed');
    expect(() => completionReceiptState({ success: true, data: {} })).toThrow('receipt');
  });
});
