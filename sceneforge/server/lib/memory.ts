import { supabase } from './supabase.ts'

const MEMORY_ROW_ID = 'sceneforge-memory'
const MOORCHEH_BASE = 'http://localhost:8000'
const MOORCHEH_TIMEOUT_MS = 2000

export type StoreMemoryScenario = {
  description: string
  domain: string
  schema: Record<string, unknown>
  metrics: Record<string, unknown>
}

export type StoreMemoryResult = {
  backend: 'moorcheh' | 'supabase'
  count: number
  lastDescription: string
}

export async function storeMemory(scenario: StoreMemoryScenario): Promise<StoreMemoryResult> {
  try {
    const res = await fetch(`${MOORCHEH_BASE}/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scenario),
      signal: AbortSignal.timeout(MOORCHEH_TIMEOUT_MS),
    })
    if (res.ok) {
      console.log('[Memory] Stored via Moorcheh')
      return {
        backend: 'moorcheh',
        count: 0,
        lastDescription: scenario.description,
      }
    }
  } catch {
    console.log('[Memory] Moorcheh unavailable, falling back to Supabase')
  }

  const { data } = await supabase
    .from('memory')
    .select('past_scenarios')
    .eq('id', MEMORY_ROW_ID)
    .maybeSingle()

  const existing = (data?.past_scenarios as unknown[]) || []
  const entry = {
    ...scenario,
    timestamp: new Date().toISOString(),
  }
  const next = [entry, ...existing].slice(0, 50)
  const now = new Date().toISOString()
  const domains = (next as Array<{ domain?: string }>).slice(0, 10).map((s) => s.domain ?? 'unknown').join(', ')
  const productContext = `User has built sandboxes for: ${domains}`

  console.log(`[Memory] Stored scenario via Supabase: "${scenario.description.slice(0, 50)}"`)
  if (data !== null && data !== undefined) {
    await supabase
      .from('memory')
      .update({
        product_context: productContext,
        past_scenarios: next,
        updated_at: now,
      })
      .eq('id', MEMORY_ROW_ID)
  } else {
    await supabase.from('memory').insert({
      id: MEMORY_ROW_ID,
      product_context: productContext,
      past_scenarios: next,
      updated_at: now,
    })
  }

  return {
    backend: 'supabase',
    count: next.length,
    lastDescription: scenario.description,
  }
}

export async function retrieveMemory(query: string): Promise<string> {
  try {
    const res = await fetch(`${MOORCHEH_BASE}/retrieve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(MOORCHEH_TIMEOUT_MS),
    })
    if (res.ok) {
      const data = (await res.json()) as { context?: string }
      console.log('[Memory] Retrieved via Moorcheh')
      return data.context ?? ''
    }
  } catch {
    console.log('[Memory] Moorcheh unavailable, falling back to Supabase')
  }

  const { data } = await supabase
    .from('memory')
    .select('past_scenarios')
    .eq('id', MEMORY_ROW_ID)
    .maybeSingle()

  const scenarios = (data?.past_scenarios as unknown[]) || []
  if (scenarios.length === 0) return ''

  const normalized = scenarios.map((s: unknown) => {
    if (s && typeof s === 'object' && 'description' in s) {
      const o = s as Record<string, unknown>
      return {
        description: String(o.description ?? ''),
        domain: String(o.domain ?? 'unknown'),
        schema: (o.schema as Record<string, unknown>) || {},
      }
    }
    return {
      description: typeof s === 'string' ? s : '',
      domain: 'unknown',
      schema: {} as Record<string, unknown>,
    }
  })

  const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean)
  const scored = normalized.map((s) => {
    const text = `${s.description} ${s.domain}`.toLowerCase()
    const score = queryWords.filter((w) => text.includes(w)).length
    return { ...s, score }
  })

  const relevant = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .filter((s) => s.score > 0)

  if (relevant.length > 0) {
    console.log(`[Memory] Retrieved ${relevant.length} relevant scenarios via Supabase for query: "${query.slice(0, 50)}"`)
  } else {
    console.log(`[Memory] No relevant past scenarios found for query: "${query.slice(0, 50)}"`)
  }
  if (relevant.length === 0) return ''

  const context = relevant
    .map(
      (s) =>
        `- ${s.description} (domain: ${s.domain}, primary entity: ${(s.schema?.primary_entity as string) ?? 'unknown'})`,
    )
    .join('\n')

  return `Past scenarios from this user:\n${context}`
}

export type MemoryStatus = {
  backend: 'moorcheh' | 'supabase'
  count: number
  lastScenario: string
}

export async function getMemoryStatus(): Promise<MemoryStatus> {
  try {
    const res = await fetch(`${MOORCHEH_BASE}/retrieve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '' }),
      signal: AbortSignal.timeout(MOORCHEH_TIMEOUT_MS),
    })
    if (res.ok) {
      return {
        backend: 'moorcheh',
        count: 0,
        lastScenario: '',
      }
    }
  } catch {
    // fall through to Supabase
  }

  const { data } = await supabase
    .from('memory')
    .select('past_scenarios')
    .eq('id', MEMORY_ROW_ID)
    .maybeSingle()

  const scenarios = (data?.past_scenarios as unknown[]) || []
  const first = scenarios[0]
  let lastScenario = ''
  if (first && typeof first === 'object' && first !== null && 'description' in first) {
    lastScenario = String((first as Record<string, unknown>).description ?? '')
  } else if (typeof first === 'string') {
    lastScenario = first
  }

  return {
    backend: 'supabase',
    count: scenarios.length,
    lastScenario,
  }
}
