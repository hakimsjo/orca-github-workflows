import type {
  RepoSummary,
  WorkflowJob,
  WorkflowJobStep,
  WorkflowOrgOption,
  WorkflowRun,
  WorkflowSnapshot,
  WorkflowStatusCategory
} from './protocol'

export interface RawWorkflowRun {
  id: number
  name?: string | null
  display_title?: string | null
  run_number?: number | null
  run_attempt?: number | null
  status?: string | null
  conclusion?: string | null
  head_branch?: string | null
  event?: string | null
  html_url?: string | null
  created_at?: string | null
  updated_at?: string | null
  run_started_at?: string | null
  actor?: { login?: string | null } | null
}

export interface RawWorkflowJobStep {
  number?: number | null
  name?: string | null
  status?: string | null
  conclusion?: string | null
}

export interface RawWorkflowJob {
  id: number
  name?: string | null
  status?: string | null
  conclusion?: string | null
  started_at?: string | null
  completed_at?: string | null
  html_url?: string | null
  steps?: RawWorkflowJobStep[] | null
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])
const CANCELLED_CONCLUSIONS = new Set(['cancelled', 'skipped', 'stale', 'neutral'])
const QUEUED_STATUSES = new Set(['queued', 'waiting', 'requested', 'pending'])

export function parseGitHubRemote(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  const match = trimmed.match(/github\.com[:/]([^/\s]+)\/([^/\s]+)$/i)
  if (!match) return null
  return `${match[1]}/${match[2]}`
}

export function pickPreferredGitHubRemote(remoteOutput: string): string | null {
  const remotes = new Map<string, string>()
  for (const line of remoteOutput.split('\n')) {
    const match = line.trim().match(/^(\S+)\s+(\S+)(?:\s+\((fetch|push)\))?$/)
    if (!match) continue
    const [, name, url, kind] = match
    if (kind === 'push' && remotes.has(name)) continue
    const parsed = parseGitHubRemote(url)
    if (parsed && !remotes.has(name)) {
      remotes.set(name, parsed)
    }
  }
  if (remotes.has('origin')) return remotes.get('origin') ?? null
  if (remotes.has('upstream')) return remotes.get('upstream') ?? null
  for (const value of remotes.values()) {
    return value
  }
  return null
}

export function normalizeBranchName(branch: string | null | undefined): string | null {
  if (!branch) return null
  const trimmed = branch.trim()
  if (!trimmed) return null
  return trimmed.replace(/^refs\/heads\//, '')
}

export function classifyRunStatus(status: string | null | undefined, conclusion: string | null | undefined): WorkflowStatusCategory {
  const normalizedStatus = (status ?? '').toLowerCase()
  const normalizedConclusion = (conclusion ?? '').toLowerCase()

  if (normalizedStatus === 'in_progress') return 'running'
  if (QUEUED_STATUSES.has(normalizedStatus)) return 'queued'
  if (normalizedStatus === 'completed') {
    if (FAILED_CONCLUSIONS.has(normalizedConclusion)) return 'failed'
    if (normalizedConclusion === 'success') return 'success'
    if (CANCELLED_CONCLUSIONS.has(normalizedConclusion)) return 'cancelled'
    return 'other'
  }
  return 'other'
}

export function parseTimestampMs(iso: string | null | undefined): number {
  if (!iso) return 0
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}

export function normalizeWorkflowRun(
  raw: RawWorkflowRun,
  repo: { projectId: string; projectName: string; repoFullName: string; openBranches: string[] }
): WorkflowRun {
  const status = raw.status ?? 'unknown'
  const conclusion = raw.conclusion ?? null
  const category = classifyRunStatus(status, conclusion)
  const branch = normalizeBranchName(raw.head_branch)
  const openBranchSet = new Set(repo.openBranches.map((b) => normalizeBranchName(b)).filter(Boolean))
  const createdAt = raw.created_at ?? new Date(0).toISOString()
  const updatedAt = raw.updated_at ?? createdAt
  const runStartedAtMs = raw.run_started_at ? parseTimestampMs(raw.run_started_at) || null : null

  const rawTitle = raw.display_title?.trim() || raw.name?.trim() || `Körning #${raw.run_number ?? raw.id}`
  const displayTitle = rawTitle.length > 140 ? `${rawTitle.slice(0, 137)}...` : rawTitle

  return {
    id: raw.id,
    repoFullName: repo.repoFullName,
    projectName: repo.projectName,
    projectId: repo.projectId,
    name: raw.name?.trim() || 'Workflow',
    displayTitle,
    runNumber: raw.run_number ?? 0,
    runAttempt: raw.run_attempt ?? 1,
    status,
    conclusion,
    category,
    branch,
    event: raw.event ?? 'push',
    actor: raw.actor?.login ?? null,
    htmlUrl: raw.html_url ?? `https://github.com/${repo.repoFullName}/actions/runs/${raw.id}`,
    createdAt,
    createdAtMs: parseTimestampMs(createdAt),
    updatedAt,
    updatedAtMs: parseTimestampMs(updatedAt),
    runStartedAtMs,
    matchesOpenBranch: branch ? openBranchSet.has(branch) : false,
    isLatestForKey: false
  }
}

export function normalizeWorkflowJobs(rawJobs: RawWorkflowJob[]): WorkflowJob[] {
  return rawJobs.map((job) => {
    const status = job.status ?? 'unknown'
    const conclusion = job.conclusion ?? null
    const steps: WorkflowJobStep[] = (job.steps ?? []).map((step, index) => ({
      number: step.number ?? index + 1,
      name: step.name?.trim() || `Steg ${index + 1}`,
      status: step.status ?? 'unknown',
      conclusion: step.conclusion ?? null,
      category: classifyRunStatus(step.status, step.conclusion)
    }))

    return {
      id: job.id,
      name: job.name?.trim() || 'Jobb',
      status,
      conclusion,
      category: classifyRunStatus(status, conclusion),
      startedAtMs: job.started_at ? parseTimestampMs(job.started_at) || null : null,
      completedAtMs: job.completed_at ? parseTimestampMs(job.completed_at) || null : null,
      htmlUrl: job.html_url ?? null,
      steps
    }
  })
}

const CATEGORY_PRIORITY: Record<WorkflowStatusCategory, number> = {
  running: 0,
  queued: 1,
  failed: 2,
  other: 3,
  cancelled: 4,
  success: 5
}

export function buildWorkflowSnapshot(params: {
  repoInputs: {
    projectId: string
    projectName: string
    repoFullName: string
    path: string
    openBranches: string[]
    isFocused: boolean
    rawRuns: RawWorkflowRun[]
    error: string | null
  }[]
  focusedProjectId: string | null
  focusedBranch: string | null
  selectedOrgId?: string
  availableOrgs?: WorkflowOrgOption[]
  authStatus: 'ok' | 'unauthenticated' | 'missing_gh'
  authError: string | null
  fetchedAt?: number
}): WorkflowSnapshot {
  const allRuns: WorkflowRun[] = []
  const repos: RepoSummary[] = []

  for (const input of params.repoInputs) {
    const runs = input.rawRuns.map((raw) =>
      normalizeWorkflowRun(raw, {
        projectId: input.projectId,
        projectName: input.projectName,
        repoFullName: input.repoFullName,
        openBranches: input.openBranches
      })
    )

    // Mark the newest run per (workflow name, branch) so we know whether a failure is still current.
    const sortedByRecency = [...runs].sort((a, b) => b.createdAtMs - a.createdAtMs || b.id - a.id)
    const seenKeys = new Set<string>()
    for (const run of sortedByRecency) {
      const key = `${run.name}\0${run.branch ?? ''}`
      if (!seenKeys.has(key)) {
        seenKeys.add(key)
        run.isLatestForKey = true
      }
    }

    allRuns.push(...runs)

    const runningCount = runs.filter((r) => r.category === 'running').length
    const queuedCount = runs.filter((r) => r.category === 'queued').length
    const failedCount = runs.filter((r) => r.category === 'failed' && r.isLatestForKey).length
    const latestRun = sortedByRecency[0] ?? null

    repos.push({
      projectId: input.projectId,
      projectName: input.projectName,
      repoFullName: input.repoFullName,
      path: input.path,
      openBranches: input.openBranches,
      isFocused: input.isFocused,
      runningCount,
      queuedCount,
      failedCount,
      latestRun,
      error: input.error
    })
  }

  allRuns.sort((a, b) => {
    const prioDiff = CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category]
    if (prioDiff !== 0) return prioDiff
    return b.updatedAtMs - a.updatedAtMs || b.id - a.id
  })

  repos.sort((a, b) => {
    if (a.isFocused !== b.isFocused) return a.isFocused ? -1 : 1
    const aActive = a.runningCount + a.queuedCount
    const bActive = b.runningCount + b.queuedCount
    if (aActive !== bActive) return bActive - aActive
    if (a.failedCount !== b.failedCount) return b.failedCount - a.failedCount
    return a.projectName.localeCompare(b.projectName, 'sv')
  })

  const counts = {
    repos: repos.length,
    running: allRuns.filter((r) => r.category === 'running').length,
    queued: allRuns.filter((r) => r.category === 'queued').length,
    failed: allRuns.filter((r) => r.category === 'failed').length,
    currentFailing: allRuns.filter((r) => r.category === 'failed' && r.isLatestForKey).length,
    success: allRuns.filter((r) => r.category === 'success').length
  }

  return {
    repos,
    runs: allRuns,
    focusedProjectId: params.focusedProjectId,
    focusedBranch: params.focusedBranch,
    selectedOrgId: params.selectedOrgId ?? 'open',
    availableOrgs: params.availableOrgs ?? [{ id: 'open', label: 'Öppna repon i Orca', kind: 'open' }],
    authStatus: params.authStatus,
    authError: params.authError,
    fetchedAt: params.fetchedAt ?? Date.now(),
    counts
  }
}

export function isActiveOrFailingRun(run: WorkflowRun): boolean {
  if (run.category === 'running' || run.category === 'queued') return true
  if (run.category === 'failed' && run.isLatestForKey) return true
  return false
}

export function extractRepoOwner(repoFullName: string): string {
  const slash = repoFullName.indexOf('/')
  return slash > 0 ? repoFullName.slice(0, slash) : repoFullName
}

export function extractAvailableOwners(repos: readonly RepoSummary[]): string[] {
  const seen = new Map<string, string>()
  for (const repo of repos) {
    const owner = extractRepoOwner(repo.repoFullName)
    const key = owner.toLowerCase()
    if (!seen.has(key)) {
      seen.set(key, owner)
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, 'sv'))
}

export function filterSnapshotByOwner(snapshot: WorkflowSnapshot, selectedOrg: string): WorkflowSnapshot {
  if (!selectedOrg || selectedOrg === 'all') return snapshot
  const target = selectedOrg.toLowerCase()
  const repos = snapshot.repos.filter((r) => extractRepoOwner(r.repoFullName).toLowerCase() === target)
  const runs = snapshot.runs.filter((r) => extractRepoOwner(r.repoFullName).toLowerCase() === target)

  return {
    ...snapshot,
    repos,
    runs,
    counts: {
      repos: repos.length,
      running: runs.filter((r) => r.category === 'running').length,
      queued: runs.filter((r) => r.category === 'queued').length,
      failed: runs.filter((r) => r.category === 'failed').length,
      currentFailing: runs.filter((r) => r.category === 'failed' && r.isLatestForKey).length,
      success: runs.filter((r) => r.category === 'success').length
    }
  }
}
