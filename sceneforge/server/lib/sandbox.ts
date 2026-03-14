import { randomUUID } from 'node:crypto'
import { validate as isUuid, v4 as uuidv4 } from 'uuid'

export type UserRecord = Record<string, unknown> & {
  id: string
}

export type PrimaryEntityRecord = Record<string, unknown> & {
  id: string
}

export type ActivityLogRecord = Record<string, unknown> & {
  id: string
  user_id: string
  primary_entity_id: string
}

export type DashboardMetrics = Record<string, unknown> & {
  primary_metric: number
  primary_metric_label: string
  active_users: number
  failed_records: number
  closed_records: number
  anomaly_score: number
  active_records?: number
  inactive_records?: number
}

export type SandboxData = {
  users: UserRecord[]
  primary_entities: PrimaryEntityRecord[]
  activity_logs: ActivityLogRecord[]
  feature_flags: Record<string, unknown>
  dashboard_metrics: DashboardMetrics
  schema_info: {
    primary_entity_name: string
    domain: string
  }
}

type RawRecord = Record<string, unknown>

function asRecord(value: unknown): RawRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawRecord)
    : {}
}

function ensureUuid(value: unknown): string {
  return typeof value === 'string' && isUuid(value) ? value : uuidv4()
}

function normalizeUsers(rawUsers: unknown): UserRecord[] {
  if (!Array.isArray(rawUsers)) {
    return []
  }

  return rawUsers
    .map((value) => asRecord(value))
    .filter((record) => Object.keys(record).length > 0)
    .map((record) => ({
      ...record,
      id: ensureUuid(record.id),
    }))
}

function isLikelyUserIdField(key: string): boolean {
  if (key === 'id' || key === 'primary_entity_id' || key === 'user_id') {
    return key === 'user_id'
  }

  return /(^user_id$|_user_id$|driver_id$|rider_id$|patient_id$|doctor_id$|customer_id$|owner_id$|admin_id$|analyst_id$|viewer_id$|member_id$|agent_id$|operator_id$|creator_id$|assignee_id$)/i.test(
    key,
  )
}

function repairPrimaryEntityUserRefs(
  primaryEntities: PrimaryEntityRecord[],
  users: UserRecord[],
): PrimaryEntityRecord[] {
  const userIds = new Set(users.map((user) => user.id))
  const fallbackUserIds = users.map((user) => user.id)

  if (fallbackUserIds.length === 0) {
    return primaryEntities
  }

  return primaryEntities.map((entity, index) => {
    const repaired = { ...entity }

    Object.entries(repaired).forEach(([key, value]) => {
      if (!isLikelyUserIdField(key)) {
        return
      }

      if (typeof value !== 'string' || !userIds.has(value)) {
        repaired[key] = fallbackUserIds[index % fallbackUserIds.length]
      }
    })

    return repaired
  })
}

function normalizePrimaryEntities(rawPrimaryEntities: unknown, users: UserRecord[]): PrimaryEntityRecord[] {
  if (!Array.isArray(rawPrimaryEntities)) {
    return []
  }

  const primaryEntities = rawPrimaryEntities
    .map((value) => asRecord(value))
    .filter((record) => Object.keys(record).length > 0)
    .map((record) => ({
      ...record,
      id: ensureUuid(record.id),
    }))

  return repairPrimaryEntityUserRefs(primaryEntities, users)
}

function normalizeActivityLogs(
  rawLogs: unknown,
  users: UserRecord[],
  primaryEntities: PrimaryEntityRecord[],
): ActivityLogRecord[] {
  if (!Array.isArray(rawLogs)) {
    return []
  }

  const userIds = users.map((user) => user.id)
  const validUserIds = new Set(userIds)
  const primaryEntityIds = primaryEntities.map((entity) => entity.id)
  const validPrimaryEntityIds = new Set(primaryEntityIds)

  return rawLogs
    .map((value) => asRecord(value))
    .filter((record) => Object.keys(record).length > 0)
    .map((record, index) => ({
      ...record,
      id: ensureUuid(record.id),
      user_id:
        typeof record.user_id === 'string' && validUserIds.has(record.user_id)
          ? record.user_id
          : userIds[index % userIds.length] ?? ensureUuid(undefined),
      primary_entity_id:
        typeof record.primary_entity_id === 'string' && validPrimaryEntityIds.has(record.primary_entity_id)
          ? record.primary_entity_id
          : primaryEntityIds[index % primaryEntityIds.length] ?? ensureUuid(undefined),
    }))
}

function isFailureStatus(value: unknown): boolean {
  return typeof value === 'string' && /failed|error|closed_lost|blocked|denied|degraded/i.test(value)
}

function isActiveStatus(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    !isFailureStatus(value) &&
    !isClosedStatus(value) &&
    !isInactiveStatus(value)
  )
}

function isInactiveStatus(value: unknown): boolean {
  return typeof value === 'string' && /inactive|archived|disabled|closed|failed|error|degraded|lost/i.test(value)
}

function isClosedStatus(value: unknown): boolean {
  return typeof value === 'string' && /closed|completed|won|lost|resolved|archived/i.test(value)
}

function findNumericField(primaryEntities: PrimaryEntityRecord[]): string | null {
  for (const entity of primaryEntities) {
    for (const [key, value] of Object.entries(entity)) {
      if (key !== 'id' && typeof value === 'number' && Number.isFinite(value)) {
        return key
      }
    }
  }

  return null
}

function deriveDashboardMetrics(
  primaryEntities: PrimaryEntityRecord[],
  users: UserRecord[],
  existingMetrics: Record<string, unknown>,
): DashboardMetrics {
  const numericField = findNumericField(primaryEntities)
  const derivedPrimaryMetric = numericField
    ? primaryEntities.reduce((sum, entity) => sum + (Number(entity[numericField]) || 0), 0)
    : 0

  const activeUsers = users.filter((user) => user.status === 'active').length
  const failedRecords = primaryEntities.filter((entity) => isFailureStatus(entity.status)).length
  const activeRecords = primaryEntities.filter((entity) => isActiveStatus(entity.status)).length
  const closedRecords = primaryEntities.filter((entity) => isClosedStatus(entity.status)).length
  const inactiveRecords = primaryEntities.filter((entity) => isInactiveStatus(entity.status)).length
  const currentAnomalyScore =
    typeof existingMetrics.anomaly_score === 'number' && Number.isFinite(existingMetrics.anomaly_score)
      ? existingMetrics.anomaly_score
      : undefined

  return {
    ...existingMetrics,
    primary_metric:
      typeof existingMetrics.primary_metric === 'number' && existingMetrics.primary_metric !== 0
        ? existingMetrics.primary_metric
        : derivedPrimaryMetric,
    primary_metric_label:
      typeof existingMetrics.primary_metric_label === 'string' && existingMetrics.primary_metric_label.trim()
        ? existingMetrics.primary_metric_label.trim()
        : numericField ?? 'total',
    active_users: activeUsers,
    failed_records: failedRecords,
    closed_records: closedRecords,
    anomaly_score: currentAnomalyScore && currentAnomalyScore !== 0
      ? currentAnomalyScore
      : failedRecords > 0
        ? Number((failedRecords / Math.max(primaryEntities.length, 1)).toFixed(2))
        : 0.1,
    active_records: activeRecords,
    inactive_records: inactiveRecords,
  }
}

export function parseSandboxPayload(rawText: string): SandboxData {
  const parsed = JSON.parse(rawText.trim()) as Record<string, unknown>
  const users = normalizeUsers(parsed.users)
  const primaryEntities = normalizePrimaryEntities(parsed.primary_entities, users)
  const activityLogs = normalizeActivityLogs(parsed.activity_logs, users, primaryEntities)
  const existingMetrics = asRecord(parsed.dashboard_metrics)
  const dashboardMetrics = deriveDashboardMetrics(primaryEntities, users, existingMetrics)

  return {
    users,
    primary_entities: primaryEntities,
    activity_logs: activityLogs,
    feature_flags: asRecord(parsed.feature_flags),
    dashboard_metrics: dashboardMetrics,
    schema_info: {
      primary_entity_name:
        typeof asRecord(parsed.schema_info).primary_entity_name === 'string'
          ? (asRecord(parsed.schema_info).primary_entity_name as string)
          : '',
      domain:
        typeof asRecord(parsed.schema_info).domain === 'string'
          ? (asRecord(parsed.schema_info).domain as string)
          : '',
    },
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
