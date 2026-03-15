import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  applyChaos,
  deleteSandboxRecord,
  generateFromTemplate,
  generateReport,
  generateSandbox,
  getMemoryStatus,
  getSandbox,
  getSandboxes,
  getTemplates,
  saveTemplate,
  testEndpoint,
  type ActivityLogRecord,
  type EndpointTestRecordResult,
  type EndpointTestResponse,
  type MemoryIndicator,
  type PrimaryEntityRecord,
  type QAReport,
  type SandboxSummary,
  type SandboxResponse,
  type TemplateSummary,
  type UserRecord,
} from '../lib/api'
import './Chatbot.css'

const examplePrompts = [
  'Generate 100 users with abandoned carts in the last 24h',
  'Create a mock database of failed login attempts from EU regions',
  'Design a scenario with 50 admins trying to access restricted endpoints',
  "Simulate traffic spike of 5000 users searching for 'wireless headphones'",
]

const chaosTypes = ['failed_payment', 'permission_conflict', 'data_anomaly'] as const
type TabId = 'users' | 'primary_entities' | 'activity_logs' | 'feature_flags' | 'endpoint_tester'
type LoadedSandboxData = NonNullable<SandboxResponse['data']>
type ChaosHighlights = {
  chaosSummary: string
  userChanges: number
  primaryEntityChanges: number
  activityLogChanges: number
  featureFlagChanges: number
  totalChanges: number
  changedTabs: number
}
type PreviousPromptItem = {
  prompt: string
  sandbox_id: string
  timestamp: number
}
type SessionReportItem = {
  report_id: string
  report: QAReport
  chaos_type: string
  generated_at: string
}
type TableRow = Record<string, unknown>
type PermissionTier = 'admin' | 'standard' | 'restricted'

const TEMPLATE_CACHE_STORAGE_KEY = 'sceneforge_templates_cache'
const PINNED_COLUMNS = [
  'id',
  'user_id',
  'primary_entity_id',
  'name',
  'email',
  'role',
  'status',
  'amount',
  'type',
  'action',
  'timestamp',
  'created_at',
] as const

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function formatDate(value: string): string {
  const parsed = new Date(value)

  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleString()
}

function capitalizeLabel(value: string): string {
  return value
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function normalizeDashboardMetrics(metrics: unknown) {
  const record =
    metrics && typeof metrics === 'object' && !Array.isArray(metrics)
      ? (metrics as Record<string, unknown>)
      : {}

  const primaryMetric =
    typeof record.primary_metric === 'number'
      ? record.primary_metric
      : typeof record.total_value === 'number'
        ? record.total_value
        : typeof record.total_revenue === 'number'
          ? record.total_revenue
          : 0

  const primaryMetricLabel =
    typeof record.primary_metric_label === 'string'
      ? record.primary_metric_label
      : typeof record.total_value === 'number' || typeof record.total_revenue === 'number'
        ? 'value'
        : 'total'

  const activeUsers = typeof record.active_users === 'number' ? record.active_users : 0
  const failedRecords =
    typeof record.failed_records === 'number'
      ? record.failed_records
      : typeof record.failed_entities === 'number'
        ? record.failed_entities
        : typeof record.failed_transactions === 'number'
          ? record.failed_transactions
          : 0
  const closedRecords = typeof record.closed_records === 'number' ? record.closed_records : 0

  const anomalyScore = typeof record.anomaly_score === 'number' ? record.anomaly_score : 0
  const activeRecords = typeof record.active_records === 'number' ? record.active_records : 0
  const inactiveRecords = typeof record.inactive_records === 'number' ? record.inactive_records : 0

  return {
    primary_metric: primaryMetric,
    primary_metric_label: primaryMetricLabel,
    active_users: activeUsers,
    failed_records: failedRecords,
    closed_records: closedRecords,
    anomaly_score: anomalyScore,
    active_records: activeRecords,
    inactive_records: inactiveRecords,
  }
}

function formatMetricLabel(value: string): string {
  const normalized = value.trim().replace(/_usd$/i, '').replace(/\s+/g, '_')
  const pretty = capitalizeLabel(normalized)

  if (!pretty) {
    return 'Total'
  }

  return /^total\b/i.test(pretty) ? pretty : `Total ${pretty}`
}

function formatMetricValue(value: number): string {
  if (!Number.isFinite(value)) {
    return '0'
  }

  const hasFraction = Math.abs(value % 1) > 0
  return value.toLocaleString(undefined, {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: hasFraction ? 2 : 2,
  })
}

function getTimeRemaining(expiresAt: string) {
  const diff = new Date(expiresAt).getTime() - Date.now()
  if (diff <= 0) return 'Expired'
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  return `${hours}h ${minutes}m remaining`
}

function getRelatedUserIdsFromEntity(entity: PrimaryEntityRecord): string[] {
  return Object.entries(entity)
    .filter(([key, value]) => key.endsWith('_id') && key !== 'id' && typeof value === 'string')
    .map(([, value]) => value as string)
}

function getPermissionTier(role: string): PermissionTier {
  const r = role.toLowerCase()
  if (r.includes('admin') || r.includes('manager') || r.includes('owner')) return 'admin'
  if (
    r.includes('viewer') ||
    r.includes('read') ||
    r.includes('guest') ||
    r.includes('patient') ||
    r.includes('shopper')
  ) return 'restricted'
  return 'standard'
}

function renderSkeletonTableRows(rowCount = 8, columnCount = 6) {
  return (
    <div className="table-skeleton" aria-hidden="true">
      {Array.from({ length: rowCount }).map((_, rowIndex) => (
        <div key={rowIndex} className="table-skeleton-row">
          {Array.from({ length: columnCount }).map((__, columnIndex) => (
            <span
              key={`${rowIndex}-${columnIndex}`}
              className="table-skeleton-cell"
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function getOrderedColumns(rows: TableRow[]): string[] {
  const discoveredColumns: string[] = []

  rows.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (!discoveredColumns.includes(key)) {
        discoveredColumns.push(key)
      }
    })
  })

  const pinnedColumns = PINNED_COLUMNS.filter((key) => discoveredColumns.includes(key)) as string[]
  const remainingColumns = discoveredColumns.filter((key) => !(PINNED_COLUMNS as readonly string[]).includes(key))

  return [...pinnedColumns, ...remainingColumns]
}

function renderCellValue(value: unknown) {
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
    const fullValue = JSON.stringify(value)
    const condensedValue =
      fullValue.length > 40 ? `${fullValue.slice(0, 40).trimEnd()}...` : fullValue

    return (
      <span className="cell-truncated-value" title={fullValue}>
        {condensedValue}
      </span>
    )
  }

  if (typeof value === 'string' && /(timestamp|created_at)/i.test(value)) {
    return formatDate(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (value === null || value === undefined || value === '') {
    return '—'
  }

  return value
}

function renderDataTable(rows: TableRow[], changedIds: string[]) {
  const columns = getOrderedColumns(rows)

  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column}>{column}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const rowId = typeof row.id === 'string' ? row.id : undefined
          const isChanged = rowId ? changedIds.includes(rowId) : false

          return (
            <tr
              key={`${rowId ?? 'row'}-${index}`}
              className={isChanged ? 'changed-row' : undefined}
            >
              {columns.map((column) => (
                <td key={`${column}-${index}`}>{renderCellValue(row[column])}</td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function createChaosHighlights(
  userChanges: number,
  primaryEntityChanges: number,
  activityLogChanges: number,
  featureFlagChanges: number,
  chaosSummary: string,
): ChaosHighlights {
  const counts = [userChanges, primaryEntityChanges, activityLogChanges, featureFlagChanges]

  return {
    chaosSummary,
    userChanges,
    primaryEntityChanges,
    activityLogChanges,
    featureFlagChanges,
    totalChanges: counts.reduce((sum, count) => sum + count, 0),
    changedTabs: counts.filter((count) => count > 0).length,
  }
}

function getSandboxIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search)
  const sandboxId = params.get('sandbox')

  return sandboxId?.trim() || null
}

function setSandboxUrl(sandboxId: string) {
  window.history.pushState({}, '', `/chat?sandbox=${encodeURIComponent(sandboxId)}`)
}

function clearSandboxUrl() {
  window.history.replaceState({}, '', '/chat')
}

function mapSandboxesToPromptItems(items: SandboxSummary[]): PreviousPromptItem[] {
  return items.map((item, index) => ({
    prompt: item.description,
    sandbox_id: item.id,
    timestamp: Number.isFinite(Date.parse(item.created_at))
      ? Date.parse(item.created_at)
      : Date.now() - index,
  }))
}

function readCachedTemplates(): TemplateSummary[] {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const raw = window.localStorage.getItem(TEMPLATE_CACHE_STORAGE_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is TemplateSummary => {
          const record = item as Record<string, unknown>
          return (
            typeof record.id === 'string' &&
            typeof record.name === 'string' &&
            typeof record.description === 'string' &&
            typeof record.created_at === 'string'
          )
        })
      : []
  } catch {
    return []
  }
}

function writeCachedTemplates(templates: TemplateSummary[]) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(TEMPLATE_CACHE_STORAGE_KEY, JSON.stringify(templates))
  } catch {
    return
  }
}

function renderUsersTable(users: UserRecord[], changedIds: string[]) {
  return renderDataTable(users as unknown as TableRow[], changedIds)
}

function renderPrimaryEntitiesTable(primaryEntities: PrimaryEntityRecord[], changedIds: string[]) {
  return renderDataTable(primaryEntities as unknown as TableRow[], changedIds)
}

function renderActivityLogsTable(activityLogs: ActivityLogRecord[], changedIds: string[]) {
  return renderDataTable(activityLogs as unknown as TableRow[], changedIds)
}

function renderFeatureFlagsTable(featureFlags: Record<string, boolean>, changedFlags: string[]) {
  return renderDataTable(
    Object.entries(featureFlags).map(([flag, enabled]) => ({
      id: flag,
      flag,
      enabled,
    })),
    changedFlags,
  )
}

const Chatbot: React.FC = () => {
  const [inputText, setInputText] = useState('')
  const [previousPrompts, setPreviousPrompts] = useState<PreviousPromptItem[]>([])
  const [sandbox, setSandbox] = useState<SandboxResponse | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>('users')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isHydratingSandbox, setIsHydratingSandbox] = useState(false)
  const [isApplyingChaos, setIsApplyingChaos] = useState(false)
  const [isSavingTemplate, setIsSavingTemplate] = useState(false)
  const [isDbModalOpen, setIsDbModalOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [chaosIndicator, setChaosIndicator] = useState<string | null>(null)
  const [expiredSandboxMessage, setExpiredSandboxMessage] = useState<string | null>(null)
  const [chaosHighlights, setChaosHighlights] = useState<ChaosHighlights | null>(null)
  const [changedRowIds, setChangedRowIds] = useState<string[]>([])
  const [changedFeatureFlags, setChangedFeatureFlags] = useState<string[]>([])
  const [primaryEntityTabLabel, setPrimaryEntityTabLabel] = useState('Records')
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [isLoadingPrompts, setIsLoadingPrompts] = useState(false)
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false)
  const [isLaunchingTemplateId, setIsLaunchingTemplateId] = useState<string | null>(null)
  const [isTemplateFormOpen, setIsTemplateFormOpen] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [isCopyLinkSuccess, setIsCopyLinkSuccess] = useState(false)
  const [isChaosButtonFlashing, setIsChaosButtonFlashing] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null)
  const [selectedViewingUserId, setSelectedViewingUserId] = useState<string>('')
  const [isChaosBannerDismissed, setIsChaosBannerDismissed] = useState(false)
  const [lastChaosType, setLastChaosType] = useState<string>('')
  const [sessionReports, setSessionReports] = useState<SessionReportItem[]>([])
  const [reportModalOpen, setReportModalOpen] = useState(false)
  const [reportModalContent, setReportModalContent] = useState<QAReport | null>(null)
  const [isGeneratingReport, setIsGeneratingReport] = useState(false)
  const preChaosDataRef = useRef<LoadedSandboxData | null>(null)
  const [endpointTargetUrl, setEndpointTargetUrl] = useState('')
  const [endpointMethod, setEndpointMethod] = useState<'GET' | 'POST' | 'PUT' | 'DELETE'>('POST')
  const [endpointEntityType, setEndpointEntityType] = useState<'users' | 'primary_entities' | 'activity_logs'>('primary_entities')
  const [injectChaos, setInjectChaos] = useState(false)
  const [isRunningEndpointTest, setIsRunningEndpointTest] = useState(false)
  const [endpointLastResponse, setEndpointLastResponse] = useState<EndpointTestResponse | null>(null)
  const [endpointDisplayedResults, setEndpointDisplayedResults] = useState<EndpointTestRecordResult[]>([])
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [memoryIndicator, setMemoryIndicator] = useState<MemoryIndicator | null>(null)
  const endpointResultsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isRunningEndpointTest && endpointResultsRef.current) {
      endpointResultsRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [isRunningEndpointTest])
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  useEffect(() => {
    if (!chaosIndicator) {
      return undefined
    }

    const timeoutId = window.setTimeout(() => {
      setChaosIndicator(null)
    }, 3200)

    return () => window.clearTimeout(timeoutId)
  }, [chaosIndicator])

  useEffect(() => {
    setTemplates(readCachedTemplates())
  }, [])

  useEffect(() => {
    if (!isCopyLinkSuccess) {
      return undefined
    }

    const timeoutId = window.setTimeout(() => {
      setIsCopyLinkSuccess(false)
    }, 2000)

    return () => window.clearTimeout(timeoutId)
  }, [isCopyLinkSuccess])

  useEffect(() => {
    if (!isChaosButtonFlashing) {
      return undefined
    }

    const timeoutId = window.setTimeout(() => {
      setIsChaosButtonFlashing(false)
    }, 500)

    return () => window.clearTimeout(timeoutId)
  }, [isChaosButtonFlashing])

  useEffect(() => {
    if (!sandbox?.expires_at) {
      setTimeRemaining(null)
      return undefined
    }

    const updateRemaining = () => {
      const nextRemaining = getTimeRemaining(sandbox.expires_at)
      setTimeRemaining(nextRemaining)

      if (nextRemaining === 'Expired') {
        setSandbox(null)
        setExpiredSandboxMessage('This sandbox has expired')
        clearSandboxUrl()
      }
    }

    updateRemaining()
    const intervalId = window.setInterval(updateRemaining, 60_000)

    return () => window.clearInterval(intervalId)
  }, [sandbox?.expires_at])

  const loadSidebarData = useCallback(async () => {
    setIsLoadingPrompts(true)
    setIsLoadingTemplates(true)

    try {
      const [nextSandboxes, nextTemplates] = await Promise.all([
        getSandboxes(),
        getTemplates(),
      ])

      setPreviousPrompts(mapSandboxesToPromptItems(nextSandboxes))
      setTemplates(nextTemplates)
      writeCachedTemplates(nextTemplates)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsLoadingPrompts(false)
      setIsLoadingTemplates(false)
    }
  }, [])

  useEffect(() => {
    void loadSidebarData()
  }, [loadSidebarData])

  useEffect(() => {
    getMemoryStatus()
      .then(setMemoryIndicator)
      .catch(() => setMemoryIndicator(null))
  }, [])

  const restoreSandbox = useCallback(
    async (sandboxId: string, promptText?: string) => {
      setIsHydratingSandbox(true)
      setErrorMessage(null)
      setExpiredSandboxMessage(null)

      try {
        const restoredSandbox = await getSandbox(sandboxId)
        setSandbox(restoredSandbox)
        setPrimaryEntityTabLabel(capitalizeLabel(restoredSandbox.data.schema_info?.primary_entity_name || 'records'))
        setChaosHighlights(null)
        setChangedRowIds([])
        setChangedFeatureFlags([])
        setActiveTab('users')
        setSandboxUrl(restoredSandbox.sandbox_id)
        if (promptText) {
          setInputText(promptText)
        }
      } catch (error) {
        const message = getErrorMessage(error)
        if (/not found|expired/i.test(message)) {
          setSandbox(null)
          setExpiredSandboxMessage('This sandbox has expired.')
          clearSandboxUrl()
        } else {
          setErrorMessage(message)
        }
      } finally {
        setIsHydratingSandbox(false)
      }
    },
    [],
  )

  useEffect(() => {
    const sandboxId = getSandboxIdFromUrl()
    if (!sandboxId) {
      return
    }

    async function hydrateSandbox() {
      await restoreSandbox(sandboxId)
    }

    void hydrateSandbox()
  }, [restoreSandbox])

  const headerSandboxId = sandbox?.sandbox_id ?? 'No sandbox loaded'
  const showLoadingWorkspace = isGenerating || isHydratingSandbox
  const sandboxData = useMemo<LoadedSandboxData | null>(() => {
    if (!sandbox?.data) {
      return null
    }

    return {
      users: Array.isArray(sandbox.data.users) ? sandbox.data.users : [],
      primary_entities: Array.isArray(sandbox.data.primary_entities) ? sandbox.data.primary_entities : [],
      activity_logs: Array.isArray(sandbox.data.activity_logs) ? sandbox.data.activity_logs : [],
      feature_flags:
        sandbox.data.feature_flags && typeof sandbox.data.feature_flags === 'object'
          ? sandbox.data.feature_flags
          : {},
      dashboard_metrics: normalizeDashboardMetrics(sandbox.data.dashboard_metrics),
      schema_info: sandbox.data.schema_info ?? {
        primary_entity_name: 'records',
        domain: 'custom domain',
      },
    }
  }, [sandbox])
  const metrics = sandboxData?.dashboard_metrics
  const viewingUsers = useMemo(() => sandboxData?.users ?? [], [sandboxData])
  const selectedViewingUser = useMemo(
    () => viewingUsers.find((user) => user.id === selectedViewingUserId) ?? null,
    [selectedViewingUserId, viewingUsers],
  )
  const currentViewingRole = selectedViewingUser?.role ?? 'admin'
  const currentPermissionTier = getPermissionTier(currentViewingRole)

  useEffect(() => {
    if (!viewingUsers.length) {
      setSelectedViewingUserId('')
      return
    }

    const hasSelectedUser = viewingUsers.some((user) => user.id === selectedViewingUserId)
    if (hasSelectedUser) {
      return
    }

    const preferredUser =
      viewingUsers.find((user) => getPermissionTier(user.role) === 'admin') ??
      viewingUsers[0]

    setSelectedViewingUserId(preferredUser.id)
  }, [selectedViewingUserId, viewingUsers])

  useEffect(() => {
    if (currentPermissionTier === 'restricted' && activeTab === 'activity_logs') {
      setActiveTab('primary_entities')
    }
  }, [activeTab, currentPermissionTier])

  const changedRowIdSet = useMemo(() => new Set(changedRowIds), [changedRowIds])
  const tabChangeCounts = useMemo(
    () => ({
      users: chaosHighlights?.userChanges ?? 0,
      primary_entities: chaosHighlights?.primaryEntityChanges ?? 0,
      activity_logs: chaosHighlights?.activityLogChanges ?? 0,
      feature_flags: chaosHighlights?.featureFlagChanges ?? 0,
    }),
    [chaosHighlights],
  )

  const activeTable = useMemo(() => {
    if (!sandboxData) {
      return null
    }

    const filteredPrimaryEntities = currentPermissionTier !== 'admin' && selectedViewingUser
      ? sandboxData.primary_entities.filter((entity) =>
          getRelatedUserIdsFromEntity(entity).includes(selectedViewingUser.id),
        )
      : sandboxData.primary_entities
    const allowedPrimaryEntityIds = new Set(filteredPrimaryEntities.map((entity) => entity.id))
    const filteredActivityLogs = currentPermissionTier === 'standard' && selectedViewingUser
      ? sandboxData.activity_logs.filter(
          (log) =>
            log.user_id === selectedViewingUser.id ||
            allowedPrimaryEntityIds.has(log.primary_entity_id),
        )
      : sandboxData.activity_logs

    if (currentPermissionTier === 'restricted' && activeTab === 'activity_logs') {
      return <div className="access-restricted-panel">Access Restricted</div>
    }

    switch (activeTab) {
      case 'users':
        return renderUsersTable(sandboxData.users, Array.from(changedRowIdSet))
      case 'primary_entities':
        return renderPrimaryEntitiesTable(filteredPrimaryEntities, Array.from(changedRowIdSet))
      case 'activity_logs':
        return renderActivityLogsTable(filteredActivityLogs, Array.from(changedRowIdSet))
      case 'feature_flags':
        return renderFeatureFlagsTable(sandboxData.feature_flags, changedFeatureFlags)
      default:
        return null
    }
  }, [activeTab, changedFeatureFlags, changedRowIdSet, currentPermissionTier, sandboxData, selectedViewingUser])

  async function handleCopyLink() {
    if (!sandbox) {
      return
    }

    try {
      await navigator.clipboard.writeText(window.location.href)
      setIsCopyLinkSuccess(true)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  async function handleSubmit() {
    const description = inputText.trim()
    if (!description || isGenerating) {
      return
    }

    setIsGenerating(true)
    setErrorMessage(null)
    setStatusMessage(null)
    setChaosIndicator(null)
    setExpiredSandboxMessage(null)
    setChaosHighlights(null)
    setChangedRowIds([])
    setChangedFeatureFlags([])
    setIsTemplateFormOpen(false)
    setIsChaosBannerDismissed(false)

    try {
      const result = await generateSandbox(description)
      setSandbox(result)
      setPrimaryEntityTabLabel(capitalizeLabel(result.data.schema_info?.primary_entity_name || 'records'))
      setActiveTab('users')
      if (result.memory) setMemoryIndicator(result.memory)
      setPreviousPrompts((current) => [
        { prompt: description, sandbox_id: result.sandbox_id, timestamp: Date.now() },
        ...current.filter((item) => item.sandbox_id !== result.sandbox_id),
      ].slice(0, 20))
      setSandboxUrl(result.sandbox_id)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleChaos() {
    if (!sandbox || isApplyingChaos) {
      return
    }

    setIsApplyingChaos(true)
    setErrorMessage(null)
    setStatusMessage(null)

    const chaosType = chaosTypes[Math.floor(Math.random() * chaosTypes.length)]
    preChaosDataRef.current = JSON.parse(JSON.stringify(sandbox.data)) as LoadedSandboxData

    try {
      const result = await applyChaos(sandbox.sandbox_id, chaosType)
      const highlightIds = Array.from(new Set(result.changedIds))
      const changedIdSet = new Set(highlightIds)
      const changedUsers = result.data.users.filter((row) => changedIdSet.has(row.id)).length
      const changedPrimaryEntities = result.data.primary_entities.filter((row) => changedIdSet.has(row.id)).length
      const changedActivityLogs = result.data.activity_logs.filter((row) => changedIdSet.has(row.id)).length
      const nextHighlights = createChaosHighlights(
        changedUsers,
        changedPrimaryEntities,
        changedActivityLogs,
        0,
        result.chaos_summary,
      )
      setSandbox(result)
      setPrimaryEntityTabLabel(capitalizeLabel(result.data.schema_info?.primary_entity_name || 'records'))
      setChaosHighlights(nextHighlights)
      setChangedRowIds(highlightIds)
      setChangedFeatureFlags([])
      setChaosIndicator(result.chaos_summary)
      setIsChaosButtonFlashing(true)
      setIsChaosBannerDismissed(false)
      setLastChaosType(chaosType)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsApplyingChaos(false)
    }
  }

  async function handleGenerateReport() {
    if (!sandbox || !chaosHighlights || isGeneratingReport) {
      return
    }
    const preData = preChaosDataRef.current
    if (!preData) {
      setErrorMessage('No pre-chaos snapshot available. Inject chaos first.')
      return
    }
    setIsGeneratingReport(true)
    setErrorMessage(null)
    try {
      const { report_id, report } = await generateReport({
        sandbox_id: sandbox.sandbox_id,
        pre_chaos_data: preData,
        post_chaos_data: sandbox.data,
        changed_ids: changedRowIds,
        chaos_summary: chaosHighlights.chaosSummary,
        chaos_type: lastChaosType || 'unknown',
      })
      setSessionReports((prev) => [
        {
          report_id,
          report,
          chaos_type: lastChaosType || 'unknown',
          generated_at: report.generated_at ?? new Date().toISOString(),
        },
        ...prev,
      ])
      setReportModalContent(report)
      setReportModalOpen(true)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsGeneratingReport(false)
    }
  }

  function handleOpenReport(item: SessionReportItem) {
    setReportModalContent(item.report)
    setReportModalOpen(true)
  }

  function handleDownloadReport() {
    const report = reportModalContent
    if (!report) return
    const lines: string[] = []
    lines.push(report.report_title ?? 'QA Edge Case Report')
    lines.push('')
    lines.push('Generated: ' + (report.generated_at ?? '—'))
    lines.push('Chaos type: ' + (report.chaos_type ?? '—'))
    lines.push('')
    lines.push('EXECUTIVE SUMMARY')
    lines.push('────────────────')
    lines.push(report.executive_summary ?? '')
    lines.push('')
    if (report.what_happened?.length) {
      lines.push('WHAT HAPPENED')
      lines.push('─────────────')
      report.what_happened.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
      lines.push('')
    }
    if (report.vulnerabilities?.length) {
      lines.push('VULNERABILITIES')
      lines.push('───────────────')
      report.vulnerabilities.forEach((v) => {
        lines.push(`- [${(v.severity ?? '').toUpperCase()}] ${v.title ?? ''}`)
        lines.push(`  ${v.description ?? ''}`)
        lines.push(`  Affected: ${v.affected_component ?? '—'}`)
      })
      lines.push('')
    }
    if (report.affected_systems?.length) {
      lines.push('AFFECTED SYSTEMS')
      lines.push('────────────────')
      report.affected_systems.forEach((a) => {
        lines.push(`- ${a.system ?? '—'} [${(a.impact ?? '').toUpperCase()}]`)
        lines.push(`  ${a.details ?? ''}`)
      })
      lines.push('')
    }
    if (report.test_cases?.length) {
      lines.push('TEST CASES')
      lines.push('───────────')
      report.test_cases.forEach((tc) => {
        lines.push(`${tc.id ?? '—'} [${(tc.priority ?? '').toUpperCase()}]`)
        lines.push(`Title: ${tc.title ?? '—'}`)
        lines.push(`Scenario: ${tc.scenario ?? '—'}`)
        lines.push(`Expected: ${tc.expected_result ?? '—'}`)
        lines.push('')
      })
    }
    if (report.recommended_fixes?.length) {
      lines.push('RECOMMENDED FIXES')
      lines.push('─────────────────')
      report.recommended_fixes.forEach((r) => {
        lines.push(`${r.priority ?? ''}. ${r.fix ?? '—'}`)
        lines.push(`   Rationale: ${r.rationale ?? '—'}`)
      })
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `qa-report-${report.chaos_type ?? 'report'}-${(report.generated_at ?? '').slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleRunEndpointTest(useChaos: boolean) {
    if (!sandbox || isRunningEndpointTest) return
    const url = (useChaos ? endpointTargetUrl : endpointTargetUrl) || endpointTargetUrl.trim()
    if (!url) {
      setEndpointError('Enter a target URL.')
      return
    }
    setEndpointError(null)
    setEndpointDisplayedResults([])
    setEndpointLastResponse(null)
    setIsRunningEndpointTest(true)
    const doChaos = useChaos || injectChaos
    try {
      const res = await testEndpoint({
        sandbox_id: sandbox.sandbox_id,
        target_url: url,
        http_method: endpointMethod,
        entity_type: endpointEntityType,
        inject_chaos: doChaos,
      })
      setEndpointLastResponse(res)
      setEndpointDisplayedResults([])
      const results = res.test_results
      for (let i = 0; i < results.length; i++) {
        await new Promise((r) => setTimeout(r, 80 + Math.random() * 70))
        setEndpointDisplayedResults((prev) => [...prev, results[i]])
      }
    } catch (err) {
      const msg = getErrorMessage(err)
      const unreachable = /fetch|network|failed to fetch|could not reach/i.test(msg)
      setEndpointError(unreachable ? `Could not reach ${url} — make sure your server is running.` : msg)
    } finally {
      setIsRunningEndpointTest(false)
    }
  }

  function handleDownloadEndpointReport() {
    const res = endpointLastResponse
    if (!res) return
    const lines: string[] = []
    lines.push('ENDPOINT TEST REPORT')
    lines.push('')
    lines.push(`Target: ${endpointTargetUrl}`)
    lines.push(`Method: ${endpointMethod}`)
    lines.push(`Entity: ${endpointEntityType}`)
    lines.push(`Total: ${res.total}  Passed: ${res.passed}  Failed: ${res.failed}`)
    lines.push('')
    lines.push('PER-REQUEST RESULTS')
    lines.push('───────────────────')
    res.test_results.forEach((t) => {
      lines.push(`${t.ok ? '✓' : '✗'} ${t.record_id}  ${t.status || 'error'}  ${t.duration_ms}ms  ${t.error ?? (t.response_body ?? '').slice(0, 80)}`)
    })
    const a = res.analysis
    if (a) {
      lines.push('')
      lines.push('SUMMARY')
      lines.push('────────')
      lines.push(a.summary ?? '')
      lines.push('')
      if (a.findings?.length) {
        lines.push('FINDINGS')
        lines.push('────────')
        a.findings.forEach((f) => {
          lines.push(`[${(f.severity ?? '').toUpperCase()}] ${f.title ?? ''}`)
          lines.push(`  ${f.description ?? ''}`)
        })
        lines.push('')
      }
      if (a.test_cases?.length) {
        lines.push('TEST CASES')
        lines.push('──────────')
        a.test_cases.forEach((tc) => {
          lines.push(`${tc.id ?? '—'} [${(tc.status ?? '').toUpperCase()}] ${tc.title ?? ''}`)
          lines.push(`  Scenario: ${tc.scenario ?? ''}`)
          lines.push(`  Expected: ${tc.expected_result ?? ''}`)
          lines.push(`  Actual: ${tc.actual_result ?? ''}`)
        })
        lines.push('')
      }
      if (a.recommended_fixes?.length) {
        lines.push('RECOMMENDED FIXES')
        lines.push('─────────────────')
        a.recommended_fixes.forEach((r) => {
          lines.push(`${r.priority ?? ''}. ${r.fix ?? ''}`)
          lines.push(`   ${r.rationale ?? ''}`)
        })
      }
      if (a.chaos_findings) {
        lines.push('')
        lines.push('CHAOS FINDINGS')
        lines.push('──────────────')
        lines.push(a.chaos_findings)
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const blobUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = blobUrl
    anchor.download = `endpoint-test-${new Date().toISOString().slice(0, 10)}.txt`
    anchor.click()
    URL.revokeObjectURL(blobUrl)
  }

  function handleSaveTemplate() {
    if (!sandbox || isSavingTemplate) {
      return
    }

    setTemplateName('')
    setIsTemplateFormOpen(true)
    setStatusMessage(null)
  }

  async function handleConfirmSaveTemplate() {
    if (!sandbox || isSavingTemplate) {
      return
    }

    const name = templateName.trim()
    if (!name) {
      return
    }

    setIsSavingTemplate(true)
    setErrorMessage(null)

    try {
      await saveTemplate(sandbox.sandbox_id, name)
      setStatusMessage('Template saved')
      setIsTemplateFormOpen(false)
      setTemplateName('')
      await loadSidebarData()
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsSavingTemplate(false)
    }
  }

  async function handleGenerateFromTemplate(template: TemplateSummary) {
    if (isLaunchingTemplateId) {
      return
    }

    setIsLaunchingTemplateId(template.id)
    setIsGenerating(true)
    setErrorMessage(null)
    setStatusMessage(null)
    setChaosIndicator(null)
    setExpiredSandboxMessage(null)
    setChangedRowIds([])
    setChangedFeatureFlags([])
    setChaosHighlights(null)
    setInputText(template.description)

    try {
      const result = await generateFromTemplate(template.id)
      setSandbox(result)
      setPrimaryEntityTabLabel(capitalizeLabel(result.data.schema_info?.primary_entity_name || 'records'))
      setActiveTab('users')
      setSandboxUrl(result.sandbox_id)
      if (result.memory) setMemoryIndicator(result.memory)
      setStatusMessage(`Template launched: ${template.name}`)
      setPreviousPrompts((current) => [
        { prompt: template.description, sandbox_id: result.sandbox_id, timestamp: Date.now() },
        ...current.filter((item) => item.sandbox_id !== result.sandbox_id),
      ].slice(0, 20))
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsLaunchingTemplateId(null)
      setIsGenerating(false)
    }
  }

  async function handleDeletePrompt(prompt: PreviousPromptItem) {
    if (!prompt.sandbox_id) {
      return
    }

    setErrorMessage(null)
    setStatusMessage(null)

    try {
      await deleteSandboxRecord(prompt.sandbox_id)
      setPreviousPrompts((current) => current.filter((item) => item.sandbox_id !== prompt.sandbox_id))

      if (sandbox?.sandbox_id === prompt.sandbox_id) {
        handleReset()
      }

      setStatusMessage('Sandbox deleted')
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  function handleReset() {
    setSandbox(null)
    setActiveTab('users')
    setInputText('')
    setErrorMessage(null)
    setStatusMessage(null)
    setChaosIndicator(null)
    setExpiredSandboxMessage(null)
    setChaosHighlights(null)
    setChangedRowIds([])
    setChangedFeatureFlags([])
    setIsTemplateFormOpen(false)
    setTemplateName('')
    setTimeRemaining(null)
    setSelectedViewingUserId('')
    clearSandboxUrl()
  }

  return (
    <div className="chatbot-layout">
      {isMobileSidebarOpen ? (
        <div className="mobile-sidebar-overlay" onClick={() => setIsMobileSidebarOpen(false)} aria-hidden="true" />
      ) : null}

      <aside className={`chat-sidebar glass ${isMobileSidebarOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-header">
          <a href="/" className="logo-link">
            <span className="logo-text">
              Scene<span className="logo-accent">Forge</span>
            </span>
          </a>
          <button type="button" className="new-chat-btn" onClick={handleReset}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            New Project
          </button>
        </div>

        <div className="history-section">
          <h3>Previous Prompts</h3>
          <ul className="history-list">
            {isLoadingPrompts && previousPrompts.length === 0 ? (
              <li className="history-empty">Loading recent sandboxes...</li>
            ) : previousPrompts.length === 0 ? (
              <li className="history-empty">Generated prompts will appear here.</li>
            ) : (
              previousPrompts.map((prompt, index) => (
                <li key={`${prompt.sandbox_id || prompt.prompt}-${index}`} className="history-item">
                  <div className="history-entry">
                    <button
                      type="button"
                      className="history-button"
                      onClick={() => {
                        if (!prompt.sandbox_id) {
                          setInputText(prompt.prompt)
                          setErrorMessage('This saved prompt cannot restore a sandbox yet. Generate it again to save a restorable record.')
                          return
                        }

                        void restoreSandbox(prompt.sandbox_id, prompt.prompt)
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                      </svg>
                      <span className="history-text">{prompt.prompt}</span>
                    </button>
                    <button
                      type="button"
                      className="history-delete-btn"
                      onClick={() => void handleDeletePrompt(prompt)}
                      aria-label={`Delete sandbox ${prompt.prompt}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6l-1 14H6L5 6"></path>
                        <path d="M10 11v6"></path>
                        <path d="M14 11v6"></path>
                        <path d="M9 6V4h6v2"></path>
                      </svg>
                    </button>
                  </div>
                </li>
              ))
            )}
          </ul>

          <div className="templates-section">
            <h3>Templates</h3>
            <ul className="history-list">
              {isLoadingTemplates && templates.length === 0 ? (
                <li className="history-empty">Loading templates...</li>
              ) : templates.length === 0 ? (
                <li className="history-empty">Saved templates will appear here.</li>
              ) : (
                templates.map((template) => (
                  <li key={template.id} className="history-item">
                    <button
                      type="button"
                      className="history-button"
                      onClick={() => void handleGenerateFromTemplate(template)}
                      disabled={isLaunchingTemplateId === template.id || isGenerating}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                      </svg>
                      <span className="history-text">
                        {isLaunchingTemplateId === template.id ? `Launching ${template.name}...` : template.name}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>

          <div className="reports-section">
            <h3>Reports</h3>
            <ul className="history-list">
              {sessionReports.length === 0 ? (
                <li className="history-empty">QA reports from this session will appear here.</li>
              ) : (
                sessionReports.map((item) => (
                  <li key={item.report_id} className="history-item">
                    <button
                      type="button"
                      className="history-button"
                      onClick={() => handleOpenReport(item)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                        <line x1="16" y1="13" x2="8" y2="13"></line>
                        <line x1="16" y1="17" x2="8" y2="17"></line>
                        <polyline points="10 9 9 9 8 9"></polyline>
                      </svg>
                      <span className="history-text">
                        {item.report.report_title ?? `Report — ${item.chaos_type}`}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>

        <div className="sidebar-footer">
          <div className="memory-indicator">
            <div className="memory-indicator-title">SESSION MEMORY</div>
            {memoryIndicator ? (
              <>
                <div className="memory-indicator-status">
                  <span className="memory-dot" />
                  {memoryIndicator.backend === 'moorcheh'
                    ? 'Moorcheh Active'
                    : `${memoryIndicator.count} scenarios learned`}
                </div>
                {memoryIndicator.lastScenario ? (
                  <div className="memory-indicator-last">
                    Last: {memoryIndicator.lastScenario.slice(0, 32)}{memoryIndicator.lastScenario.length > 32 ? '…' : ''}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="memory-indicator-status">
                <span className="memory-dot" />
                Supabase Memory
              </div>
            )}
          </div>
        {/* Mobile-only tools in the sidebar */}
        <div className="sidebar-footer mobile-only" style={{ flexDirection: 'column', gap: '8px', padding: '16px', borderTop: '1px solid var(--glass-border)', background: 'rgba(255, 255, 255, 0.02)' }}>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px', wordBreak: 'break-all' }}>
            Active: <span className="text-primary">{headerSandboxId}</span>
          </div>
          <button
            type="button"
            className={`header-action-btn danger ${isApplyingChaos ? 'chaos-loading' : ''} ${isChaosButtonFlashing ? 'chaos-success-flash' : ''}`}
            onClick={handleChaos}
            disabled={!sandbox || isApplyingChaos || isGenerating}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {isApplyingChaos ? 'Injecting...' : 'Inject Chaos'}
          </button>
          
          {isTemplateFormOpen ? (
            <div className="template-inline-form" style={{ flexDirection: 'column', width: '100%' }}>
              <input
                type="text"
                className="template-name-input"
                placeholder="Template name"
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                style={{ width: '100%', marginBottom: '8px' }}
              />
              <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                <button type="button" className="header-inline-btn" onClick={() => void handleConfirmSaveTemplate()} disabled={!templateName.trim() || isSavingTemplate} style={{ flex: 1 }}>Save</button>
                <button type="button" className="header-inline-btn" onClick={() => { setIsTemplateFormOpen(false); setTemplateName(''); }} style={{ flex: 1 }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="header-action-btn" onClick={handleSaveTemplate} disabled={!sandbox || isSavingTemplate || isGenerating} style={{ width: '100%', justifyContent: 'center' }}>
              Save Template
            </button>
          )}

          <button type="button" className="header-action-btn" onClick={handleReset} style={{ width: '100%', justifyContent: 'center' }}>
            Reset Sandbox
          </button>
        </div>

        <div className="sidebar-footer desktop-only">
          <button type="button" className="view-db-btn" disabled>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
            </svg>
            Session Memory Ready
          </button>
        </div>
      </aside>

      <main className={`chat-main ${expiredSandboxMessage && !sandboxData ? 'chat-main-expired' : ''}`}>
        <header className="chat-header glass">
          <div className="chat-header-copy">
            <div className="header-title-row">
              <button
                type="button"
                className="mobile-menu-btn"
                onClick={() => setIsMobileSidebarOpen(true)}
                aria-label="Open menu"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="12" x2="21" y2="12"></line>
                  <line x1="3" y1="6" x2="21" y2="6"></line>
                  <line x1="3" y1="18" x2="21" y2="18"></line>
                </svg>
              </button>
              <h2 className="desktop-only">
                Active Sandbox: <span className="text-secondary">{headerSandboxId}</span>
              </h2>
              <button
                type="button"
                className="header-inline-btn"
                onClick={() => void handleCopyLink()}
                disabled={!sandbox}
              >
                {isCopyLinkSuccess ? 'Copied!' : 'Copy Link'}
              </button>
            </div>
            {sandbox?.expires_at ? (
              <span className={`expiry-indicator ${timeRemaining === 'Expired' ? 'expired' : ''}`}>
                {timeRemaining === 'Expired' ? 'Expired' : `Expires in: ${timeRemaining}`}
              </span>
            ) : null}
            {sandboxData && selectedViewingUser ? (
              <div className="viewing-controls">
                <label className="viewing-label" htmlFor="viewing-user-select">
                  Viewing as:
                </label>
                <select
                  id="viewing-user-select"
                  className="viewing-select"
                  value={selectedViewingUserId}
                  onChange={(event) => setSelectedViewingUserId(event.target.value)}
                >
                  {viewingUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {`${user.name} (${user.role})`}
                    </option>
                  ))}
                </select>
                <span className={`role-badge ${currentPermissionTier}`}>{capitalizeLabel(currentViewingRole)}</span>
                {chaosHighlights && currentPermissionTier !== 'admin' ? (
                  <span className="role-alert-badge">Anomaly detected</span>
                ) : null}
              </div>
            ) : null}
            {chaosIndicator ? <span className="chaos-indicator">{chaosIndicator}</span> : null}
            {statusMessage ? <span className="status-indicator">{statusMessage}</span> : null}
          </div>
          <div className="chat-header-actions desktop-only">
            <button
              type="button"
              className={`header-action-btn danger ${isApplyingChaos ? 'chaos-loading' : ''} ${isChaosButtonFlashing ? 'chaos-success-flash' : ''}`}
              onClick={handleChaos}
              disabled={!sandbox || isApplyingChaos || isGenerating}
            >
              {isApplyingChaos ? 'Injecting...' : 'Chaos'}
            </button>
            {chaosHighlights && sandbox ? (
              <button
                type="button"
                className="header-action-btn qa-report-btn"
                onClick={() => void handleGenerateReport()}
                disabled={isGeneratingReport || !sandbox}
              >
                {isGeneratingReport ? (
                  <>
                    <span className="report-btn-spinner" aria-hidden="true" />
                    Analyzing edge case...
                  </>
                ) : (
                  'Generate QA Report'
                )}
              </button>
            ) : null}
            {isTemplateFormOpen ? (
              <div className="template-inline-form">
                <input
                  type="text"
                  className="template-name-input"
                  placeholder="Template name"
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void handleConfirmSaveTemplate()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setIsTemplateFormOpen(false)
                      setTemplateName('')
                    }
                  }}
                />
                <button
                  type="button"
                  className="header-inline-btn"
                  onClick={() => void handleConfirmSaveTemplate()}
                  disabled={!templateName.trim() || isSavingTemplate}
                >
                  {isSavingTemplate ? 'Saving...' : 'Confirm'}
                </button>
                <button
                  type="button"
                  className="header-inline-btn"
                  onClick={() => {
                    setIsTemplateFormOpen(false)
                    setTemplateName('')
                  }}
                  disabled={isSavingTemplate}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="header-action-btn" onClick={handleSaveTemplate} disabled={!sandbox || isSavingTemplate || isGenerating}>
                Save Template
              </button>
            )}
            <button type="button" className="header-action-btn" onClick={handleReset}>
              Reset
            </button>
          </div>
        </header>

        <div className={`chat-content ${sandboxData || showLoadingWorkspace ? 'chat-content-loaded' : ''}`}>
          {showLoadingWorkspace ? (
            <div className="workspace-panel">
              <div className="workspace-toolbar">
                <div className="metrics-grid">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="metric-card glass metric-card-skeleton">
                      <span className="metric-skeleton-label shimmer" />
                      <strong className="metric-skeleton-value shimmer" />
                    </div>
                  ))}
                </div>
                <div className="tab-row">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <span key={index} className="tab-skeleton-pill shimmer" />
                  ))}
                </div>
              </div>
              <div className="table-shell glass">
                {renderSkeletonTableRows()}
              </div>
            </div>
          ) : sandboxData ? (
            <div className="workspace-panel">
              {errorMessage ? <div className="workspace-alert error">{errorMessage}</div> : null}

              <div className="workspace-toolbar">
                {metrics ? (
                  <div className="metrics-grid">
                    <div className="metric-card glass">
                      <span className="metric-label">{formatMetricLabel(metrics.primary_metric_label)}</span>
                      <strong>{formatMetricValue(metrics.primary_metric)}</strong>
                    </div>
                    <div className="metric-card glass">
                      <span className="metric-label">{`Active ${primaryEntityTabLabel}`}</span>
                      <strong>{metrics.active_records ?? 0}</strong>
                    </div>
                    <div className="metric-card glass">
                      <span className="metric-label">{`${primaryEntityTabLabel} Closed`}</span>
                      <strong>{metrics.closed_records ?? 0}</strong>
                    </div>
                    <div className="metric-card glass">
                      <span className="metric-label">Anomaly Score</span>
                      <strong>{metrics.anomaly_score}</strong>
                    </div>
                  </div>
                ) : null}

                <div className="tab-row">
                  {[
                    { id: 'users' as const, label: 'Users', hidden: false },
                    { id: 'primary_entities' as const, label: primaryEntityTabLabel, hidden: false },
                    { id: 'activity_logs' as const, label: 'Activity Logs', hidden: currentPermissionTier === 'restricted' },
                    { id: 'feature_flags' as const, label: 'Feature Flags', hidden: false },
                    { id: 'endpoint_tester' as const, label: 'Endpoint Tester', hidden: false },
                  ]
                    .filter((tab) => !tab.hidden)
                    .map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.id === 'endpoint_tester' ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="tab-icon">
                          <path d="M10 2v7.31" /><path d="M14 9.3V2" /><path d="M8.5 2h7" /><path d="M14 9.3a6 6 0 1 1-4 11.2" /><path d="M10 9.3a6 6 0 0 0 4 11.2" />
                        </svg>
                      ) : null}
                      <span className="tab-label">{tab.label}</span>
                      {tab.id !== 'endpoint_tester' && tabChangeCounts[tab.id] > 0 ? (
                        <span className="tab-badge">{tabChangeCounts[tab.id]}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>

              {chaosHighlights && !isChaosBannerDismissed && activeTab !== 'endpoint_tester' ? (
                <div className="chaos-banner">
                  <span className="chaos-banner-text">
                    {`${chaosHighlights.chaosSummary} — ${chaosHighlights.totalChanges} changes across ${chaosHighlights.changedTabs} tables`}
                  </span>
                  <button
                    type="button"
                    className="chaos-banner-dismiss"
                    onClick={() => setIsChaosBannerDismissed(true)}
                    aria-label="Dismiss chaos banner"
                  >
                    ×
                  </button>
                </div>
              ) : null}

              {activeTab === 'endpoint_tester' ? (
                <div className="endpoint-tester-panel glass">
                  <div className="endpoint-tester-scroll">
                    <div className="endpoint-tester-header">
                      <h3 className="endpoint-tester-title">ENDPOINT TESTER</h3>
                      <div className="endpoint-tester-divider">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</div>
                    </div>
                    <div className="endpoint-tester-form">
                    <div className="endpoint-form-row">
                      <label className="endpoint-label">Target URL</label>
                      <div className="endpoint-url-row">
                        <input
                          type="url"
                          className="endpoint-input"
                          placeholder="http://localhost:4000/api/your-endpoint"
                          value={endpointTargetUrl}
                          onChange={(e) => setEndpointTargetUrl(e.target.value)}
                          disabled={isRunningEndpointTest}
                        />
                        <button
                          type="button"
                          className="endpoint-btn demo-endpoint"
                          onClick={() => setEndpointTargetUrl('http://localhost:3001/api/mock-endpoint')}
                          disabled={isRunningEndpointTest}
                          title="Use the built-in demo endpoint for realistic mixed results (200s, 400s, 402s, 403s, 500s)"
                        >
                          Use Demo Endpoint
                        </button>
                      </div>
                    </div>
                    <div className="endpoint-form-row endpoint-form-inline">
                      <div className="endpoint-field">
                        <label className="endpoint-label">Method</label>
                        <select
                          className="endpoint-select"
                          value={endpointMethod}
                          onChange={(e) => setEndpointMethod(e.target.value as 'GET' | 'POST' | 'PUT' | 'DELETE')}
                          disabled={isRunningEndpointTest}
                        >
                          <option value="GET">GET</option>
                          <option value="POST">POST</option>
                          <option value="PUT">PUT</option>
                          <option value="DELETE">DELETE</option>
                        </select>
                      </div>
                      <div className="endpoint-field">
                        <label className="endpoint-label">Entity</label>
                        <select
                          className="endpoint-select"
                          value={endpointEntityType}
                          onChange={(e) => setEndpointEntityType(e.target.value as 'users' | 'primary_entities' | 'activity_logs')}
                          disabled={isRunningEndpointTest}
                        >
                          <option value="users">Users</option>
                          <option value="primary_entities">
                            {sandboxData?.schema_info?.primary_entity_name ? capitalizeLabel(sandboxData.schema_info.primary_entity_name) : 'Records'}
                          </option>
                          <option value="activity_logs">Activity Logs</option>
                        </select>
                      </div>
                    </div>
                    <div className="endpoint-form-row endpoint-form-checkbox">
                      <label className="endpoint-checkbox-label">
                        <input
                          type="checkbox"
                          checked={injectChaos}
                          onChange={(e) => setInjectChaos(e.target.checked)}
                          disabled={isRunningEndpointTest}
                        />
                        <span>Inject Chaos — test with edge case data</span>
                      </label>
                    </div>
                    <div className="endpoint-form-actions">
                      <button
                        type="button"
                        className="endpoint-btn primary"
                        onClick={() => void handleRunEndpointTest(false)}
                        disabled={!sandbox || isRunningEndpointTest}
                      >
                        Run Tests
                      </button>
                      <button
                        type="button"
                        className="endpoint-btn chaos-shortcut"
                        onClick={() => void handleRunEndpointTest(true)}
                        disabled={!sandbox || isRunningEndpointTest}
                      >
                        Run with Chaos
                      </button>
                      {endpointLastResponse ? (
                        <button
                          type="button"
                          className="endpoint-btn secondary"
                          onClick={handleDownloadEndpointReport}
                        >
                          Download Report
                        </button>
                      ) : null}
                    </div>
                  </div>
                    {endpointError ? (
                      <div className="endpoint-error">{endpointError}</div>
                    ) : null}
                    <div ref={endpointResultsRef}>
                    {(isRunningEndpointTest || endpointDisplayedResults.length > 0 || endpointLastResponse) ? (
                    <div className="endpoint-live-feed">
                      <div className="endpoint-feed-header">
                        {isRunningEndpointTest ? (
                          <>→ Firing requests at {endpointTargetUrl || '…'}...</>
                        ) : endpointLastResponse ? (
                          <>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</>
                        ) : null}
                      </div>
                      {endpointDisplayedResults.map((r, i) => (
                        <div key={`${r.record_id}-${i}`} className={`endpoint-feed-line ${r.ok ? 'pass' : 'fail'}`}>
                          {r.ok ? '✓' : '✗'} {r.record_id}  {r.status || 'timeout'} {r.status ? (r.ok ? 'OK' : 'Error') : ''}  ({r.duration_ms}ms)
                        </div>
                      ))}
                      {endpointLastResponse && !isRunningEndpointTest && endpointDisplayedResults.length === endpointLastResponse.test_results.length ? (
                        <div className="endpoint-feed-summary">
                          {endpointLastResponse.passed} passed  {endpointLastResponse.failed} failed
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                    {endpointLastResponse && !isRunningEndpointTest ? (
                    <div className="endpoint-report-panel">
                      {(() => {
                        const a = endpointLastResponse.analysis
                        if (!a) return null
                        return (
                          <>
                            {a.summary ? (
                              <section className="endpoint-report-section">
                                <h4 className="endpoint-report-section-title">Summary</h4>
                                <p className="endpoint-report-summary">{a.summary}</p>
                              </section>
                            ) : null}
                            <section className="endpoint-report-section">
                              <h4 className="endpoint-report-section-title">Pass / Fail</h4>
                              <div className="endpoint-stats-bar">
                                <span className="endpoint-stats-pass" style={{ width: `${endpointLastResponse.total ? (endpointLastResponse.passed / endpointLastResponse.total) * 100 : 0}%` }} />
                                <span className="endpoint-stats-fail" style={{ width: `${endpointLastResponse.total ? (endpointLastResponse.failed / endpointLastResponse.total) * 100 : 0}%` }} />
                              </div>
                              <p className="endpoint-stats-text">{endpointLastResponse.passed} passed, {endpointLastResponse.failed} failed (avg {a.avg_response_time_ms ?? 0}ms)</p>
                            </section>
                            {a.findings?.length ? (
                              <section className="endpoint-report-section">
                                <h4 className="endpoint-report-section-title">Findings</h4>
                                <div className="endpoint-findings-list">
                                  {a.findings.map((f, i) => (
                                    <div key={i} className="endpoint-finding-card">
                                      <span className={`endpoint-severity-badge severity-${(f.severity ?? 'info').toLowerCase()}`}>{(f.severity ?? 'info').toUpperCase()}</span>
                                      <strong>{f.title ?? '—'}</strong>
                                      <p>{f.description ?? ''}</p>
                                    </div>
                                  ))}
                                </div>
                              </section>
                            ) : null}
                            {a.test_cases?.length ? (
                              <section className="endpoint-report-section">
                                <h4 className="endpoint-report-section-title">Test Cases</h4>
                                <div className="endpoint-test-cases-list">
                                  {a.test_cases.map((tc, i) => (
                                    <div key={i} className="endpoint-tc-card">
                                      <div className="endpoint-tc-header">
                                        <span className="endpoint-tc-id">{tc.id ?? `TC-${String(i + 1).padStart(3, '0')}`}</span>
                                        <span className={`endpoint-tc-status ${(tc.status ?? 'warning').toLowerCase()}`}>{(tc.status ?? 'warning').toUpperCase()}</span>
                                        <span className="endpoint-tc-priority">{(tc.priority ?? 'medium').toUpperCase()}</span>
                                      </div>
                                      <p className="endpoint-tc-title">{tc.title ?? '—'}</p>
                                      <p className="endpoint-tc-scenario">{tc.scenario ?? '—'}</p>
                                      <p className="endpoint-tc-expected">Expected: {tc.expected_result ?? '—'}</p>
                                      <p className="endpoint-tc-actual">Actual: {tc.actual_result ?? '—'}</p>
                                    </div>
                                  ))}
                                </div>
                              </section>
                            ) : null}
                            {a.recommended_fixes?.length ? (
                              <section className="endpoint-report-section">
                                <h4 className="endpoint-report-section-title">Recommended Fixes</h4>
                                <ol className="endpoint-fixes-list">
                                  {a.recommended_fixes.map((r, i) => (
                                    <li key={i}><strong>{r.priority ?? i + 1}. {r.fix ?? '—'}</strong> {r.rationale ?? ''}</li>
                                  ))}
                                </ol>
                              </section>
                            ) : null}
                            {a.chaos_findings ? (
                              <section className="endpoint-report-section">
                                <h4 className="endpoint-report-section-title">Chaos Findings</h4>
                                <p className="endpoint-chaos-findings">{a.chaos_findings}</p>
                              </section>
                            ) : null}
                          </>
                        )
                      })()}
                    </div>
                    ) : null}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="table-shell glass">
                  <div key={activeTab} className="table-fade-panel">
                    {activeTable}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className={`empty-state ${expiredSandboxMessage ? 'expired-state' : ''}`}>
              <div className="empty-icon glass">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                </svg>
              </div>
              <h2>{expiredSandboxMessage ?? 'What data shall we forge today?'}</h2>
              <p className="workspace-subtitle">
                {expiredSandboxMessage
                  ? 'Generate a fresh sandbox to continue exploring realistic demo and QA environments.'
                  : 'Describe the demo or QA environment you want to generate, then inspect the resulting entities in structured tabs.'}
              </p>
              {errorMessage ? <div className="workspace-alert error compact">{errorMessage}</div> : null}
              {expiredSandboxMessage ? (
                <button type="button" className="new-chat-btn expired-reset-btn" onClick={handleReset}>
                  Create New Sandbox
                </button>
              ) : null}
              <div className="example-grid">
                {examplePrompts.map((prompt, index) => (
                  <button
                    key={index}
                    type="button"
                    className="example-btn glass"
                    onClick={() => setInputText(prompt)}
                  >
                    <span className="example-text">"{prompt}"</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="example-icon">
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                      <polyline points="12 5 19 12 12 19"></polyline>
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="chat-input-container">
          <div className="input-wrapper glass">
            <input
              type="text"
              className="chat-input"
              placeholder="Describe the user data scenario you want to simulate..."
              value={inputText}
              onChange={(event) => setInputText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleSubmit()
                }
              }}
            />
            <button type="button" className="send-btn" disabled={!inputText.trim() || isGenerating} onClick={() => void handleSubmit()}>
              {isGenerating ? (
                <span className="send-spinner" aria-hidden="true" />
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
              )}
            </button>
          </div>
          <p className="input-footer">SceneForge can make mistakes. Verify test data before production simulations.</p>
        </div>
      </main>

      {/* QA Report Modal */}
      {reportModalOpen && reportModalContent && (
        <div className="report-overlay" onClick={() => setReportModalOpen(false)}>
          <div
            className="report-panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-labelledby="report-panel-title"
          >
            <header className="report-panel-header">
              <div className="report-panel-title-row">
                <h2 id="report-panel-title" className="report-panel-title">QA EDGE CASE REPORT</h2>
                <div className="report-panel-actions">
                  <button type="button" className="report-panel-btn download" onClick={handleDownloadReport}>
                    Download Report
                  </button>
                  <button type="button" className="report-panel-btn close" onClick={() => setReportModalOpen(false)}>
                    Close
                  </button>
                </div>
              </div>
              <div className="report-panel-meta">
                <span>Generated: {reportModalContent.generated_at ? new Date(reportModalContent.generated_at).toLocaleString() : '—'}</span>
                <span>Chaos: {reportModalContent.chaos_type ?? '—'}</span>
              </div>
              <div className="report-panel-divider">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</div>
            </header>
            <div className="report-panel-body">
              {reportModalContent.executive_summary ? (
                <section className="report-section">
                  <h3 className="report-section-title">Executive Summary</h3>
                  <p className="report-executive-summary">{reportModalContent.executive_summary}</p>
                </section>
              ) : null}
              {reportModalContent.what_happened && reportModalContent.what_happened.length > 0 ? (
                <section className="report-section">
                  <h3 className="report-section-title">What Happened</h3>
                  <ol className="report-list">
                    {reportModalContent.what_happened.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ol>
                </section>
              ) : null}
              {reportModalContent.vulnerabilities && reportModalContent.vulnerabilities.length > 0 ? (
                <section className="report-section">
                  <h3 className="report-section-title">Vulnerabilities</h3>
                  <div className="report-cards">
                    {reportModalContent.vulnerabilities.map((v, i) => (
                      <div key={i} className="report-card">
                        <span className={`report-severity-badge severity-${(v.severity ?? 'medium').toLowerCase()}`}>
                          {(v.severity ?? 'medium').toUpperCase()}
                        </span>
                        <strong>{v.title ?? '—'}</strong>
                        <p>{v.description ?? ''}</p>
                        {v.affected_component ? <span className="report-affected">Affected: {v.affected_component}</span> : null}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              {reportModalContent.affected_systems && reportModalContent.affected_systems.length > 0 ? (
                <section className="report-section">
                  <h3 className="report-section-title">Affected Systems</h3>
                  <div className="report-cards">
                    {reportModalContent.affected_systems.map((a, i) => (
                      <div key={i} className="report-card">
                        <span className={`report-impact-badge impact-${(a.impact ?? 'medium').toLowerCase()}`}>
                          {(a.impact ?? 'medium').toUpperCase()}
                        </span>
                        <strong>{a.system ?? '—'}</strong>
                        <p>{a.details ?? ''}</p>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              {reportModalContent.test_cases && reportModalContent.test_cases.length > 0 ? (
                <section className="report-section">
                  <h3 className="report-section-title">Test Cases</h3>
                  <div className="report-test-cases">
                    {reportModalContent.test_cases.map((tc, i) => (
                      <div key={i} className="report-test-case">
                        <div className="report-test-case-header">
                          <span className="report-test-case-id">{tc.id ?? `TC-${String(i + 1).padStart(3, '0')}`}</span>
                          <span className={`report-priority-badge priority-${(tc.priority ?? 'medium').toLowerCase()}`}>
                            {(tc.priority ?? 'medium').toUpperCase()}
                          </span>
                        </div>
                        <div className="report-test-case-divider">────────────────</div>
                        <p className="report-test-case-title"><strong>Title:</strong> {tc.title ?? '—'}</p>
                        <p className="report-test-case-scenario"><strong>Scenario:</strong> {tc.scenario ?? '—'}</p>
                        <p className="report-test-case-expected"><strong>Expected:</strong> {tc.expected_result ?? '—'}</p>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              {reportModalContent.recommended_fixes && reportModalContent.recommended_fixes.length > 0 ? (
                <section className="report-section">
                  <h3 className="report-section-title">Recommended Fixes</h3>
                  <ol className="report-fixes-list">
                    {reportModalContent.recommended_fixes.map((r, i) => (
                      <li key={i}>
                        <strong>{r.priority ?? i + 1}. {r.fix ?? '—'}</strong>
                        {r.rationale ? <p>{r.rationale}</p> : null}
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Databases Modal */}
      {isDbModalOpen && (
        <div className="modal-overlay" onClick={() => setIsDbModalOpen(false)}>
          <div className="modal-content glass" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Generated Databases</h3>
              <button className="close-btn" onClick={() => setIsDbModalOpen(false)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <div className="empty-db-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3, marginBottom: '16px' }}>
                  <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
                </svg>
                <p>No databases have been generated yet.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Chatbot
