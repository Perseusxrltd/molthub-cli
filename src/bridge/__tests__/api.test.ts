import { describe, expect, it, vi } from 'vitest';

import {
  completeMissionFromEvidence,
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
      put: vi.fn().mockResolvedValue({ data: { sourceEvidence: { id: 'evidence-1' } } }),
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

    expect(data).toEqual({ sourceEvidence: { id: 'evidence-1' } });
    expect(http.put).toHaveBeenCalledWith(
      'https://molthub.info/api/v1/artifacts/artifact-1/missions/mission-1/source-evidence',
      payload,
      { headers },
    );
  });

  it('submits mission completion only through the existing completion route', async () => {
    const http = {
      post: vi.fn().mockResolvedValue({ data: { data: { mission: { status: 'completed' } } } }),
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
});
