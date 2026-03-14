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
app.use(express.json({ limit: '1mb' }))

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

function getRelatedUserIds(record: PrimaryEntityRecord, validUserIds: Set<string>): string[] {
  return Object.entries(record)
    .filter(([key, value]) => key !== 'id' && key.endsWith('_id') && typeof value === 'string' && validUserIds.has(value))
    .map(([, value]) => value as string)
}

function deriveDashboardMetrics(data: SandboxData): SandboxData['dashboard_metrics'] {
  const totalValue = data.primary_entities.reduce((sum, entity) => {
    if (hasFailureStatus(entity.status)) {
      return sum
    }

    const preferredKeys = [
      'value',
      'revenue',
      'cost',
      'spend',
      'order_value',
      'visit_value',
      'trip_value',
      'usage_credits',
      'query_count',
      'seat_count',
    ]

    for (const key of preferredKeys) {
      if (typeof entity[key] === 'number' && Number.isFinite(entity[key])) {
        return sum + (entity[key] as number)
      }
    }

    return sum
  }, 0)

  const activeUsers = data.users.filter((user) => /active/i.test(user.status)).length
  const failedEntities = data.primary_entities.filter((entity) => hasFailureStatus(entity.status)).length
  const suspiciousLogs = data.activity_logs.filter((log) =>
    /fail|conflict|anomaly|alert|suspicious|degrad|incident/i.test(`${log.action} ${log.details}`),
  ).length

  return {
    total_value: Number(totalValue.toFixed(2)),
    active_users: activeUsers,
    failed_entities: failedEntities,
    anomaly_score: Number((((failedEntities * 10) + suspiciousLogs * 3) / Math.max(data.activity_logs.length, 1)).toFixed(2)),
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

    response.status(201).json({
      sandbox_id: sandbox.id,
      data: sandbox.data,
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
      changedIds,
      chaos_summary,
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

    response.json(sandbox)
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
