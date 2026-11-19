import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import {
  buildWorkflowSnapshot,
  normalizeBranchName,
  normalizeWorkflowJobs,
  pickPreferredGitHubRemote,
  type RawWorkflowJob,
  type RawWorkflowRun
} from './github'
import type { SnapshotResponse, WorkflowJob, WorkflowSnapshot } from './protocol'

const execFileAsync = promisify(execFile)

const SNAPSHOT_STORAGE_KEY = 'workflows:snapshot'
const DEFAULT_POLL_INTERVAL_SECONDS = 60
const ACTIVE_POLL_INTERVAL_SECONDS = 15
const STALE_AFTER_MS = 20_000
const REPO_FETCH_CONCURRENCY = 5
const REFRESH_HARD_TIMEOUT_MS = 25_000

const REPO_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function resolveBinary(envVar: string, candidates: string[]): string {
  const fromEnv = process.env[envVar]
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  for (const candidate of candidates) {
    if (!candidate.includes('/') || existsSync(candidate)) {
      return candidate
    }
  }
  return candidates[candidates.length - 1]
}

const GH_BIN = resolveBinary('GH_PATH', ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', 'gh'])
const GIT_BIN = resolveBinary('GIT_PATH', ['/opt/homebrew/bin/git', '/usr/bin/git', '/usr/local/bin/git', 'git'])

interface PluginSettings {
  pollIntervalSeconds: number
  runsPerRepo: number
  includeHiddenProjects: boolean
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

async function readSettings(orca: OrcaWorkerApi): Promise<PluginSettings> {
  try {
    const raw = await orca.settings.get()
    return {
      pollIntervalSeconds: clampInt(raw.pollIntervalSeconds, DEFAULT_POLL_INTERVAL_SECONDS, 15, 600),
      runsPerRepo: clampInt(raw.runsPerRepo, 10, 3, 25),
      includeHiddenProjects: raw.includeHiddenProjects === true
    }
  } catch {
    return {
      pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
      runsPerRepo: 10,
      includeHiddenProjects: false
    }
  }
}

async function readCachedSnapshot(orca: OrcaWorkerApi): Promise<WorkflowSnapshot | null> {
  try {
    const stored = await orca.storage.get(SNAPSHOT_STORAGE_KEY)
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      return stored as unknown as WorkflowSnapshot
    }
  } catch {
    // Ignore unreadable cache
  }
  return null
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const current = nextIndex++
      if (current >= items.length) return
      results[current] = await fn(items[current])
    }
  }

  const count = Math.min(concurrency, Math.max(1, items.length))
  await Promise.all(Array.from({ length: count }, () => worker()))
  return results
}

function classifyGhError(err: unknown): { kind: 'missing_gh' | 'unauthenticated' | 'timeout' | 'other'; message: string } {
  const e = err as { code?: string | number; killed?: boolean; signal?: string; stderr?: string; message?: string }
  if (e.code === 'ENOENT') {
    return {
      kind: 'missing_gh',
      message: 'GitHub CLI (gh) hittades inte på datorn. Installera gh och kör "gh auth login".'
    }
  }
  if (e.killed || e.signal === 'SIGKILL' || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
    return {
      kind: 'timeout',
      message: 'Tidsgränsen överskreds vid anrop mot GitHub CLI (gh).'
    }
  }
  const detail = `${e.stderr ?? ''}\n${e.message ?? ''}`.trim()
  const lower = detail.toLowerCase()
  if (
    lower.includes('gh auth login') ||
    lower.includes('not logged into any github hosts') ||
    lower.includes('authentication') ||
    lower.includes('http 401') ||
    lower.includes('bad credentials')
  ) {
    return {
      kind: 'unauthenticated',
      message: 'GitHub CLI (gh) är inte inloggad. Kör "gh auth login" i en terminal.'
    }
  }
  const firstLine = (e.stderr?.trim() || e.message || 'Okänt fel från GitHub CLI').split('\n')[0]
  return { kind: 'other', message: firstLine }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
    }, ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

async function resolveGitHubRepoForPath(repoPath: string): Promise<string | null> {
  if (!repoPath || !existsSync(repoPath)) return null
  try {
    const { stdout } = await execFileAsync(GIT_BIN, ['-C', repoPath, 'remote', '-v'], {
      cwd: tmpdir(),
      timeout: 4_000,
      killSignal: 'SIGKILL',
      maxBuffer: 512 * 1024
    })
    return pickPreferredGitHubRemote(stdout)
  } catch {
    return null
  }
}

async function fetchRunsForRepo(
  repoFullName: string,
  runsPerRepo: number
): Promise<{ runs: RawWorkflowRun[]; error: string | null; authIssue?: 'missing_gh' | 'unauthenticated'; authMessage?: string }> {
  try {
    const { stdout } = await execFileAsync(
      GH_BIN,
      ['api', `repos/${repoFullName}/actions/runs?per_page=${runsPerRepo}`],
      {
        cwd: tmpdir(),
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024
      }
    )
    const parsed = JSON.parse(stdout) as { workflow_runs?: RawWorkflowRun[] }
    return {
      runs: Array.isArray(parsed.workflow_runs) ? parsed.workflow_runs : [],
      error: null
    }
  } catch (err) {
    const classified = classifyGhError(err)
    if (classified.kind === 'missing_gh' || classified.kind === 'unauthenticated') {
      return {
        runs: [],
        error: classified.message,
        authIssue: classified.kind,
        authMessage: classified.message
      }
    }
    return {
      runs: [],
      error: classified.message
    }
  }
}

async function updateStatusBar(orca: OrcaWorkerApi, snapshot: WorkflowSnapshot | null): Promise<void> {
  if (!orca.host.has('statusBar.update')) return

  try {
    if (!snapshot) {
      await orca.host.call('statusBar.update', {
        id: 'workflows-status',
        text: 'Workflows',
        icon: 'layers',
        tone: 'neutral',
        tooltip: 'GitHub Workflows — Hämtar status...'
      })
      return
    }

    if (snapshot.authStatus === 'missing_gh' || snapshot.authStatus === 'unauthenticated') {
      await orca.host.call('statusBar.update', {
        id: 'workflows-status',
        text: 'Workflows',
        icon: 'layers',
        tone: 'neutral',
        tooltip: `GitHub Workflows — ${snapshot.authError ?? 'Logga in med gh auth login för att se workflows'}`
      })
      return
    }

    const { running, queued, currentFailing, repos } = snapshot.counts
    const activeRepos = snapshot.repos
      .filter((r) => r.runningCount + r.queuedCount > 0)
      .map((r) => r.projectName)
    const failingRepos = snapshot.repos.filter((r) => r.failedCount > 0).map((r) => r.projectName)

    const lines = [
      `GitHub Workflows — Pågående: ${running} · Köade: ${queued} · Misslyckade: ${currentFailing} · Repon: ${repos}`
    ]
    if (activeRepos.length > 0) {
      lines.push(`Aktiva: ${activeRepos.join(', ')}`)
    }
    if (failingRepos.length > 0) {
      lines.push(`Misslyckade: ${failingRepos.join(', ')}`)
    }

    await orca.host.call('statusBar.update', {
      id: 'workflows-status',
      text: 'Workflows',
      icon: 'layers',
      tone: 'neutral',
      tooltip: lines.join('\n')
    })
  } catch (err) {
    orca.log(`statusBar.update failed: ${String(err)}`)
  }
}

let activeCleanup: (() => void) | null = null

export default function activate(orca: OrcaWorkerApi): void {
  activeCleanup?.()

  let disposed = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let inFlightRefresh: Promise<{ snapshot: WorkflowSnapshot; error: string | null }> | null = null
  let lastSnapshot: WorkflowSnapshot | null = null
  let lastError: string | null = null
  let sequence = 0

  function nextSeq(): number {
    sequence += 1
    return sequence
  }

  function safePostUpdate(payload: SnapshotResponse): void {
    try {
      orca.panels.post('workflows.updated', payload)
    } catch (err) {
      orca.log(`panels.post failed: ${String(err)}`)
    }
  }

  function clearTimers(): void {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  async function scheduleNextPoll(snapshot: WorkflowSnapshot | null): Promise<void> {
    if (disposed) return
    if (pollTimer) clearTimeout(pollTimer)
    const settings = await readSettings(orca)
    if (disposed) return

    const hasActive = Boolean(snapshot && snapshot.counts.running + snapshot.counts.queued > 0)
    const intervalSec = hasActive
      ? Math.min(settings.pollIntervalSeconds, ACTIVE_POLL_INTERVAL_SECONDS)
      : settings.pollIntervalSeconds

    pollTimer = setTimeout(() => {
      void refreshSnapshot()
    }, intervalSec * 1000)
    pollTimer.unref?.()
  }

  function scheduleDebouncedRefresh(delayMs = 500): void {
    if (disposed) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void refreshSnapshot()
    }, delayMs)
    debounceTimer.unref?.()
  }

  async function collectSnapshot(): Promise<WorkflowSnapshot> {
    const settings = await readSettings(orca)
    const [projectsRes, workspacesRes, contextRes] = await Promise.all([
      orca.host.call('project.list').catch((err) => {
        orca.log(`project.list failed: ${String(err)}`)
        return { projects: [], truncated: false }
      }),
      orca.host.call('workspace.list').catch((err) => {
        orca.log(`workspace.list failed: ${String(err)}`)
        return { workspaces: [], truncated: false }
      }),
      orca.host.call('workspace.readContext').catch(() => null)
    ])

    const workspaces = workspacesRes.workspaces ?? []
    const focusedWorkspaceId = contextRes?.workspaceId ?? null
    const focusedWorkspace = focusedWorkspaceId ? workspaces.find((w) => w.id === focusedWorkspaceId) : null
    const focusedProjectId = focusedWorkspace?.projectId ?? null
    const focusedBranch = normalizeBranchName(contextRes?.branch)

    const branchesByProject = new Map<string, Set<string>>()
    for (const ws of workspaces) {
      if (!ws.projectId) continue
      const branch = normalizeBranchName(ws.branch)
      if (!branch) continue
      let set = branchesByProject.get(ws.projectId)
      if (!set) {
        set = new Set<string>()
        branchesByProject.set(ws.projectId, set)
      }
      set.add(branch)
    }

    const gitProjects = (projectsRes.projects ?? []).filter(
      (p) => p.kind === 'git' && (settings.includeHiddenProjects || !p.hidden)
    )

    const resolvedRepos = await mapWithConcurrency(gitProjects, REPO_FETCH_CONCURRENCY, async (project) => {
      const repoFullName = await resolveGitHubRepoForPath(project.path)
      return repoFullName ? { project, repoFullName } : null
    })

    const dedupedByFullName = new Map<
      string,
      {
        projectId: string
        projectName: string
        repoFullName: string
        path: string
        openBranches: Set<string>
        isFocused: boolean
      }
    >()

    for (const item of resolvedRepos) {
      if (!item) continue
      const key = item.repoFullName.toLowerCase()
      const branches = branchesByProject.get(item.project.id) ?? new Set<string>()
      const isFocused = item.project.id === focusedProjectId
      const existing = dedupedByFullName.get(key)
      if (existing) {
        for (const b of branches) existing.openBranches.add(b)
        if (isFocused) existing.isFocused = true
      } else {
        dedupedByFullName.set(key, {
          projectId: item.project.id,
          projectName: item.project.name,
          repoFullName: item.repoFullName,
          path: item.project.path,
          openBranches: new Set(branches),
          isFocused
        })
      }
    }

    let authStatus: 'ok' | 'unauthenticated' | 'missing_gh' = 'ok'
    let authError: string | null = null

    const repoTargets = Array.from(dedupedByFullName.values())
    const fetchedRepos = await mapWithConcurrency(repoTargets, REPO_FETCH_CONCURRENCY, async (target) => {
      const fetched = await fetchRunsForRepo(target.repoFullName, settings.runsPerRepo)
      if (fetched.authIssue && authStatus === 'ok') {
        authStatus = fetched.authIssue
        authError = fetched.authMessage ?? fetched.error
      }
      return {
        projectId: target.projectId,
        projectName: target.projectName,
        repoFullName: target.repoFullName,
        path: target.path,
        openBranches: Array.from(target.openBranches).sort((a, b) => a.localeCompare(b)),
        isFocused: target.isFocused,
        rawRuns: fetched.runs,
        error: fetched.authIssue ? null : fetched.error
      }
    })

    return buildWorkflowSnapshot({
      repoInputs: fetchedRepos,
      focusedProjectId,
      focusedBranch,
      authStatus,
      authError
    })
  }

  async function refreshSnapshot(): Promise<{ snapshot: WorkflowSnapshot; error: string | null }> {
    if (inFlightRefresh) return inFlightRefresh

    const task = (async () => {
      const cached = lastSnapshot ?? (await readCachedSnapshot(orca))
      safePostUpdate({
        snapshot: cached,
        refreshing: true,
        sequence: nextSeq(),
        error: null
      })

      try {
        const snapshot = await withTimeout(
          collectSnapshot(),
          REFRESH_HARD_TIMEOUT_MS,
          'Hämtningen av workflows tog för lång tid. Försök igen.'
        )

        lastSnapshot = snapshot
        lastError = null
        await orca.storage.set(SNAPSHOT_STORAGE_KEY, snapshot as unknown as JsonValue).catch((err) => {
          orca.log(`storage.set failed: ${String(err)}`)
        })
        await updateStatusBar(orca, snapshot)
        safePostUpdate({
          snapshot,
          refreshing: false,
          sequence: nextSeq(),
          error: null
        })
        await scheduleNextPoll(snapshot)
        return { snapshot, error: null }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        orca.log(`Refresh failed: ${message}`)
        lastError = message
        const fallback =
          cached ??
          buildWorkflowSnapshot({
            repoInputs: [],
            focusedProjectId: null,
            focusedBranch: null,
            authStatus: 'ok',
            authError: null
          })
        await updateStatusBar(orca, fallback)
        safePostUpdate({
          snapshot: fallback,
          refreshing: false,
          sequence: nextSeq(),
          error: message
        })
        await scheduleNextPoll(fallback)
        return { snapshot: fallback, error: message }
      } finally {
        inFlightRefresh = null
      }
    })()

    inFlightRefresh = task
    return task
  }

  orca.panels.handle('workflows.get', async (): Promise<SnapshotResponse> => {
    const cached = lastSnapshot ?? (await readCachedSnapshot(orca))
    if (cached) lastSnapshot = cached
    const isStale = !cached || Date.now() - cached.fetchedAt > STALE_AFTER_MS
    if (isStale && !inFlightRefresh) {
      void refreshSnapshot()
    }
    return {
      snapshot: cached,
      refreshing: Boolean(inFlightRefresh),
      sequence,
      error: lastError
    }
  })

  orca.panels.handle('workflows.refresh', async (): Promise<SnapshotResponse> => {
    const { snapshot, error } = await refreshSnapshot()
    return {
      snapshot,
      refreshing: false,
      sequence,
      error
    }
  })

  orca.panels.handle('workflows.jobs', async ({ repoFullName, runId }): Promise<{ jobs: WorkflowJob[]; error?: string | null }> => {
    if (!REPO_NAME_RE.test(repoFullName) || !Number.isInteger(runId) || runId <= 0) {
      return { jobs: [], error: 'Ogiltigt repo eller runId.' }
    }
    try {
      const { stdout } = await execFileAsync(
        GH_BIN,
        ['api', `repos/${repoFullName}/actions/runs/${runId}/jobs?per_page=50`],
        {
          cwd: tmpdir(),
          timeout: 12_000,
          killSignal: 'SIGKILL',
          maxBuffer: 4 * 1024 * 1024
        }
      )
      const parsed = JSON.parse(stdout) as { jobs?: RawWorkflowJob[] }
      const jobs = normalizeWorkflowJobs(Array.isArray(parsed.jobs) ? parsed.jobs : [])
      return { jobs, error: null }
    } catch (err) {
      const { message } = classifyGhError(err)
      orca.log(`workflows.jobs failed (${repoFullName}#${runId}): ${message}`)
      return { jobs: [], error: message }
    }
  })

  orca.panels.handle('workflows.rerun', async ({ repoFullName, runId, failedOnly }) => {
    if (!REPO_NAME_RE.test(repoFullName) || !Number.isInteger(runId) || runId <= 0) {
      return { ok: false, error: 'Ogiltigt repo eller runId.' }
    }
    try {
      const args = ['run', 'rerun', String(runId), '--repo', repoFullName]
      if (failedOnly) args.push('--failed')
      await execFileAsync(GH_BIN, args, {
        cwd: tmpdir(),
        timeout: 12_000,
        killSignal: 'SIGKILL'
      })
      scheduleDebouncedRefresh(1200)
      return { ok: true }
    } catch (err) {
      const { message } = classifyGhError(err)
      orca.log(`workflows.rerun failed (${repoFullName}#${runId}): ${message}`)
      return { ok: false, error: message }
    }
  })

  orca.panels.handle('workflows.cancel', async ({ repoFullName, runId }) => {
    if (!REPO_NAME_RE.test(repoFullName) || !Number.isInteger(runId) || runId <= 0) {
      return { ok: false, error: 'Ogiltigt repo eller runId.' }
    }
    try {
      await execFileAsync(GH_BIN, ['run', 'cancel', String(runId), '--repo', repoFullName], {
        cwd: tmpdir(),
        timeout: 12_000,
        killSignal: 'SIGKILL'
      })
      scheduleDebouncedRefresh(1200)
      return { ok: true }
    } catch (err) {
      const { message } = classifyGhError(err)
      orca.log(`workflows.cancel failed (${repoFullName}#${runId}): ${message}`)
      return { ok: false, error: message }
    }
  })

  const workspaceCreatedSub = orca.events.on('workspace.created', () => {
    scheduleDebouncedRefresh(600)
  })
  const workspaceRemovedSub = orca.events.on('workspace.removed', () => {
    scheduleDebouncedRefresh(600)
  })
  const workspaceChangedSub = orca.events.on('workspace.changed', async (payload) => {
    if (!lastSnapshot) return
    const nextBranch = normalizeBranchName(payload.context?.branch)
    if (nextBranch !== lastSnapshot.focusedBranch) {
      lastSnapshot = { ...lastSnapshot, focusedBranch: nextBranch }
      safePostUpdate({
        snapshot: lastSnapshot,
        refreshing: Boolean(inFlightRefresh),
        sequence: nextSeq(),
        error: lastError
      })
    }
  })
  const settingsSub = orca.settings.onDidChange(() => {
    scheduleDebouncedRefresh(300)
  })

  activeCleanup = () => {
    disposed = true
    clearTimers()
    workspaceCreatedSub.dispose()
    workspaceRemovedSub.dispose()
    workspaceChangedSub.dispose()
    settingsSub.dispose()
  }

  void (async () => {
    const cached = await readCachedSnapshot(orca)
    if (disposed) return
    if (cached) {
      lastSnapshot = cached
      await updateStatusBar(orca, cached)
    }
    const isStale = !cached || Date.now() - cached.fetchedAt > STALE_AFTER_MS
    if (isStale) {
      pollTimer = setTimeout(() => {
        void refreshSnapshot()
      }, 250)
      pollTimer.unref?.()
    } else {
      await scheduleNextPoll(cached)
    }
  })()
}

export function deactivate(): void {
  activeCleanup?.()
  activeCleanup = null
}
