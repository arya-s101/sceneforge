import { randomUUID } from 'node:crypto'
import { validate as isUuid, v4 as uuidv4 } from 'uuid'

export type UserRecord = {
  id: string
  name: string
  email: string
  role: 'admin' | 'analyst' | 'viewer'
  status: string
  created_at: string
}

export type TransactionRecord = {
  id: string
  user_id: string
  amount: number
  status: string
  type: string
  created_at: string
  metadata: Record<string, unknown>
}

export type ActivityLogRecord = {
  id: string
  user_id: string
  transaction_id: string
  action: string
  timestamp: string
  details: string
}

export type DashboardMetrics = {
  total_revenue: number
  active_users: number
  failed_transactions: number
  anomaly_score: number
}

export type SandboxData = {
  users: UserRecord[]
  transactions: TransactionRecord[]
  activity_logs: ActivityLogRecord[]
  feature_flags: Record<string, boolean>
  dashboard_metrics: DashboardMetrics
}

type RawRecord = Record<string, unknown>

const DEFAULT_FEATURE_FLAGS = [
  'smart_retry',
  'fraud_detection',
  'audit_trail',
  'role_enforcement',
  'sandbox_exports',
  'anomaly_alerting',
]

const DEFAULT_ROLES: UserRecord['role'][] = ['admin', 'analyst', 'viewer']
const DEFAULT_USER_STATUS = ['active', 'monitoring', 'restricted']
const DEFAULT_TRANSACTION_TYPES = ['purchase', 'refund', 'subscription', 'payout']
const DEFAULT_TRANSACTION_STATUSES = ['completed', 'pending', 'failed']
const DEFAULT_LOG_ACTIONS = [
  'user_created',
  'transaction_processed',
  'access_reviewed',
  'alert_triggered',
  'feature_flag_checked',
]

function asRecord(value: unknown): RawRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawRecord)
    : {}
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function ensureUuid(value: unknown): string {
  return typeof value === 'string' && isUuid(value) ? value : uuidv4()
}

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed
    }
  }

  return fallback
}

function isoMinutesFrom(base: Date, minutesOffset: number): string {
  return new Date(base.getTime() + minutesOffset * 60_000).toISOString()
}

function pick<T>(items: T[], index: number): T {
  return items[index % items.length]
}

function clampArray<T>(items: T[], minimum: number, maximum: number, fill: (index: number) => T): T[] {
  const next = [...items]

  while (next.length < minimum) {
    next.push(fill(next.length))
  }

  return next.slice(0, maximum)
}

function buildFallbackUser(index: number, createdAt: string): UserRecord {
  const label = index + 1

  return {
    id: uuidv4(),
    name: `Generated User ${label}`,
    email: `generated.user.${label}@sceneforge.dev`,
    role: pick(DEFAULT_ROLES, index),
    status: pick(DEFAULT_USER_STATUS, index),
    created_at: createdAt,
  }
}

function normalizeUsers(rawUsers: unknown[], baseTime: Date): UserRecord[] {
  const mapped = rawUsers.map((value, index) => {
    const record = asRecord(value)
    const createdAt = parseDate(record.created_at, new Date(baseTime.getTime() + index * 3_600_000)).toISOString()
    const roleValue = asString(record.role, pick(DEFAULT_ROLES, index)) as UserRecord['role']
    const role = DEFAULT_ROLES.includes(roleValue) ? roleValue : pick(DEFAULT_ROLES, index)

    return {
      id: ensureUuid(record.id),
      name: asString(record.name, `Generated User ${index + 1}`),
      email: asString(record.email, `generated.user.${index + 1}@sceneforge.dev`).toLowerCase(),
      role,
      status: asString(record.status, pick(DEFAULT_USER_STATUS, index)),
      created_at: createdAt,
    }
  })

  return clampArray(mapped, 3, 5, (index) => buildFallbackUser(index, isoMinutesFrom(baseTime, index * 15)))
}

function buildFallbackTransaction(index: number, users: UserRecord[], baseTime: Date): TransactionRecord {
  const user = users[index % users.length]
  const amount = Number((49 + index * 17.5).toFixed(2))

  return {
    id: uuidv4(),
    user_id: user.id,
    amount,
    status: index % 5 === 0 ? 'failed' : pick(DEFAULT_TRANSACTION_STATUSES, index),
    type: pick(DEFAULT_TRANSACTION_TYPES, index),
    created_at: isoMinutesFrom(baseTime, index * 9),
    metadata: {
      channel: index % 2 === 0 ? 'web' : 'api',
      region: index % 3 === 0 ? 'us-east-1' : 'eu-west-1',
    },
  }
}

function normalizeTransactions(rawTransactions: unknown[], users: UserRecord[], baseTime: Date): TransactionRecord[] {
  const userIds = new Set(users.map((user) => user.id))

  const mapped = rawTransactions.map((value, index) => {
    const record = asRecord(value)
    const fallback = buildFallbackTransaction(index, users, baseTime)
    const userId = typeof record.user_id === 'string' && userIds.has(record.user_id) ? record.user_id : fallback.user_id

    return {
      id: ensureUuid(record.id),
      user_id: userId,
      amount: Number(asNumber(record.amount, fallback.amount).toFixed(2)),
      status: asString(record.status, fallback.status),
      type: asString(record.type, fallback.type),
      created_at: parseDate(record.created_at, new Date(fallback.created_at)).toISOString(),
      metadata: asRecord(record.metadata),
    }
  })

  return clampArray(mapped, 10, 15, (index) => buildFallbackTransaction(index, users, baseTime))
}

function buildFallbackLog(index: number, users: UserRecord[], transactions: TransactionRecord[], baseTime: Date): ActivityLogRecord {
  const user = users[index % users.length]
  const transaction = transactions[index % transactions.length]

  return {
    id: uuidv4(),
    user_id: user.id,
    transaction_id: transaction.id,
    action: pick(DEFAULT_LOG_ACTIONS, index),
    timestamp: isoMinutesFrom(baseTime, index * 6),
    details: `${user.name} triggered ${pick(DEFAULT_LOG_ACTIONS, index)} on ${transaction.type}.`,
  }
}

function normalizeLogs(
  rawLogs: unknown[],
  users: UserRecord[],
  transactions: TransactionRecord[],
  baseTime: Date,
): ActivityLogRecord[] {
  const userIds = new Set(users.map((user) => user.id))
  const transactionIds = new Set(transactions.map((transaction) => transaction.id))

  const mapped = rawLogs.map((value, index) => {
    const record = asRecord(value)
    const fallback = buildFallbackLog(index, users, transactions, baseTime)
    const userId = typeof record.user_id === 'string' && userIds.has(record.user_id) ? record.user_id : fallback.user_id
    const transactionId =
      typeof record.transaction_id === 'string' && transactionIds.has(record.transaction_id)
        ? record.transaction_id
        : fallback.transaction_id

    return {
      id: ensureUuid(record.id),
      user_id: userId,
      transaction_id: transactionId,
      action: asString(record.action, fallback.action),
      timestamp: parseDate(record.timestamp, new Date(fallback.timestamp)).toISOString(),
      details: asString(record.details, fallback.details),
    }
  })

  return clampArray(mapped, 15, 20, (index) => buildFallbackLog(index, users, transactions, baseTime))
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime())
    .map((log, index, logs) => {
      const transaction = transactions.find((item) => item.id === log.transaction_id)
      const minimumTime = transaction ? new Date(transaction.created_at).getTime() : baseTime.getTime()
      const previousTime = index > 0 ? new Date(logs[index - 1].timestamp).getTime() + 60_000 : minimumTime
      const timestamp = new Date(Math.max(new Date(log.timestamp).getTime(), minimumTime, previousTime)).toISOString()

      return {
        ...log,
        timestamp,
      }
    })
}

function normalizeFeatureFlags(rawFlags: unknown): Record<string, boolean> {
  const flags = asRecord(rawFlags)
  const entries = Object.entries(flags)
    .filter(([key]) => key.trim())
    .slice(0, 6)
    .map(([key, value], index) => [key, asBoolean(value, index % 2 === 0)] as const)

  if (entries.length >= 4) {
    return Object.fromEntries(entries)
  }

  DEFAULT_FEATURE_FLAGS.forEach((flagName, index) => {
    if (entries.length < 6 && !entries.some(([key]) => key === flagName)) {
      entries.push([flagName, index % 2 === 0])
    }
  })

  return Object.fromEntries(entries.slice(0, 6))
}

function deriveDashboardMetrics(
  users: UserRecord[],
  transactions: TransactionRecord[],
  activityLogs: ActivityLogRecord[],
): DashboardMetrics {
  const totalRevenue = transactions
    .filter((transaction) => transaction.status !== 'failed')
    .reduce((sum, transaction) => sum + transaction.amount, 0)

  const activeUsers = users.filter((user) => user.status.toLowerCase() === 'active').length
  const failedTransactions = transactions.filter((transaction) => transaction.status.toLowerCase().includes('fail')).length
  const suspiciousLogs = activityLogs.filter((log) =>
    /fail|conflict|anomaly|alert|suspicious/i.test(`${log.action} ${log.details}`),
  ).length

  return {
    total_revenue: Number(totalRevenue.toFixed(2)),
    active_users: activeUsers,
    failed_transactions: failedTransactions,
    anomaly_score: Number((((failedTransactions * 10) + suspiciousLogs * 3) / Math.max(activityLogs.length, 1)).toFixed(2)),
  }
}

export function stripClaudeMarkdown(rawText: string): string {
  const trimmed = rawText.trim()

  if (!trimmed.startsWith('```')) {
    return trimmed
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

export function extractJsonString(rawText: string): string {
  const cleaned = stripClaudeMarkdown(rawText)
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Claude did not return JSON.')
  }

  return cleaned.slice(start, end + 1)
}

export function parseSandboxPayload(rawText: string): SandboxData {
  const parsed = JSON.parse(extractJsonString(rawText)) as Record<string, unknown>
  const baseTime = new Date()
  const users = normalizeUsers(Array.isArray(parsed.users) ? parsed.users : [], new Date(baseTime.getTime() - 8 * 3_600_000))
  const transactions = normalizeTransactions(
    Array.isArray(parsed.transactions) ? parsed.transactions : [],
    users,
    new Date(baseTime.getTime() - 6 * 3_600_000),
  )
  const activityLogs = normalizeLogs(
    Array.isArray(parsed.activity_logs) ? parsed.activity_logs : [],
    users,
    transactions,
    new Date(baseTime.getTime() - 5 * 3_600_000),
  )
  const featureFlags = normalizeFeatureFlags(parsed.feature_flags)

  return {
    users,
    transactions,
    activity_logs: activityLogs,
    feature_flags: featureFlags,
    dashboard_metrics: deriveDashboardMetrics(users, transactions, activityLogs),
  }
}

export function createSandboxRecord(description: string, data: SandboxData) {
  const now = new Date()

  return {
    id: randomUUID(),
    description,
    data,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
  }
}

export function createTemplateRecord(name: string, description: string, data: SandboxData) {
  return {
    id: randomUUID(),
    name,
    description,
    data,
    created_at: new Date().toISOString(),
  }
}
