export type Tag = 'ping' | 'traceroute' | 'dns' | 'sslcert' | 'http' | 'ntp' | 'ipv4' | 'ipv6' | 'anchors' | 'other';
export const TAGS: Tag[] = ['ping', 'traceroute', 'dns', 'sslcert', 'http', 'ntp', 'ipv4', 'ipv6', 'anchors', 'other'];

export interface Project {
  id: string;
  ownerName: string;
  title: string;
  summary: string;
  description: string;
  creditsRequested: number;
  creditsConfirmed: number;
  creditsPending: number;
  status: 'open' | 'closed';
  funded: boolean;
  open: boolean;
  remaining: number;
  capacity: number;
  maxPledge: number;
  maxCredits: number;
  tags: Tag[];
  affiliation: string;
  homepageUrl: string;
  repoUrl: string;
  paperUrl: string;
  deadline: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pledge {
  id: string;
  projectId: string;
  donorName: string;
  amount: number;
  method: 'api' | 'manual';
  status: 'pledged' | 'sent' | 'confirmed' | 'cancelled';
  message: string;
  apiTransfer: boolean;
  hasReference: boolean;
  transferUncertain?: boolean;
  createdAt: string;
  updatedAt: string;
  donorId?: string;
  transactionUrl?: string;
  transactionId?: string;
  transferredAt?: string;
  projectTitle?: string;
}

export interface User {
  id: string;
  provider: string;
  handle: string;
  displayName: string;
  atlasEmail: string;
  affiliation: string;
  url: string;
  hasAtlasEmail: boolean;
}

// Mirrors publicUser() in api/src/lib/views.ts. The sign-in handle is deliberately absent:
// for some identity providers it is the user's email address.
export interface PublicUser {
  displayName: string;
  affiliation: string;
  url: string;
  provider: string;
}

export interface Stats {
  projects: number;
  openProjects: number;
  creditsRequested: number;
  creditsTransferred: number;
  fundedProjects: number;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = (body as { error?: { message?: string } } | null)?.error?.message ?? (res.status === 401 ? 'Please sign in' : `Request failed (${res.status})`);
    throw new ApiError(res.status, message);
  }
  return body as T;
}

export const api = {
  stats: () => request<{ stats: Stats }>('/api/stats'),
  projects: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request<{ projects: Project[] }>(`/api/projects${qs ? `?${qs}` : ''}`);
  },
  project: (id: string) => request<{ project: Project; owner: PublicUser | null; pledges: Pledge[]; viewer: { isOwner: boolean; userId: string } | null }>(`/api/projects/${id}`),
  createProject: (body: unknown) => request<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id: string, body: unknown) => request<{ project: Project }>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  me: () => request<{ user: User }>('/api/me'),
  updateMe: (body: unknown) => request<{ user: User }>('/api/me', { method: 'PUT', body: JSON.stringify(body) }),
  deleteMe: () => request<{ deleted: boolean }>('/api/me', { method: 'DELETE' }),
  my: () => request<{ projects: Project[]; pledges: Pledge[] }>('/api/my'),
  pledges: (projectId: string) => request<{ pledges: Pledge[]; isOwner: boolean }>(`/api/projects/${projectId}/pledges`),
  createPledge: (projectId: string, body: unknown) =>
    request<{ pledge: Pledge; project: Project; recipientEmail?: string; transferUrl: string; warning?: string }>(`/api/projects/${projectId}/pledges`, { method: 'POST', body: JSON.stringify(body) }),
  updatePledge: (projectId: string, id: string, status: Pledge['status']) =>
    request<{ pledge: Pledge; project: Project }>(`/api/pledges/${projectId}/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  balance: (apiKey: string) => request<{ balance: number }>('/api/atlas/balance', { method: 'POST', body: JSON.stringify({ apiKey }) }),
};

export function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return fmt(n);
}

export function fmtDate(iso: string): string {
  if (!iso) return '';
  // Date-only values (deadlines) are calendar dates: parse as local time so they don't shift a day.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Rough credit-to-measurement equivalents from the RIPE Atlas docs (3 credits per ping result). */
export function pingsFor(credits: number): string {
  return fmtCompact(Math.floor(credits / 3));
}
