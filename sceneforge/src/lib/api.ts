export type UserRecord = {
  id: string
  name: string
  email: string
  role: string
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

export type MemoryIndicator = {
  backend: 'moorcheh' | 'supabase'
  count: number
  lastScenario: string
}

export type SandboxResponse = {
  sandbox_id: string
  data: SandboxData
  expires_at: string
  memory?: MemoryIndicator
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

export type QAReportVulnerability = {
  title?: string
  severity?: string
  description?: string
  affected_component?: string
}

export type QAReportAffectedSystem = {
  system?: string
  impact?: string
  details?: string
}

export type QAReportTestCase = {
  id?: string
  title?: string
  scenario?: string
  expected_result?: string
  priority?: string
}

export type QAReportRecommendedFix = {
  priority?: number
  fix?: string
  rationale?: string
}

export type QAReport = {
  report_title?: string
  generated_at?: string
  chaos_type?: string
  executive_summary?: string
  what_happened?: string[]
  vulnerabilities?: QAReportVulnerability[]
  affected_systems?: QAReportAffectedSystem[]
  test_cases?: QAReportTestCase[]
  recommended_fixes?: QAReportRecommendedFix[]
}

export type ReportResponse = {
  report_id: string
  report: QAReport
}

export type EndpointTestRecordResult = {
  record_id: string
  status: number
  ok: boolean
  duration_ms: number
  response_body: string | null
  error: string | null
}

export type EndpointTestFinding = {
  severity?: string
  title?: string
  description?: string
  affected_records?: string[]
}

export type EndpointTestTestCase = {
  id?: string
  title?: string
  scenario?: string
  expected_result?: string
  actual_result?: string
  status?: string
  priority?: string
}

export type EndpointTestAnalysis = {
  summary?: string
  total_requests?: number
  passed?: number
  failed?: number
  avg_response_time_ms?: number
  findings?: EndpointTestFinding[]
  test_cases?: EndpointTestTestCase[]
  recommended_fixes?: Array<{ priority?: number; fix?: string; rationale?: string }>
  chaos_findings?: string | null
}

export type EndpointTestResponse = {
  test_results: EndpointTestRecordResult[]
  analysis: EndpointTestAnalysis
  total: number
  passed: number
  failed: number
}

// Base URL for API: in dev use '' so requests go to same origin and Vite proxy forwards /api to http://localhost:3001.
// In prod use VITE_API_URL or fallback to http://localhost:3001. All paths are relative (e.g. /api/report).
const API_URL = import.meta.dev
  ? ''
  : (typeof import.meta.env.VITE_API_URL === 'string' && import.meta.env.VITE_API_URL.trim()) || 'http://localhost:3001'

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  const raw = await response.text()
  let payload: T | { error?: string }
  try {
    payload = JSON.parse(raw) as T | { error?: string }
  } catch {
    const snippet = raw.slice(0, 120).replace(/\s+/g, ' ')
    throw new Error(
      response.ok
        ? 'Invalid server response.'
        : `Request failed (${response.status}). ${snippet ? `Response: ${snippet}…` : 'Response was not JSON.'}`,
    )
  }

  if (!response.ok) {
    const apiError = payload as { error?: string }
    throw new Error(apiError.error ?? `Request failed (${response.status}).`)
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

export function generateReport(payload: {
  sandbox_id: string
  pre_chaos_data: unknown
  post_chaos_data: unknown
  changed_ids: string[]
  chaos_summary: string
  chaos_type: string
}) {
  return apiRequest<ReportResponse>('/api/report', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export type EndpointTestEntityType = 'users' | 'primary_entities' | 'activity_logs'

export function testEndpoint(payload: {
  sandbox_id: string
  target_url: string
  http_method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  entity_type: EndpointTestEntityType
  inject_chaos: boolean
}) {
  return apiRequest<EndpointTestResponse>('/api/test-endpoint', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getMemoryStatus() {
  return apiRequest<MemoryIndicator>('/api/memory-status')
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
