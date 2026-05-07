import type { BridgeHttpClient, PacketFormat, SourceEvidencePayload } from './types.js';

function encodePathSegment(value: string) {
  return encodeURIComponent(value);
}

function missionBase(baseUrl: string, artifactId: string, missionId: string) {
  return `${baseUrl}/artifacts/${encodePathSegment(artifactId)}/missions/${encodePathSegment(missionId)}`;
}

export async function fetchMissionPacket(input: {
  http: Pick<BridgeHttpClient, 'get'>;
  baseUrl: string;
  artifactId: string;
  missionId: string;
  format: PacketFormat;
  headers: Record<string, string>;
}) {
  const url = `${missionBase(input.baseUrl, input.artifactId, input.missionId)}/packet?format=${input.format}`;
  const response = await input.http.get(url, { headers: input.headers });
  return response.data;
}

export async function submitSourceEvidence(input: {
  http: Pick<BridgeHttpClient, 'put'>;
  baseUrl: string;
  artifactId: string;
  missionId: string;
  headers: Record<string, string>;
  payload: SourceEvidencePayload;
}) {
  const url = `${missionBase(input.baseUrl, input.artifactId, input.missionId)}/source-evidence`;
  const response = await input.http.put(url, input.payload, { headers: input.headers });
  return response.data;
}

export async function completeMissionFromEvidence(input: {
  http: Pick<BridgeHttpClient, 'post'>;
  baseUrl: string;
  artifactId: string;
  missionId: string;
  headers: Record<string, string>;
  evidence: string;
  sourceEvidence?: SourceEvidencePayload;
}) {
  const url = `${missionBase(input.baseUrl, input.artifactId, input.missionId)}/complete`;
  const body = input.sourceEvidence
    ? { evidence: input.evidence, sourceEvidence: input.sourceEvidence }
    : { evidence: input.evidence };
  const response = await input.http.post(url, body, { headers: input.headers });
  return response.data;
}
