// Centralised API client — all fetch calls go through here.
// Authentication is handled via an httpOnly cookie set by the backend on login.
// credentials: 'include' ensures the cookie is sent on every cross-origin request.

const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string>),
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

// ── Auth ───────────────────────────────────────────────────────────────────

export const login    = (data: { email: string; password: string }) =>
  request<any>('/api/auth/login', { method: 'POST', body: JSON.stringify(data) });

export const logout   = () =>
  request<any>('/api/auth/logout', { method: 'POST' });

export const getMe    = () =>
  request<any>('/api/auth/me');

export const register = (data: { email: string; password: string; role?: string }) =>
  request<any>('/api/auth/register', { method: 'POST', body: JSON.stringify(data) });

// ── Sources ────────────────────────────────────────────────────────────────

export const getSources     = ()       => request<any>('/api/sources');
export const getSource      = (id: string) => request<any>(`/api/sources/${id}`);
export const createSource   = (data: any) => request<any>('/api/sources', { method: 'POST', body: JSON.stringify(data) });
export const updateSource   = (id: string, data: any) => request<any>(`/api/sources/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteSource   = (id: string) => request<any>(`/api/sources/${id}`, { method: 'DELETE' });
export const testSource     = (id: string) => request<any>(`/api/sources/${id}/test`, { method: 'POST' });

// ── Profiles ───────────────────────────────────────────────────────────────

export const getProfiles    = (source_id?: string) =>
  request<any>(`/api/profiles${source_id ? `?source_id=${source_id}` : ''}`);
export const getProfile     = (id: string) => request<any>(`/api/profiles/${id}`);
export const createProfile  = (data: any) => request<any>('/api/profiles', { method: 'POST', body: JSON.stringify(data) });
export const updateProfile  = (id: string, data: any) => request<any>(`/api/profiles/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteProfile  = (id: string) => request<any>(`/api/profiles/${id}`, { method: 'DELETE' });

// ── Scans ──────────────────────────────────────────────────────────────────

export const getScans       = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request<any>(`/api/scans${qs}`);
};
export const getScan        = (id: string) => request<any>(`/api/scans/${id}`);
export const getScanFindings = (id: string, params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request<any>(`/api/scans/${id}/findings${qs}`);
};
export const triggerScan    = (profile_id: string) =>
  request<any>('/api/scans', { method: 'POST', body: JSON.stringify({ profile_id }) });
export const cancelScan     = (id: string) =>
  request<any>(`/api/scans/${id}`, { method: 'DELETE' });

// ── Findings ───────────────────────────────────────────────────────────────

export const reviewFinding  = (id: string, data: any) =>
  request<any>(`/api/findings/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

// ── Catalogue ──────────────────────────────────────────────────────────────

export const publishScan    = (scanId: string) =>
  request<any>(`/api/catalogue/publish/${scanId}`, { method: 'POST' });
export const getCatalogue   = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request<any>(`/api/catalogue${qs}`);
};
export const getCatalogueBySource   = () => request<any>('/api/catalogue/by-source');
export const getCatalogueByCategory = () => request<any>('/api/catalogue/by-category');
export const getCatalogueStats      = () => request<any>('/api/catalogue/stats');
