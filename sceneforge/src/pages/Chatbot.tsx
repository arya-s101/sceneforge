import React, { useCallback, useEffect, useMemo, useState } from 'react'

import {
  applyChaos,
  generateSandbox,
  getSandbox,
  saveTemplate,
  type ActivityLogRecord,
  type SandboxResponse,
  type TransactionRecord,
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
const tabs = [
  { id: 'users', label: 'Users' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'activity_logs', label: 'Activity Logs' },
  { id: 'feature_flags', label: 'Feature Flags' },
] as const

type TabId = (typeof tabs)[number]['id']
type LoadedSandboxData = NonNullable<SandboxResponse['data']>
type ChaosHighlights = {
  chaosSummary: string
  userChanges: number
  transactionChanges: number
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

const PREVIOUS_PROMPTS_STORAGE_KEY = 'sceneforge_prompts'

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

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (value === null || value === undefined) {
    return '—'
  }

  return JSON.stringify(value)
}

function createChaosHighlights(
  userChanges: number,
  transactionChanges: number,
  activityLogChanges: number,
  featureFlagChanges: number,
  chaosSummary: string,
): ChaosHighlights {
  const counts = [userChanges, transactionChanges, activityLogChanges, featureFlagChanges]

  return {
    chaosSummary,
    userChanges,
    transactionChanges,
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

function normalizeStoredPrompt(item: unknown, index: number): PreviousPromptItem | null {
  if (typeof item === 'string' && item.trim()) {
    return {
      prompt: item.trim(),
      sandbox_id: '',
      timestamp: Date.now() - index,
    }
  }

  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>
    const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
    if (!prompt) {
      return null
    }

    return {
      prompt,
      sandbox_id: typeof record.sandbox_id === 'string' ? record.sandbox_id.trim() : '',
      timestamp:
        typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
          ? record.timestamp
          : Date.now() - index,
    }
  }

  return null
}

function readStoredPrompts(): PreviousPromptItem[] {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const raw = window.localStorage.getItem(PREVIOUS_PROMPTS_STORAGE_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw) as unknown
    const normalized = Array.isArray(parsed)
      ? parsed
          .map((item, index) => normalizeStoredPrompt(item, index))
          .filter((item): item is PreviousPromptItem => item !== null)
      : []

    window.localStorage.setItem(PREVIOUS_PROMPTS_STORAGE_KEY, JSON.stringify(normalized))
    return normalized
  } catch {
    return []
  }
}

function savePromptToStorage(prompt: string, sandboxId: string): PreviousPromptItem[] {
  if (typeof window === 'undefined') {
    return [{ prompt, sandbox_id: sandboxId, timestamp: Date.now() }]
  }

  try {
    const existing = readStoredPrompts().filter((item) => item.sandbox_id !== sandboxId)
    const nextPrompts: PreviousPromptItem[] = [
      {
        prompt,
        sandbox_id: sandboxId,
        timestamp: Date.now(),
      },
      ...existing,
    ]
    const limitedPrompts = nextPrompts.slice(0, 20)
    window.localStorage.setItem(PREVIOUS_PROMPTS_STORAGE_KEY, JSON.stringify(limitedPrompts))

    return limitedPrompts
  } catch {
    const fallbackPrompts: PreviousPromptItem[] = [
      {
        prompt,
        sandbox_id: sandboxId,
        timestamp: Date.now(),
      },
    ]
    window.localStorage.setItem(PREVIOUS_PROMPTS_STORAGE_KEY, JSON.stringify(fallbackPrompts))
    return fallbackPrompts
  }
}

function renderUsersTable(users: UserRecord[], changedIds: string[]) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Name</th>
          <th>Email</th>
          <th>Role</th>
          <th>Status</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {users.map((user, index) => (
          <tr key={`${user.id}-${index}`} className={changedIds.includes(user.id) ? 'changed-row' : undefined}>
            <td>{user.id}</td>
            <td>{user.name}</td>
            <td>{user.email}</td>
            <td>{user.role}</td>
            <td>{user.status}</td>
            <td>{formatDate(user.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function renderTransactionsTable(transactions: TransactionRecord[], changedIds: string[]) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>User ID</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Type</th>
          <th>Created</th>
          <th>Metadata</th>
        </tr>
      </thead>
      <tbody>
        {transactions.map((transaction, index) => (
          <tr
            key={`${transaction.id}-${index}`}
            className={changedIds.includes(transaction.id) ? 'changed-row' : undefined}
          >
            <td>{transaction.id}</td>
            <td>{transaction.user_id}</td>
            <td>${transaction.amount.toFixed(2)}</td>
            <td>{transaction.status}</td>
            <td>{transaction.type}</td>
            <td>{formatDate(transaction.created_at)}</td>
            <td>{formatValue(transaction.metadata)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function renderActivityLogsTable(activityLogs: ActivityLogRecord[], changedIds: string[]) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>User ID</th>
          <th>Transaction ID</th>
          <th>Action</th>
          <th>Timestamp</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        {activityLogs.map((log, index) => (
          <tr key={`${log.id}-${index}`} className={changedIds.includes(log.id) ? 'changed-row' : undefined}>
            <td>{log.id}</td>
            <td>{log.user_id}</td>
            <td>{log.transaction_id}</td>
            <td>{log.action}</td>
            <td>{formatDate(log.timestamp)}</td>
            <td>{log.details}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function renderFeatureFlagsTable(featureFlags: Record<string, boolean>, changedFlags: string[]) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Flag</th>
          <th>Enabled</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(featureFlags).map(([flag, enabled], index) => (
          <tr key={`${flag}-${index}`} className={changedFlags.includes(flag) ? 'changed-row' : undefined}>
            <td>{flag}</td>
            <td>{enabled ? 'true' : 'false'}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [chaosIndicator, setChaosIndicator] = useState<string | null>(null)
  const [expiredSandboxMessage, setExpiredSandboxMessage] = useState<string | null>(null)
  const [chaosHighlights, setChaosHighlights] = useState<ChaosHighlights | null>(null)
  const [changedRowIds, setChangedRowIds] = useState<string[]>([])
  const [changedFeatureFlags, setChangedFeatureFlags] = useState<string[]>([])

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
    setPreviousPrompts(readStoredPrompts())
  }, [])

  const restoreSandbox = useCallback(
    async (sandboxId: string, promptText?: string) => {
      setIsHydratingSandbox(true)
      setErrorMessage(null)
      setExpiredSandboxMessage(null)

      try {
        const restoredSandbox = await getSandbox(sandboxId)
        setSandbox(restoredSandbox)
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
  const sandboxData = useMemo<LoadedSandboxData | null>(() => {
    if (!sandbox?.data) {
      return null
    }

    return {
      users: Array.isArray(sandbox.data.users) ? sandbox.data.users : [],
      transactions: Array.isArray(sandbox.data.transactions) ? sandbox.data.transactions : [],
      activity_logs: Array.isArray(sandbox.data.activity_logs) ? sandbox.data.activity_logs : [],
      feature_flags:
        sandbox.data.feature_flags && typeof sandbox.data.feature_flags === 'object'
          ? sandbox.data.feature_flags
          : {},
      dashboard_metrics: sandbox.data.dashboard_metrics,
    }
  }, [sandbox])
  const metrics = sandboxData?.dashboard_metrics
  const changedRowIdSet = useMemo(() => new Set(changedRowIds), [changedRowIds])
  const tabChangeCounts = useMemo(
    () => ({
      users: chaosHighlights?.userChanges ?? 0,
      transactions: chaosHighlights?.transactionChanges ?? 0,
      activity_logs: chaosHighlights?.activityLogChanges ?? 0,
      feature_flags: chaosHighlights?.featureFlagChanges ?? 0,
    }),
    [chaosHighlights],
  )

  const activeTable = useMemo(() => {
    if (!sandboxData) {
      return null
    }

    switch (activeTab) {
      case 'users':
        return renderUsersTable(sandboxData.users, Array.from(changedRowIdSet))
      case 'transactions':
        return renderTransactionsTable(sandboxData.transactions, Array.from(changedRowIdSet))
      case 'activity_logs':
        return renderActivityLogsTable(sandboxData.activity_logs, Array.from(changedRowIdSet))
      case 'feature_flags':
        return renderFeatureFlagsTable(sandboxData.feature_flags, changedFeatureFlags)
      default:
        return null
    }
  }, [activeTab, changedFeatureFlags, changedRowIdSet, sandboxData])

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

    try {
      const result = await generateSandbox(description)
      setSandbox(result)
      setActiveTab('users')
      setPreviousPrompts(savePromptToStorage(description, result.sandbox_id))
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
      const changedTransactions = result.data.transactions.filter((row) => changedIdSet.has(row.id)).length
      const changedActivityLogs = result.data.activity_logs.filter((row) => changedIdSet.has(row.id)).length
      const nextHighlights = createChaosHighlights(
        changedUsers,
        changedTransactions,
        changedActivityLogs,
        0,
        result.chaos_summary,
      )
      setSandbox(result)
      setChaosHighlights(nextHighlights)
      setChangedRowIds(highlightIds)
      setChangedFeatureFlags([])
      setChaosIndicator(result.chaos_summary)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsApplyingChaos(false)
    }
  }

  async function handleSaveTemplate() {
    if (!sandbox || isSavingTemplate) {
      return
    }

    const name = window.prompt('Template name')
    if (!name?.trim()) {
      return
    }

    setIsSavingTemplate(true)
    setErrorMessage(null)

    try {
      const result = await saveTemplate(sandbox.sandbox_id, name.trim())
      setStatusMessage(`Template saved: ${result.template_id}`)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsSavingTemplate(false)
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
            {previousPrompts.length === 0 ? (
              <li className="history-empty">Generated prompts will appear here.</li>
            ) : (
              previousPrompts.map((prompt, index) => (
                <li key={`${prompt.sandbox_id || prompt.prompt}-${index}`} className="history-item">
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
                </li>
              ))
            )}
          </ul>
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

      <main className="chat-main">
        <header className="chat-header glass">
          <div className="chat-header-copy">
            <h2>
              Active Sandbox: <span className="text-secondary">{headerSandboxId}</span>
            </h2>
            {chaosIndicator ? <span className="chaos-indicator">{chaosIndicator}</span> : null}
            {statusMessage ? <span className="status-indicator">{statusMessage}</span> : null}
          </div>
          <div className="chat-header-actions">
            <button type="button" className="header-action-btn danger" onClick={handleChaos} disabled={!sandbox || isApplyingChaos || isGenerating}>
              {isApplyingChaos ? 'Injecting...' : 'Chaos'}
            </button>
            <button type="button" className="header-action-btn" onClick={handleSaveTemplate} disabled={!sandbox || isSavingTemplate || isGenerating}>
              {isSavingTemplate ? 'Saving...' : 'Save Template'}
            </button>
            <button type="button" className="header-action-btn" onClick={handleReset}>
              Reset
            </button>
          </div>
        </header>

        <div className={`chat-content ${sandboxData ? 'chat-content-loaded' : ''}`}>
          {isGenerating || isHydratingSandbox ? (
            <div className="empty-state">
              <div className="empty-icon glass loading-spin">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                </svg>
              </div>
              <h2>{isHydratingSandbox ? 'Restoring sandbox...' : 'Forging your sandbox...'}</h2>
              <p className="workspace-subtitle">
                {isHydratingSandbox
                  ? 'Loading saved sandbox data from the shareable URL.'
                  : 'Generating coherent users, transactions, activity logs, and flags from your prompt.'}
              </p>
            </div>
          ) : sandboxData ? (
            <div className="workspace-panel">
              {errorMessage ? <div className="workspace-alert error">{errorMessage}</div> : null}

              <div className="workspace-toolbar">
                {metrics ? (
                  <div className="metrics-grid">
                    <div className="metric-card glass">
                      <span className="metric-label">Total Revenue</span>
                      <strong>${metrics.total_revenue.toFixed(2)}</strong>
                    </div>
                    <div className="metric-card glass">
                      <span className="metric-label">Active Users</span>
                      <strong>{metrics.active_users}</strong>
                    </div>
                    <div className="metric-card glass">
                      <span className="metric-label">Failed Transactions</span>
                      <strong>{metrics.failed_transactions}</strong>
                    </div>
                    <div className="metric-card glass">
                      <span className="metric-label">Anomaly Score</span>
                      <strong>{metrics.anomaly_score}</strong>
                    </div>
                  </div>
                ) : null}

                <div className="tab-row">
                  {tabs.map((tab) => (
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

              {chaosHighlights ? (
                <div className="chaos-banner">
                  {`${chaosHighlights.chaosSummary} — ${chaosHighlights.totalChanges} changes across ${chaosHighlights.changedTabs} tables`}
                </div>
              ) : null}

              <div className="table-shell glass">{activeTable}</div>
            </div>
          ) : (
            <div className="empty-state">
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
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
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
