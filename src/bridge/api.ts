import type { BridgeHttpClient, PacketFormat, SourceEvidencePayload } from './types.js';
import { LocalBridgeError } from './safety.js';

export function completionReceiptState(value: unknown): 'completed' | 'completion_requested' {
  const body = value as any;
  if (body?.success === true && body.data?.mission?.status === 'completed') return 'completed';
  if (body?.success === true && typeof body.data?.completionDraft?.id === 'string' && body.data.completionDraft.id.trim()) return 'completion_requested';
  throw new LocalBridgeError('ERR_INVALID_API_RECEIPT', 'The server did not return a mission completion or review-draft receipt. Check server history before retrying.');
}

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
  const body = response.data as any;
  if (body?.success !== true || typeof body.sourceEvidence?.id !== 'string' || !body.sourceEvidence.id.trim()) {
    throw new LocalBridgeError('ERR_INVALID_API_RECEIPT', 'The server did not return a saved source-evidence receipt. Check server history before retrying.');
  }
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
  completionReceiptState(response.data);
  return response.data;
}
