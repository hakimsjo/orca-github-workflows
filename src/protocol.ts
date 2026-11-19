// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

export type WorkflowStatusCategory = 'running' | 'queued' | 'failed' | 'success' | 'cancelled' | 'other'

export interface WorkflowRun {
  id: number
  repoFullName: string
  projectName: string
  projectId: string
  name: string
  displayTitle: string
  runNumber: number
  runAttempt: number
  status: string
  conclusion: string | null
  category: WorkflowStatusCategory
  branch: string | null
  event: string
  actor: string | null
  htmlUrl: string
  createdAt: string
  createdAtMs: number
  updatedAt: string
  updatedAtMs: number
  runStartedAtMs: number | null
  matchesOpenBranch: boolean
  isLatestForKey: boolean
}

export interface RepoSummary {
  projectId: string
  projectName: string
  repoFullName: string
  path: string
  openBranches: string[]
  isFocused: boolean
  runningCount: number
  queuedCount: number
  failedCount: number
  latestRun: WorkflowRun | null
  error: string | null
}

export interface WorkflowCounts {
  repos: number
  running: number
  queued: number
  failed: number
  currentFailing: number
  success: number
}

export interface WorkflowSnapshot {
  repos: RepoSummary[]
  runs: WorkflowRun[]
  focusedProjectId: string | null
  focusedBranch: string | null
  authStatus: 'ok' | 'unauthenticated' | 'missing_gh'
  authError: string | null
  fetchedAt: number
  counts: WorkflowCounts
}

export interface WorkflowJobStep {
  number: number
  name: string
  status: string
  conclusion: string | null
  category: WorkflowStatusCategory
}

export interface WorkflowJob {
  id: number
  name: string
  status: string
  conclusion: string | null
  category: WorkflowStatusCategory
  startedAtMs: number | null
  completedAtMs: number | null
  htmlUrl: string | null
  steps: WorkflowJobStep[]
}

export interface SnapshotResponse {
  snapshot?: WorkflowSnapshot | null
  refreshing: boolean
  workerId?: string
  sequence?: number
  error?: string | null
}

declare module 'orca' {
  interface PluginRequests {
    'workflows.get': { output: SnapshotResponse }
    'workflows.refresh': { output: SnapshotResponse }
    'workflows.jobs': {
      input: { repoFullName: string; runId: number }
      output: { jobs: WorkflowJob[]; error?: string | null }
    }
    'workflows.rerun': {
      input: { repoFullName: string; runId: number; failedOnly?: boolean }
      output: { ok: boolean; error?: string }
    }
    'workflows.cancel': { input: { repoFullName: string; runId: number }; output: { ok: boolean; error?: string } }
  }
  interface PluginPanelEvents {
    'workflows.updated': SnapshotResponse
  }
}
