export type ReviewVerdict = 'pass' | 'fail';
export type DeliveryReviewItem = { criterion: string; verdict: ReviewVerdict; note: string };
export type DeliveryArtifact = {
  key: string; reference: string; state: 'available' | 'missing' | 'forbidden' | 'unregistered' | 'unversioned';
  name?: string; fileId?: string; sessionPath?: string | null; ext?: string; sha256?: string; size?: number;
  resource?: { resourceId: string; studioId: string; links: { self: string; content?: string } };
  reason?: string;
};
export type CompanyDelivery = {
  taskId: string; version: string; revision: number; report: string; status: string; dueAt: string | null;
  criteria: { criterion: string; selfReport: { passed: boolean | null; evidence: string } | null }[];
  artifacts: DeliveryArtifact[];
  review: { state: 'unreviewed' | 'current' | 'stale'; reviewedAt?: string; items?: DeliveryReviewItem[]; version?: string };
  note: string;
};
