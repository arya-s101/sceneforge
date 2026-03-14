import React, { useCallback, useEffect, useMemo, useState } from 'react'

import {
  applyChaos,
  deleteSandboxRecord,
  generateFromTemplate,
  generateSandbox,
  getSandbox,
  getSandboxes,
  getTemplates,
  saveTemplate,
  type ActivityLogRecord,
  type PrimaryEntityRecord,
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
type TabId = 'users' | 'primary_entities' | 'activity_logs' | 'feature_flags'
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
type TableRow = Record<string, unknown>
type ViewingRole = UserRecord['role']

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

  const pinnedColumns = PINNED_COLUMNS.filter((key) => discoveredColumns.includes(key))
  const remainingColumns = discoveredColumns.filter((key) => !PINNED_COLUMNS.includes(key))

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
  const currentViewingRole: ViewingRole = selectedViewingUser?.role ?? 'admin'

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
      viewingUsers.find((user) => user.role === 'admin') ??
      viewingUsers[0]

    setSelectedViewingUserId(preferredUser.id)
  }, [selectedViewingUserId, viewingUsers])
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

    const analystPrimaryEntities = currentViewingRole === 'analyst' && selectedViewingUser
      ? sandboxData.primary_entities.filter((entity) =>
          getRelatedUserIdsFromEntity(entity).includes(selectedViewingUser.id),
        )
      : sandboxData.primary_entities
    const allowedPrimaryEntityIds = new Set(analystPrimaryEntities.map((entity) => entity.id))
    const analystActivityLogs = currentViewingRole === 'analyst' && selectedViewingUser
      ? sandboxData.activity_logs.filter(
          (log) =>
            log.user_id === selectedViewingUser.id ||
            allowedPrimaryEntityIds.has(log.primary_entity_id),
        )
      : sandboxData.activity_logs

    if (currentViewingRole === 'viewer' && (activeTab === 'users' || activeTab === 'activity_logs')) {
      return <div className="access-restricted-panel">Access Restricted</div>
    }

    switch (activeTab) {
      case 'users':
        return renderUsersTable(sandboxData.users, Array.from(changedRowIdSet))
      case 'primary_entities':
        return renderPrimaryEntitiesTable(analystPrimaryEntities, Array.from(changedRowIdSet))
      case 'activity_logs':
        return renderActivityLogsTable(analystActivityLogs, Array.from(changedRowIdSet))
      case 'feature_flags':
        return renderFeatureFlagsTable(sandboxData.feature_flags, changedFeatureFlags)
      default:
        return null
    }
  }, [activeTab, changedFeatureFlags, changedRowIdSet, currentViewingRole, sandboxData, selectedViewingUser])

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
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsApplyingChaos(false)
    }
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
      <aside className="chat-sidebar glass">
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
        </div>

        <div className="sidebar-footer">
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
              <h2>
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
                <span className={`role-badge ${currentViewingRole}`}>{capitalizeLabel(currentViewingRole)}</span>
                {chaosHighlights && currentViewingRole !== 'admin' ? (
                  <span className="role-alert-badge">Anomaly detected</span>
                ) : null}
              </div>
            ) : null}
            {chaosIndicator ? <span className="chaos-indicator">{chaosIndicator}</span> : null}
            {statusMessage ? <span className="status-indicator">{statusMessage}</span> : null}
          </div>
          <div className="chat-header-actions">
            <button
              type="button"
              className={`header-action-btn danger ${isApplyingChaos ? 'chaos-loading' : ''} ${isChaosButtonFlashing ? 'chaos-success-flash' : ''}`}
              onClick={handleChaos}
              disabled={!sandbox || isApplyingChaos || isGenerating}
            >
              {isApplyingChaos ? 'Injecting...' : 'Chaos'}
            </button>
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
                    { id: 'users' as const, label: 'Users', hidden: currentViewingRole === 'viewer' },
                    { id: 'primary_entities' as const, label: primaryEntityTabLabel, hidden: false },
                    { id: 'activity_logs' as const, label: 'Activity Logs', hidden: currentViewingRole === 'viewer' },
                    { id: 'feature_flags' as const, label: 'Feature Flags', hidden: false },
                  ]
                    .filter((tab) => !tab.hidden)
                    .map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      <span className="tab-label">{tab.label}</span>
                      {tabChangeCounts[tab.id] > 0 ? (
                        <span className="tab-badge">{tabChangeCounts[tab.id]}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>

              {chaosHighlights && !isChaosBannerDismissed ? (
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

              <div className="table-shell glass">
                <div key={activeTab} className="table-fade-panel">
                  {activeTable}
                </div>
              </div>
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
