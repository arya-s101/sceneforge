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
  expires_at: string
}

export type TemplateSummary = {
  id: string
  name: string
  description: string
  created_at: string
}

export type SandboxSummary = {
  id: string
  description: string
  created_at: string
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

export function getTemplates() {
  return apiRequest<{ templates: TemplateSummary[] }>('/api/templates').then((payload) => payload.templates)
}

export function getSandboxes() {
  return apiRequest<{ sandboxes: SandboxSummary[] }>('/api/sandboxes').then((payload) => payload.sandboxes)
}

export function deleteSandboxRecord(sandboxId: string) {
  return apiRequest<{ success: true }>(`/api/sandbox/${sandboxId}`, {
    method: 'DELETE',
  })
}

export function generateFromTemplate(templateId: string) {
  return apiRequest<SandboxResponse>('/api/generate-from-template', {
    method: 'POST',
    body: JSON.stringify({
      template_id: templateId,
    }),
  })
}

export function getSandbox(sandboxId: string) {
  return fetch(`${API_URL}/api/sandbox/${sandboxId}`)
    .then(async (response) => {
      const payload = (await response.json().catch(() => ({ error: 'Invalid server response.' }))) as
        | {
            expired?: boolean
            error?: string
            id?: string
            data?: SandboxData
            expires_at?: string
          }
        | { error?: string }

      if (!response.ok) {
        throw new Error((payload as { error?: string }).error ?? 'Request failed.')
      }

      if ('expired' in payload && payload.expired) {
        throw new Error('Sandbox expired')
      }

      return {
        sandbox_id: payload.id ?? sandboxId,
        data: payload.data as SandboxData,
        expires_at: payload.expires_at ?? '',
      }
    })
}
