export type UserRecord = {
  id: string
  name: string
  email: string
  role: 'admin' | 'analyst' | 'viewer'
  status: string
  created_at: string
}

export type PrimaryEntityRecord = Record<string, unknown> & {
  id: string
}

export type ActivityLogRecord = {
  id: string
  user_id: string
  primary_entity_id: string
  action: string
  timestamp: string
  details: string
}

export type SandboxData = {
  users: UserRecord[]
  primary_entities: PrimaryEntityRecord[]
  activity_logs: ActivityLogRecord[]
  feature_flags: Record<string, boolean>
  dashboard_metrics: {
    primary_metric: number
    primary_metric_label: string
    active_users: number
    failed_records: number
    closed_records: number
    anomaly_score: number
    active_records?: number
    inactive_records?: number
  }
  schema_info: {
    primary_entity_name: string
    domain: string
  }
}

export type SandboxResponse = {
  sandbox_id: string
  data: SandboxData
}

export type ChaosResponse = SandboxResponse & {
  changedIds: string[]
  chaos_summary: string
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  const payload = (await response.json().catch(() => ({ error: 'Invalid server response.' }))) as
    | T
    | { error?: string }

  if (!response.ok) {
    const apiError = payload as { error?: string }
    throw new Error(apiError.error ?? 'Request failed.')
  }

  return payload as T
}

export function generateSandbox(description: string) {
  return apiRequest<SandboxResponse>('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ description }),
  })
}

export function applyChaos(sandboxId: string, chaosType: string) {
  return apiRequest<ChaosResponse>('/api/chaos', {
    method: 'POST',
    body: JSON.stringify({
      sandbox_id: sandboxId,
      chaos_type: chaosType,
    }),
  })
}

export function saveTemplate(sandboxId: string, name: string) {
  return apiRequest<{ template_id: string }>('/api/save-template', {
    method: 'POST',
    body: JSON.stringify({
      sandbox_id: sandboxId,
      name,
    }),
  })
}

export function getSandbox(sandboxId: string) {
  return apiRequest<{
    id: string
    data: SandboxData
  }>(`/api/sandbox/${sandboxId}`).then((payload) => ({
    sandbox_id: payload.id,
    data: payload.data,
  }))
}
