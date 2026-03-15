import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import OpenAI from 'openai'

import {
  createSandboxRecord,
  createTemplateRecord,
  parseSandboxPayload,
  type ActivityLogRecord,
  type PrimaryEntityRecord,
  type SandboxData,
  type UserRecord,
} from './lib/sandbox.ts'
import { supabase } from './lib/supabase.ts'

const app = express()
const port = Number(process.env.PORT ?? 3001)
const MODEL = 'gpt-4o'
const DEFAULT_PRODUCT_CONTEXT = 'SceneForge is an AI-powered sandbox environment generator for demos and QA.'

const GENERATE_SYSTEM_PROMPT = `You are a synthetic data engine. Generate a realistic, internally consistent sandbox environment as pure JSON.

Based on the user's description, infer the most appropriate entity type and fields for their domain. Be specific and rich.

Always return this top-level structure:
{
  "users": [...],
  "primary_entities": [...],
  "activity_logs": [...],
  "feature_flags": {},
  "dashboard_metrics": {},
  "schema_info": {
    "primary_entity_name": "human readable plural label for the main records",
    "domain": "short domain description"
  }
}

Requirements for primary_entities:
- Include a unique id field
- Include at least 2-3 numeric fields relevant to the domain
- Include a status field with realistic values for that domain
- Include relevant timestamp fields
- Include domain-specific categorical fields such as type, category, or priority when appropriate
- Include foreign key fields that reference real user IDs from the users array

Examples of good domain-specific numeric fields:
- reports -> view_count, query_count, execution_time_ms
- trips -> fare, distance_km, duration_mins
- orders -> total_amount, item_count, discount_applied

For a SaaS analytics platform, primary_entities should be reports or dashboards with fields like:
id, owner_id, title, status, view_count, query_count, execution_time_ms, ai_suggestions_used, last_accessed, created_at

For activity_logs:
- Keep them chronological
- Reference real ids from users and real ids from primary_entities
- Make them reflect actions that could actually happen in the generated environment

Dataset size expectations:
- Respect any explicit counts the user asks for
- If the user does not specify exact counts, generate a non-trivial dataset rather than a tiny sample
- Default to roughly 4-8 users for small business scenarios, more if the prompt implies a larger organization
- Default to roughly 12-24 primary_entities so the tables feel realistic and useful
- Default to roughly 18-40 activity_logs so there is enough history to inspect patterns and anomalies
- Make the number of activity_logs meaningfully larger than the number of primary_entities

For dashboard_metrics:
- Derive values from the actual generated data
- Pick the most relevant numeric field as the primary metric
- Count active vs inactive records
- Count failed or error records
- Set anomaly_score based on any anomalies in the data

Return pure JSON, no markdown, no explanation.`

const CHAOS_SYSTEM_PROMPT = `You are a chaos injection engine. Given a sandbox dataset and a chaos type, return ONLY a JSON diff object describing exactly what to change. Do not return the full dataset.

Return this structure:
{
  "chaos_summary": "brief description of what happened",
  "mutations": {
    "users": [{ "id": "existing_user_id", "changes": { "status": "payment_suspended" } }],
    "primary_entities": [{ "id": "existing_primary_entity_id", "changes": { "status": "failed", "incident_reason": "service_disruption", "chaos_injected": true } }],
    "activity_logs": [{ "id": "NEW_UUID", "isNew": true, "data": { ...complete new log entry with real user_id and real primary_entity_id } }],
    "dashboard_metrics": { "failed_entities": 4, "anomaly_score": 8.7 }
  }
}

RULES:
- For existing records: only include the id and the specific fields that need to change
- For new records: set isNew: true and provide the complete record
- For new activity_log entries, always include "isNew": true at the top level of the mutation object, and put the complete log record inside a "data" field.
- The chaos must propagate consistently across the related user records, primary entities, activity logs, and dashboard metrics.
- Every new activity_log must use a real user_id and real primary_entity_id from the dataset
- Minimum mutations only — touch nothing that doesn't need to change`

const QA_REPORT_SYSTEM_PROMPT = `You are a senior QA engineer analyzing the impact of an edge case injected into a software sandbox environment.

You will receive:
- The state of the system BEFORE chaos was injected
- The state of the system AFTER chaos was injected
- A summary of what changed

Generate a detailed QA report as pure JSON with this exact structure:
{
  "report_title": "QA Edge Case Report — [chaos type]",
  "generated_at": "[ISO timestamp]",
  "chaos_type": "[chaos type]",
  "executive_summary": "2-3 sentence plain English summary of what happened and its impact",
  "what_happened": [
    "Specific thing that changed 1",
    "Specific thing that changed 2"
  ],
  "vulnerabilities": [
    {
      "title": "Vulnerability name",
      "severity": "critical | high | medium | low",
      "description": "What the vulnerability is",
      "affected_component": "Which part of the system"
    }
  ],
  "affected_systems": [
    {
      "system": "System name",
      "impact": "critical | high | medium | low",
      "details": "How it was affected"
    }
  ],
  "test_cases": [
    {
      "id": "TC-001",
      "title": "Test case title",
      "scenario": "Given/When/Then format test scenario",
      "expected_result": "What should happen",
      "priority": "high | medium | low"
    }
  ],
  "recommended_fixes": [
    {
      "priority": 1,
      "fix": "What to fix",
      "rationale": "Why this matters"
    }
  ]
}

Be specific — reference actual user IDs, transaction IDs, and field values from the data. This should read like a real QA report a senior engineer would write. Return only valid JSON.`

type MemoryRow = {
  id: string
  product_context: string | null
  past_scenarios: string[] | null
  updated_at: string | null
}

type SandboxRow = {
  id: string
  description: string
  data: SandboxData
  created_at: string
  expires_at: string
}

type TemplateRow = {
  id: string
  name: string
  description: string
  data: SandboxData
  created_at: string
}

type ReportRow = {
  id: string
  sandbox_id: string
  chaos_type: string
  report: QAReportPayload
  created_at: string
}

type QAReportPayload = {
  report_title?: string
  generated_at?: string
  chaos_type?: string
  executive_summary?: string
  what_happened?: string[]
  vulnerabilities?: Array<{
    title?: string
    severity?: string
    description?: string
    affected_component?: string
  }>
  affected_systems?: Array<{
    system?: string
    impact?: string
    details?: string
  }>
  test_cases?: Array<{
    id?: string
    title?: string
    scenario?: string
    expected_result?: string
    priority?: string
  }>
  recommended_fixes?: Array<{
    priority?: number
    fix?: string
    rationale?: string
  }>
}

type ChaosMutation<TChanges> = {
  id: string
  changes?: Partial<TChanges>
}

type ChaosLogMutation = {
  id: string
  isNew?: boolean
  data?: ActivityLogRecord
  changes?: Partial<ActivityLogRecord>
}

type ChaosDiff = {
  chaos_summary?: string
  mutations?: {
    users?: Array<ChaosMutation<UserRecord>>
    primary_entities?: Array<ChaosMutation<PrimaryEntityRecord>>
    activity_logs?: ChaosLogMutation[]
    dashboard_metrics?: Partial<SandboxData['dashboard_metrics']>
  }
}

app.use(cors())
app.use(express.json({ limit: '10mb' }))

function ensureEnv(name: string): string {
  const value = process.env[name]

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

function ensureSupabaseEnv(): void {
  ensureEnv('SUPABASE_URL')
  ensureEnv('SUPABASE_ANON_KEY')
}

function getOpenAIClient() {
  return new OpenAI({
    apiKey: ensureEnv('OPENAI_API_KEY'),
  })
}

async function getMemoryRecord(): Promise<MemoryRow | null> {
  const { data, error } = await supabase
    .from('memory')
    .select('id, product_context, past_scenarios, updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data as MemoryRow | null
}

async function appendScenarioToMemory(description: string): Promise<void> {
  const now = new Date().toISOString()
  const existing = await getMemoryRecord()
  const nextScenarios = [...(existing?.past_scenarios ?? []), description].slice(-12)

  if (existing) {
    const { error } = await supabase
      .from('memory')
      .update({
        product_context: existing.product_context ?? DEFAULT_PRODUCT_CONTEXT,
        past_scenarios: nextScenarios,
        updated_at: now,
      })
      .eq('id', existing.id)

    if (error) {
      throw error
    }

    return
  }

  const { error } = await supabase.from('memory').insert({
    id: 'sceneforge-memory',
    product_context: DEFAULT_PRODUCT_CONTEXT,
    past_scenarios: nextScenarios,
    updated_at: now,
  })

  if (error) {
    throw error
  }
}

async function getSandboxById(id: string): Promise<SandboxRow> {
  const { data, error } = await supabase
    .from('sandboxes')
    .select('id, description, data, created_at, expires_at')
    .eq('id', id)
    .single()

  if (error || !data) {
    throw new Error(`Sandbox not found: ${id}`)
  }

  return data as SandboxRow
}

async function getTemplateById(id: string): Promise<TemplateRow> {
  const { data, error } = await supabase
    .from('templates')
    .select('id, name, description, data, created_at')
    .eq('id', id)
    .single()

  if (error || !data) {
    throw new Error(`Template not found: ${id}`)
  }

  return data as TemplateRow
}

async function generateFreshSandbox(description: string) {
  const memory = await getMemoryRecord()
  const prompt = [
    `Product context: ${memory?.product_context ?? DEFAULT_PRODUCT_CONTEXT}`,
    `Past scenarios: ${JSON.stringify(memory?.past_scenarios ?? [])}`,
    `Requested scenario: ${description}`,
    'Return only raw JSON.',
  ].join('\n\n')

  const rawJson = await requestModelJson(GENERATE_SYSTEM_PROMPT, prompt)
  const data = parseSandboxPayload(rawJson)
  const sandbox = createSandboxRecord(description, data)

  const { error } = await supabase.from('sandboxes').insert(sandbox)
  if (error) {
    throw error
  }

  await appendScenarioToMemory(description)

  return sandbox
}

async function requestModelJson(systemPrompt: string, prompt: string): Promise<string> {
  const openai = getOpenAIClient()
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: `${systemPrompt}\n\n${prompt}`,
      },
    ],
    response_format: { type: 'json_object' },
  })
  const text = response.choices[0]?.message?.content?.trim()

  if (!text) {
    throw new Error('OpenAI returned an empty response.')
  }

  return text
}

function parseChaosDiff(rawText: string): ChaosDiff {
  return JSON.parse(rawText.trim()) as ChaosDiff
}

function hasFailureStatus(value: unknown): boolean {
  return typeof value === 'string' && /(fail|error|blocked|denied|revoked|incident|anomal|suspend|degrad)/i.test(value)
}

function hasActiveStatus(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    !hasFailureStatus(value) &&
    !hasClosedStatus(value) &&
    !/inactive|disabled/i.test(value)
  )
}

function hasClosedStatus(value: unknown): boolean {
  return typeof value === 'string' && /closed|completed|won|lost|resolved|archived/i.test(value)
}

function getRelatedUserIds(record: PrimaryEntityRecord, validUserIds: Set<string>): string[] {
  return Object.entries(record)
    .filter(([key, value]) => key !== 'id' && key.endsWith('_id') && typeof value === 'string' && validUserIds.has(value))
    .map(([, value]) => value as string)
}

function deriveDashboardMetrics(data: SandboxData): SandboxData['dashboard_metrics'] {
  let numericField: string | null = null

  for (const entity of data.primary_entities) {
    for (const [key, value] of Object.entries(entity)) {
      if (key !== 'id' && typeof value === 'number' && Number.isFinite(value)) {
        numericField = key
        break
      }
    }
    if (numericField) {
      break
    }
  }

  const primaryMetric = numericField
    ? data.primary_entities.reduce((sum, entity) => sum + (Number(entity[numericField]) || 0), 0)
    : 0

  const activeUsers = data.users.filter((user) => user.status === 'active').length
  const failedEntities = data.primary_entities.filter((entity) => hasFailureStatus(entity.status)).length
  const activeRecords = data.primary_entities.filter((entity) => hasActiveStatus(entity.status)).length
  const closedRecords = data.primary_entities.filter((entity) => hasClosedStatus(entity.status)).length
  const inactiveRecords = data.primary_entities.filter((entity) =>
    typeof entity.status === 'string' && /inactive|archived|disabled|closed|failed|error|degraded|lost/i.test(entity.status),
  ).length
  const suspiciousLogs = data.activity_logs.filter((log) =>
    /fail|conflict|anomaly|alert|suspicious|degrad|incident/i.test(`${log.action} ${log.details}`),
  ).length

  return {
    primary_metric: Number(primaryMetric.toFixed(2)),
    primary_metric_label: numericField ?? 'total',
    active_users: activeUsers,
    failed_records: failedEntities,
    closed_records: closedRecords,
    anomaly_score: Number((((failedEntities * 10) + suspiciousLogs * 3) / Math.max(data.activity_logs.length, 1)).toFixed(2)),
    active_records: activeRecords,
    inactive_records: inactiveRecords,
  }
}

function applyChaosDiff(originalData: SandboxData, diff: ChaosDiff) {
  const mutatedData = JSON.parse(JSON.stringify(originalData)) as SandboxData
  const changedIds = new Set<string>()
  const userIds = new Set(mutatedData.users.map((user) => user.id))
  const primaryEntityIds = new Set(mutatedData.primary_entities.map((entity) => entity.id))
  const mutations = diff.mutations
  const failedPrimaryEntityIds = new Set<string>()
  let hasNewFailedEntityLog = false

  mutations?.users?.forEach((mutation) => {
    const user = mutatedData.users.find((item) => item.id === mutation.id)
    if (user && mutation.changes) {
      Object.assign(user, mutation.changes)
      changedIds.add(user.id)
    }
  })

  mutations?.primary_entities?.forEach((mutation) => {
    const primaryEntity = mutatedData.primary_entities.find((item) => item.id === mutation.id)
    if (primaryEntity && mutation.changes) {
      Object.assign(primaryEntity, mutation.changes)
      changedIds.add(primaryEntity.id)
      if (hasFailureStatus(primaryEntity.status)) {
        failedPrimaryEntityIds.add(primaryEntity.id)
      }
    }
  })

  mutations?.activity_logs?.forEach((mutation) => {
    const existingLog = mutatedData.activity_logs.find((item) => item.id === mutation.id)
    if (mutation.isNew || !existingLog) {
      const newLog = mutation.data ?? (mutation as unknown as ActivityLogRecord)
      if (newLog?.id && userIds.has(newLog.user_id) && primaryEntityIds.has(newLog.primary_entity_id)) {
        mutatedData.activity_logs.push(newLog)
        changedIds.add(newLog.id)
        if (failedPrimaryEntityIds.has(newLog.primary_entity_id)) {
          hasNewFailedEntityLog = true
        }
      }
    } else if (mutation.changes) {
      Object.assign(existingLog, mutation.changes)
      changedIds.add(existingLog.id)
    }
  })

  if (failedPrimaryEntityIds.size > 0) {
    const affectedUserIds = new Set<string>()
    mutatedData.primary_entities
      .filter((entity) => failedPrimaryEntityIds.has(entity.id))
      .forEach((entity) => {
        getRelatedUserIds(entity, userIds).forEach((userId) => affectedUserIds.add(userId))
      })

    mutatedData.users.forEach((user) => {
      if (affectedUserIds.has(user.id) && user.status !== 'impacted') {
        user.status = 'impacted'
        changedIds.add(user.id)
      }
    })
  }

  if (failedPrimaryEntityIds.size > 0 && !hasNewFailedEntityLog) {
    const failedPrimaryEntity = mutatedData.primary_entities.find((entity) =>
      failedPrimaryEntityIds.has(entity.id),
    )
    if (failedPrimaryEntity) {
      const fallbackUserId = getRelatedUserIds(failedPrimaryEntity, userIds)[0] ?? mutatedData.users[0]?.id
      if (fallbackUserId) {
      const fallbackLog: ActivityLogRecord = {
        id: randomUUID(),
        user_id: fallbackUserId,
        primary_entity_id: failedPrimaryEntity.id,
        action: 'entity_failed',
        timestamp: new Date().toISOString(),
        details: `Chaos injected failure recorded for primary entity ${failedPrimaryEntity.id}.`,
      }
      mutatedData.activity_logs.push(fallbackLog)
      changedIds.add(fallbackLog.id)
      }
    }
  }

  mutatedData.activity_logs.sort(
    (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  )
  mutatedData.dashboard_metrics = {
    ...deriveDashboardMetrics(mutatedData),
    ...(mutations?.dashboard_metrics ?? {}),
  }

  return {
    mutatedData,
    changedIds: Array.from(changedIds),
    chaos_summary: diff.chaos_summary ?? 'Chaos injected.',
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown server error.'
}

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response, next).catch(next)
  }
}

app.post(
  '/api/generate',
  asyncRoute(async (request, response) => {
    const description =
      typeof request.body.description === 'string' ? request.body.description.trim() : ''

    if (!description) {
      response.status(400).json({ error: 'Description is required.' })
      return
    }

    ensureSupabaseEnv()
    const sandbox = await generateFreshSandbox(description)

    response.status(201).json({
      sandbox_id: sandbox.id,
      data: sandbox.data,
      expires_at: sandbox.expires_at,
    })
  }),
)

app.get(
  '/api/sandboxes',
  asyncRoute(async (_request, response) => {
    ensureSupabaseEnv()
    const { data, error } = await supabase
      .from('sandboxes')
      .select('id, description, created_at')
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) {
      throw error
    }

    response.json({
      sandboxes: (data ?? []) as Array<Pick<SandboxRow, 'id' | 'description' | 'created_at'>>,
    })
  }),
)

app.get(
  '/api/templates',
  asyncRoute(async (_request, response) => {
    ensureSupabaseEnv()
    const { data, error } = await supabase
      .from('templates')
      .select('id, name, description, created_at')
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) {
      throw error
    }

    response.json({
      templates: (data ?? []) as Array<Pick<TemplateRow, 'id' | 'name' | 'description' | 'created_at'>>,
    })
  }),
)

app.post(
  '/api/generate-from-template',
  asyncRoute(async (request, response) => {
    const templateId =
      typeof request.body.template_id === 'string' ? request.body.template_id.trim() : ''

    if (!templateId) {
      response.status(400).json({ error: 'template_id is required.' })
      return
    }

    ensureSupabaseEnv()
    const template = await getTemplateById(templateId)
    const sandbox = await generateFreshSandbox(template.description)

    response.status(201).json({
      sandbox_id: sandbox.id,
      data: sandbox.data,
      expires_at: sandbox.expires_at,
    })
  }),
)

app.post(
  '/api/chaos',
  asyncRoute(async (request, response) => {
    const sandboxId =
      typeof request.body.sandbox_id === 'string' ? request.body.sandbox_id.trim() : ''
    const chaosType =
      typeof request.body.chaos_type === 'string' ? request.body.chaos_type.trim() : ''

    if (!sandboxId || !chaosType) {
      response.status(400).json({ error: 'sandbox_id and chaos_type are required.' })
      return
    }

    ensureSupabaseEnv()
    const sandbox = await getSandboxById(sandboxId)
    const prompt = [
      `Chaos type: ${chaosType}`,
      `Current sandbox description: ${sandbox.description}`,
      `Current sandbox data: ${JSON.stringify(sandbox.data)}`,
      'Return only raw JSON.',
    ].join('\n\n')

    const rawJson = await requestModelJson(CHAOS_SYSTEM_PROMPT, prompt)
    const diff = parseChaosDiff(rawJson)
    const { mutatedData, changedIds, chaos_summary } = applyChaosDiff(sandbox.data, diff)

    const { error } = await supabase
      .from('sandboxes')
      .update({
        data: mutatedData,
      })
      .eq('id', sandboxId)

    if (error) {
      throw error
    }

    response.json({
      sandbox_id: sandboxId,
      data: mutatedData,
      expires_at: sandbox.expires_at,
      changedIds,
      chaos_summary,
    })
  }),
)

app.post(
  '/api/report',
  asyncRoute(async (request, response) => {
    const sandboxId =
      typeof request.body.sandbox_id === 'string' ? request.body.sandbox_id.trim() : ''
    const preChaosData = request.body.pre_chaos_data
    const postChaosData = request.body.post_chaos_data
    const changedIds = Array.isArray(request.body.changed_ids)
      ? (request.body.changed_ids as string[])
      : []
    const chaosSummary =
      typeof request.body.chaos_summary === 'string' ? request.body.chaos_summary.trim() : ''
    const chaosType =
      typeof request.body.chaos_type === 'string' ? request.body.chaos_type.trim() : ''

    if (!sandboxId || !postChaosData) {
      response.status(400).json({ error: 'sandbox_id and post_chaos_data are required.' })
      return
    }

    const prompt = [
      `Chaos type: ${chaosType}`,
      `Chaos summary: ${chaosSummary}`,
      `Changed IDs: ${JSON.stringify(changedIds)}`,
      '',
      'Pre-chaos data:',
      JSON.stringify(preChaosData ?? {}),
      '',
      'Post-chaos data:',
      JSON.stringify(postChaosData),
      '',
      'Return only raw JSON.',
    ].join('\n')

    let rawJson: string
    try {
      rawJson = await requestModelJson(QA_REPORT_SYSTEM_PROMPT, prompt)
    } catch (openaiError) {
      const msg = getErrorMessage(openaiError)
      response.status(502).json({ error: `QA report generation failed: ${msg}` })
      return
    }

    let report: QAReportPayload
    try {
      report = JSON.parse(rawJson.trim()) as QAReportPayload
    } catch {
      response.status(502).json({
        error: 'QA report generation returned invalid JSON. Please try again.',
      })
      return
    }

    if (!report.generated_at) {
      report.generated_at = new Date().toISOString()
    }
    if (!report.chaos_type) {
      report.chaos_type = chaosType
    }

    const reportId = randomUUID()
    ensureSupabaseEnv()
    const { error } = await supabase.from('reports').insert({
      id: reportId,
      sandbox_id: sandboxId,
      chaos_type: chaosType,
      report,
    })

    if (error) {
      const hint = /does not exist|relation\s+["']?reports["']?/i.test(String(error.message))
        ? ' Ensure the reports table exists (run supabase/migrations/create_reports.sql in Supabase).'
        : ''
      response.status(503).json({
        error: `Failed to save report: ${error.message}.${hint}`,
      })
      return
    }

    response.status(201).json({
      report_id: reportId,
      report,
    })
  }),
)

app.post(
  '/api/save-template',
  asyncRoute(async (request, response) => {
    const sandboxId =
      typeof request.body.sandbox_id === 'string' ? request.body.sandbox_id.trim() : ''
    const name = typeof request.body.name === 'string' ? request.body.name.trim() : ''

    if (!sandboxId || !name) {
      response.status(400).json({ error: 'sandbox_id and name are required.' })
      return
    }

    ensureSupabaseEnv()
    const sandbox = await getSandboxById(sandboxId)
    const template = createTemplateRecord(name, sandbox.description, sandbox.data)

    const { error } = await supabase.from('templates').insert(template)
    if (error) {
      throw error
    }

    response.status(201).json({
      template_id: template.id,
    })
  }),
)

app.get(
  '/api/sandbox/:id',
  asyncRoute(async (request, response) => {
    ensureSupabaseEnv()
    const sandboxId = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id
    const sandbox = await getSandboxById(sandboxId)

    if (new Date(sandbox.expires_at).getTime() <= Date.now()) {
      response.json({
        expired: true,
      })
      return
    }

    response.json(sandbox)
  }),
)

app.delete(
  '/api/sandbox/:id',
  asyncRoute(async (request, response) => {
    ensureSupabaseEnv()
    const sandboxId = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id

    const { error } = await supabase
      .from('sandboxes')
      .delete()
      .eq('id', sandboxId)

    if (error) {
      throw error
    }

    response.json({ success: true })
  }),
)

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  void _request
  void _next
  const message = getErrorMessage(error)
  const statusCode = /not found/i.test(message) ? 404 : 500

  response.status(statusCode).json({
    error: message,
  })
})

app.listen(port, () => {
  console.log(`SceneForge API listening on http://localhost:${port}`)
})
