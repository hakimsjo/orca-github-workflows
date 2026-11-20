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

type ExecOptions = { cwd: string; timeout: number; killSignal: 'SIGKILL'; maxBuffer?: number }
type ExecFn = (file: string, args: string[], options: ExecOptions) => Promise<{ stdout: string; stderr: string }>

const defaultExec: ExecFn = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, { ...options, encoding: 'utf8' })
  return { stdout, stderr }
}

let exec: ExecFn = defaultExec

/** Test seam: replaces how the worker runs `gh` and `git`. Pass null to restore the default. */
export function setExecForTests(fn: ExecFn | null): void {
  exec = fn ?? defaultExec
}

const SNAPSHOT_STORAGE_KEY = 'workflows:snapshot'
const DEFAULT_POLL_INTERVAL_SECONDS = 60
const ACTIVE_POLL_INTERVAL_SECONDS = 15
const STALE_AFTER_MS = 20_000
const REPO_FETCH_CONCURRENCY = 5
const REFRESH_HARD_TIMEOUT_MS = 25_000
const MIN_EVENT_REFRESH_GAP_MS = 10_000
const RATE_LIMIT_BACKOFF_BASE_MS = 60_000
const RATE_LIMIT_BACKOFF_MAX_MS = 8 * 60_000

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

type GhErrorKind = 'missing_gh' | 'unauthenticated' | 'timeout' | 'rate_limited' | 'other'

export class RateLimitError extends Error {
  readonly retryAt: number | null
  constructor(retryAt: number | null) {
    super('GitHub rate limit')
    this.retryAt = retryAt
  }
}

/** Parses `gh api -i` header block. Returns epoch ms when GitHub says we may retry, or null. */
export function parseRetryAt(headerText: string | undefined, now = Date.now()): number | null {
  if (!headerText) return null
  const headers = new Map<string, string>()
  for (const line of headerText.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim())
  }
  const retryAfter = Number(headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000
  const reset = Number(headers.get('x-ratelimit-reset'))
  if (headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0) return reset * 1000
  return null
}

/**
 * When the pause after a rate limit ends: GitHub's own retry time when it gave one, otherwise
 * exponential backoff (1, 2, 4, 8 min, then 8 min) from the number of earlier consecutive hits.
 */
export function computeRateLimitPauseUntil(strikes: number, retryAt: number | null, now = Date.now()): number {
  if (retryAt !== null && retryAt > now) return retryAt
  return now + Math.min(RATE_LIMIT_BACKOFF_BASE_MS * 2 ** strikes, RATE_LIMIT_BACKOFF_MAX_MS)
}

export function splitIncludeOutput(stdout: string): { headers: string; body: string } {
  const match = stdout.match(/\r?\n\r?\n/)
  if (!stdout.startsWith('HTTP/') || !match || match.index === undefined) return { headers: '', body: stdout }
  return { headers: stdout.slice(0, match.index), body: stdout.slice(match.index + match[0].length) }
}

export function classifyGhError(err: unknown): { kind: GhErrorKind; message: string } {
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
    lower.includes('rate limit') ||
    lower.includes('http 429') ||
    lower.includes('too many requests') ||
    lower.includes('abuse')
  ) {
    return {
      kind: 'rate_limited',
      message: 'GitHub begränsar antalet anrop (rate limit).'
    }
  }
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
    const { stdout } = await exec(GIT_BIN, ['-C', repoPath, 'remote', '-v'], {
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
    const { stdout } = await exec(
      GH_BIN,
      // -i so that rate-limit headers (retry-after, x-ratelimit-*) are visible on failure
      ['api', '-i', `repos/${repoFullName}/actions/runs?per_page=${runsPerRepo}`],
      {
        cwd: tmpdir(),
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024
      }
    )
    const parsed = JSON.parse(splitIncludeOutput(stdout).body) as { workflow_runs?: RawWorkflowRun[] }
    return {
      runs: Array.isArray(parsed.workflow_runs) ? parsed.workflow_runs : [],
      error: null
    }
  } catch (err) {
    const classified = classifyGhError(err)
    if (classified.kind === 'rate_limited') {
      const stdout = (err as { stdout?: string }).stdout
      throw new RateLimitError(parseRetryAt(splitIncludeOutput(stdout ?? '').headers))
    }
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
  let rateLimitedUntil = 0
  let rateLimitStrikes = 0
  let lastRefreshStartedAt = 0
  const workerId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

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

    const delayMs = Math.max(intervalSec * 1000, rateLimitedUntil - Date.now())
    pollTimer = setTimeout(() => {
      void refreshSnapshot()
    }, delayMs)
    pollTimer.unref?.()
  }

  function rateLimitMessage(): string {
    const hhmm = new Date(rateLimitedUntil).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
    return `GitHub begränsar anrop, försöker igen kl. ${hhmm}.`
  }

  /** Starts (or extends) the pause after GitHub rate-limited us and returns the message to show. */
  function enterRateLimitPause(retryAt: number | null): string {
    rateLimitedUntil = Math.max(rateLimitedUntil, computeRateLimitPauseUntil(rateLimitStrikes, retryAt))
    rateLimitStrikes += 1
    lastError = rateLimitMessage()
    return lastError
  }

  function isPaused(): boolean {
    return Date.now() < rateLimitedUntil
  }

  /** For panel actions that call GitHub: the pause message while paused, else null. */
  function pausedError(): string | null {
    return isPaused() ? rateLimitMessage() : null
  }

  function emptySnapshot(): WorkflowSnapshot {
    return buildWorkflowSnapshot({
      repoInputs: [],
      focusedProjectId: null,
      focusedBranch: null,
      authStatus: 'ok',
      authError: null
    })
  }

  function scheduleDebouncedRefresh(delayMs = 500): void {
    if (disposed) return
    if (debounceTimer) clearTimeout(debounceTimer)
    // Event-triggered refreshes never fire closer than MIN_EVENT_REFRESH_GAP_MS apart, nor during a rate limit.
    const earliest = Math.max(lastRefreshStartedAt + MIN_EVENT_REFRESH_GAP_MS, rateLimitedUntil)
    delayMs = Math.max(delayMs, earliest - Date.now())
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
    let rateLimited = false
    const fetchedRepos = await mapWithConcurrency(repoTargets, REPO_FETCH_CONCURRENCY, async (target) => {
      // Stop issuing requests for the remaining repos once one hit the rate limit.
      if (rateLimited) throw new RateLimitError(null)
      const fetched = await fetchRunsForRepo(target.repoFullName, settings.runsPerRepo).catch((err) => {
        if (err instanceof RateLimitError) rateLimited = true
        throw err
      })
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
    if (isPaused()) {
      // Paused: serve the last good snapshot without touching GitHub.
      const snapshot = lastSnapshot ?? (await readCachedSnapshot(orca)) ?? emptySnapshot()
      return { snapshot, error: lastError }
    }
    lastRefreshStartedAt = Date.now()

    const task = (async () => {
      const cached = lastSnapshot ?? (await readCachedSnapshot(orca))
      safePostUpdate({
        refreshing: true,
        workerId,
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
        rateLimitStrikes = 0
        rateLimitedUntil = 0
        await orca.storage.set(SNAPSHOT_STORAGE_KEY, snapshot as unknown as JsonValue).catch((err) => {
          orca.log(`storage.set failed: ${String(err)}`)
        })
        await updateStatusBar(orca, snapshot)
        safePostUpdate({
          snapshot,
          refreshing: false,
          workerId,
          sequence: nextSeq(),
          error: null
        })
        await scheduleNextPoll(snapshot)
        return { snapshot, error: null }
      } catch (err) {
        let message = err instanceof Error ? err.message : String(err)
        if (err instanceof RateLimitError) {
          message = enterRateLimitPause(err.retryAt)
        }
        orca.log(`Refresh failed: ${message}`)
        lastError = message
        const fallback = cached ?? emptySnapshot()
        await updateStatusBar(orca, fallback)
        safePostUpdate({
          snapshot: fallback,
          refreshing: false,
          workerId,
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
      workerId,
      sequence,
      error: lastError
    }
  })

  orca.panels.handle('workflows.refresh', async (): Promise<SnapshotResponse> => {
    const { snapshot, error } = await refreshSnapshot()
    return {
      snapshot,
      refreshing: false,
      workerId,
      sequence,
      error
    }
  })

  orca.panels.handle('workflows.jobs', async ({ repoFullName, runId }): Promise<{ jobs: WorkflowJob[]; error?: string | null }> => {
    if (!REPO_NAME_RE.test(repoFullName) || !Number.isInteger(runId) || runId <= 0) {
      return { jobs: [], error: 'Ogiltigt repo eller runId.' }
    }
    const paused = pausedError()
    if (paused) return { jobs: [], error: paused }
    try {
      const { stdout } = await exec(
        GH_BIN,
        ['api', '-i', `repos/${repoFullName}/actions/runs/${runId}/jobs?per_page=50`],
        {
          cwd: tmpdir(),
          timeout: 12_000,
          killSignal: 'SIGKILL',
          maxBuffer: 4 * 1024 * 1024
        }
      )
      const parsed = JSON.parse(splitIncludeOutput(stdout).body) as { jobs?: RawWorkflowJob[] }
      const jobs = normalizeWorkflowJobs(Array.isArray(parsed.jobs) ? parsed.jobs : [])
      return { jobs, error: null }
    } catch (err) {
      const classified = classifyGhError(err)
      const message =
        classified.kind === 'rate_limited'
          ? enterRateLimitPause(parseRetryAt(splitIncludeOutput((err as { stdout?: string }).stdout ?? '').headers))
          : classified.message
      orca.log(`workflows.jobs failed (${repoFullName}#${runId}): ${message}`)
      return { jobs: [], error: message }
    }
  })

  orca.panels.handle('workflows.rerun', async ({ repoFullName, runId, failedOnly }) => {
    if (!REPO_NAME_RE.test(repoFullName) || !Number.isInteger(runId) || runId <= 0) {
      return { ok: false, error: 'Ogiltigt repo eller runId.' }
    }
    const paused = pausedError()
    if (paused) return { ok: false, error: paused }
    try {
      const args = ['run', 'rerun', String(runId), '--repo', repoFullName]
      if (failedOnly) args.push('--failed')
      await exec(GH_BIN, args, {
        cwd: tmpdir(),
        timeout: 12_000,
        killSignal: 'SIGKILL'
      })
      scheduleDebouncedRefresh(1200)
      return { ok: true }
    } catch (err) {
      const classified = classifyGhError(err)
      const message = classified.kind === 'rate_limited' ? enterRateLimitPause(null) : classified.message
      orca.log(`workflows.rerun failed (${repoFullName}#${runId}): ${message}`)
      return { ok: false, error: message }
    }
  })

  orca.panels.handle('workflows.cancel', async ({ repoFullName, runId }) => {
    if (!REPO_NAME_RE.test(repoFullName) || !Number.isInteger(runId) || runId <= 0) {
      return { ok: false, error: 'Ogiltigt repo eller runId.' }
    }
    const paused = pausedError()
    if (paused) return { ok: false, error: paused }
    try {
      await exec(GH_BIN, ['run', 'cancel', String(runId), '--repo', repoFullName], {
        cwd: tmpdir(),
        timeout: 12_000,
        killSignal: 'SIGKILL'
      })
      scheduleDebouncedRefresh(1200)
      return { ok: true }
    } catch (err) {
      const classified = classifyGhError(err)
      const message = classified.kind === 'rate_limited' ? enterRateLimitPause(null) : classified.message
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
        workerId,
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
