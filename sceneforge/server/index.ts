import 'dotenv/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import OpenAI from 'openai'

import {
  createSandboxRecord,
  createTemplateRecord,
  parseSandboxPayload,
  type SandboxData,
} from './lib/sandbox.ts'
import { supabase } from './lib/supabase.ts'

const app = express()
const port = Number(process.env.PORT ?? 3001)
const MODEL = 'gpt-4o'
const DEFAULT_PRODUCT_CONTEXT = 'SceneForge is an AI-powered sandbox environment generator for demos and QA.'

const GENERATE_SYSTEM_PROMPT = `You are a synthetic data engine. Generate a realistic, internally consistent sandbox environment as pure JSON with no markdown, no explanation, no code blocks — just raw JSON.

The JSON must contain:
- users: array of 3-5 users, each with id (uuid), name, email, role (admin/analyst/viewer), status, created_at
- transactions: array of 10-15 transactions, each with id (uuid), user_id (must match a real user id from users array), amount, status, type, created_at, metadata
- activity_logs: array of 15-20 logs, each with id (uuid), user_id (must match a real user id), transaction_id (must match a real transaction id), action, timestamp (chronologically coherent), details
- feature_flags: object with 4-6 boolean flags relevant to the described environment
- dashboard_metrics: object with summary stats (total_revenue, active_users, failed_transactions, anomaly_score) derived from the actual data above

CRITICAL: Every foreign key reference must be valid. user_id in transactions must be a real user id. transaction_id in activity_logs must be a real transaction id. Timestamps must be chronologically coherent. The data must tell a consistent story.`

const CHAOS_SYSTEM_PROMPT = `You are a chaos injection engine. Given an existing sandbox dataset and a chaos type, mutate the data to reflect a realistic edge case. Return the complete mutated dataset as pure JSON — same structure as input, no markdown, no explanation.

The chaos must propagate consistently across ALL entities simultaneously:
- If a payment fails: update the transaction status, add an activity log entry, update the user's status, update dashboard_metrics to reflect the anomaly
- If a permission conflict: update the user's role, add audit log entries showing the conflict, flag relevant transactions
- If a data anomaly: introduce inconsistency in metrics, add suspicious activity logs, update anomaly_score in dashboard_metrics

CRITICAL: The chaos must appear in every relevant table simultaneously. It must feel like something that actually happened, not a random data change.`

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
    const data = parseSandboxPayload(rawJson)

    const { error } = await supabase
      .from('sandboxes')
      .update({
        data,
      })
      .eq('id', sandboxId)

    if (error) {
      throw error
    }

    response.json({
      sandbox_id: sandboxId,
      data,
      chaos_applied: chaosType,
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
