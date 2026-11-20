import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { JsonValue } from 'orca/worker'
import {
  buildWorkflowSnapshot,
  classifyRunStatus,
  isActiveOrFailingRun,
  normalizeWorkflowJobs,
  parseGitHubRemote,
  pickPreferredGitHubRemote
} from './github'
import * as main from './worker'
import { classifyGhError, computeRateLimitPauseUntil, parseRetryAt, setExecForTests, splitIncludeOutput } from './worker'

test('parseGitHubRemote handles HTTPS, SSH and .github repo names', () => {
  assert.equal(parseGitHubRemote('https://github.com/systembydesign/qvitta.git'), 'systembydesign/qvitta')
  assert.equal(parseGitHubRemote('git@github.com:systembydesign/qvitta.git'), 'systembydesign/qvitta')
  assert.equal(parseGitHubRemote('ssh://git@github.com/hakimsjo/orca-github-workflows'), 'hakimsjo/orca-github-workflows')
  assert.equal(parseGitHubRemote('https://github.com/systembydesign/.github.git'), 'systembydesign/.github')
  assert.equal(parseGitHubRemote('https://gitlab.com/org/repo.git'), null)
})

test('pickPreferredGitHubRemote prefers origin over upstream and other remotes', () => {
  const output = [
    'upstream\tgit@github.com:org/base.git (fetch)',
    'upstream\tgit@github.com:org/base.git (push)',
    'origin\thttps://github.com/fork/app.git (fetch)',
    'origin\thttps://github.com/fork/app.git (push)'
  ].join('\n')
  assert.equal(pickPreferredGitHubRemote(output), 'fork/app')
})

test('classifyRunStatus maps GitHub statuses and conclusions accurately', () => {
  assert.equal(classifyRunStatus('in_progress', null), 'running')
  assert.equal(classifyRunStatus('queued', null), 'queued')
  assert.equal(classifyRunStatus('waiting', null), 'queued')
  assert.equal(classifyRunStatus('completed', 'failure'), 'failed')
  assert.equal(classifyRunStatus('completed', 'timed_out'), 'failed')
  assert.equal(classifyRunStatus('completed', 'success'), 'success')
  assert.equal(classifyRunStatus('completed', 'cancelled'), 'cancelled')
})

test('buildWorkflowSnapshot marks latest failure vs superseded failure', () => {
  const now = Date.now()
  const snapshot = buildWorkflowSnapshot({
    repoInputs: [
      {
        projectId: 'p1',
        projectName: 'qvitta',
        repoFullName: 'systembydesign/qvitta',
        path: '/repos/qvitta',
        openBranches: ['main'],
        isFocused: true,
        error: null,
        rawRuns: [
          // Newer CI run on main succeeded -> supersedes older CI failure on main
          {
            id: 2,
            name: 'CI',
            display_title: 'fix ci',
            run_number: 20,
            status: 'completed',
            conclusion: 'success',
            head_branch: 'main',
            created_at: new Date(now - 60_000).toISOString(),
            updated_at: new Date(now - 30_000).toISOString()
          },
          {
            id: 1,
            name: 'CI',
            display_title: 'broken commit',
            run_number: 19,
            status: 'completed',
            conclusion: 'failure',
            head_branch: 'main',
            created_at: new Date(now - 180_000).toISOString(),
            updated_at: new Date(now - 150_000).toISOString()
          },
          // Deploy on main is still latest and failed
          {
            id: 3,
            name: 'Deploy',
            display_title: 'deploy',
            run_number: 5,
            status: 'completed',
            conclusion: 'failure',
            head_branch: 'main',
            created_at: new Date(now - 120_000).toISOString(),
            updated_at: new Date(now - 100_000).toISOString()
          },
          // Running workflow on feature branch
          {
            id: 4,
            name: 'CI',
            display_title: 'wip',
            run_number: 21,
            status: 'in_progress',
            conclusion: null,
            head_branch: 'feat/test',
            created_at: new Date(now - 20_000).toISOString(),
            updated_at: new Date(now - 5_000).toISOString()
          }
        ]
      }
    ],
    focusedProjectId: 'p1',
    focusedBranch: 'main',
    authStatus: 'ok',
    authError: null,
    fetchedAt: now
  })

  assert.equal(snapshot.counts.running, 1)
  assert.equal(snapshot.counts.currentFailing, 1)
  assert.equal(snapshot.counts.failed, 2)
  assert.equal(snapshot.runs[0].id, 4) // running comes first

  const activeOrFailingIds = snapshot.runs.filter(isActiveOrFailingRun).map((r) => r.id)
  assert.deepEqual(activeOrFailingIds, [4, 3])
  assert.equal(snapshot.runs.find((r) => r.id === 2)?.matchesOpenBranch, true)
  assert.equal(snapshot.runs.find((r) => r.id === 4)?.matchesOpenBranch, false)
})

test('normalizeWorkflowJobs extracts job and step status categories', () => {
  const jobs = normalizeWorkflowJobs([
    {
      id: 55,
      name: 'test',
      status: 'completed',
      conclusion: 'failure',
      steps: [
        { number: 1, name: 'Checkout', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Run tests', status: 'completed', conclusion: 'failure' }
      ]
    }
  ])
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].category, 'failed')
  assert.equal(jobs[0].steps[1].category, 'failed')
})

test('worker serves fresh cached snapshot and updates focusedBranch on workspace.changed', async () => {
  const now = Date.now()
  const cached = buildWorkflowSnapshot({
    repoInputs: [],
    focusedProjectId: null,
    focusedBranch: 'main',
    authStatus: 'ok',
    authError: null,
    fetchedAt: now
  })

  const host = mockHost({
    storage: {
      'workflows:snapshot': cached as unknown as JsonValue
    }
  })

  const worker = await mountWorker(main, { host })
  const res = await worker.request('workflows.get')
  assert.equal(res.refreshing, false)
  assert.equal(res.snapshot?.focusedBranch, 'main')

  await worker.emit('workspace.changed', {
    context: {
      workspaceId: 'ws-1',
      branch: 'refs/heads/feat/new',
      displayName: 'feat/new',
      terminals: []
    }
  })
  assert.equal(worker.posts.length, 1)
  assert.equal(worker.posts[0].event, 'workflows.updated')
  assert.equal((worker.posts[0].payload as { snapshot?: { focusedBranch?: string } }).snapshot?.focusedBranch, 'feat/new')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('worker returns structured errors on invalid repo/runId for jobs, rerun and cancel', async () => {
  const host = mockHost({
    storage: {
      'workflows:snapshot': buildWorkflowSnapshot({
        repoInputs: [],
        focusedProjectId: null,
        focusedBranch: null,
        authStatus: 'ok',
        authError: null,
        fetchedAt: Date.now()
      }) as unknown as JsonValue
    }
  })

  const worker = await mountWorker(main, { host })
  const jobsRes = await worker.request('workflows.jobs', { repoFullName: 'invalid repo', runId: 1 })
  assert.deepEqual(jobsRes, { jobs: [], error: 'Ogiltigt repo eller runId.' })

  const rerunRes = await worker.request('workflows.rerun', { repoFullName: 'invalid', runId: 1 })
  assert.deepEqual(rerunRes, { ok: false, error: 'Ogiltigt repo eller runId.' })

  const cancelRes = await worker.request('workflows.cancel', { repoFullName: 'owner/repo', runId: -5 })
  assert.deepEqual(cancelRes, { ok: false, error: 'Ogiltigt repo eller runId.' })

  await worker.deactivate()
})

test('worker keeps status bar neutral with label Workflows and summary tooltip', async () => {
  const now = Date.now()
  const cached = buildWorkflowSnapshot({
    repoInputs: [
      {
        projectId: 'p1',
        projectName: 'qvitta-homepage',
        repoFullName: 'systembydesign/qvitta-homepage',
        path: '/repos/qvitta-homepage',
        openBranches: ['main'],
        isFocused: true,
        error: null,
        rawRuns: [
          {
            id: 1,
            name: 'Deploy',
            status: 'completed',
            conclusion: 'failure',
            head_branch: 'main',
            created_at: new Date(now - 60_000).toISOString(),
            updated_at: new Date(now - 30_000).toISOString()
          }
        ]
      }
    ],
    focusedProjectId: 'p1',
    focusedBranch: 'main',
    authStatus: 'ok',
    authError: null,
    fetchedAt: now
  })

  const host = mockHost({
    storage: {
      'workflows:snapshot': cached as unknown as JsonValue
    }
  })

  const worker = await mountWorker(main, { host })
  // Allow startup hydration microtask to run statusBar.update
  await new Promise((r) => setTimeout(r, 20))

  const statusCalls = host.callsOf('statusBar.update') as {
    id: string
    text?: string
    tone?: string
    tooltip?: string
  }[]
  assert.ok(statusCalls.length >= 1)
  const lastCall = statusCalls[statusCalls.length - 1]
  assert.equal(lastCall.text, 'Workflows')
  assert.equal(lastCall.tone, 'neutral')
  assert.match(lastCall.tooltip ?? '', /Misslyckade: 1/)
  assert.match(lastCall.tooltip ?? '', /qvitta-homepage/)

  await worker.deactivate()
})

// ---------- Rate limiting (issue #1) ----------

const SECONDARY_403 =
  'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. If you reach out to GitHub Support for help, please include the request ID ABCD:1234. (HTTP 403)'
const PRIMARY_403 = 'gh: API rate limit exceeded for user ID 1234567. (HTTP 403)'
const TOO_MANY_429 = 'gh: Too Many Requests (HTTP 429)'
const ABUSE_403 =
  'gh: You have triggered an abuse detection mechanism. Please wait a few minutes before you try again. (HTTP 403)'

function ghFailure(stderr: string, stdout = ''): Error {
  return Object.assign(new Error(`Command failed: gh\n${stderr}`), { code: 1, stderr: `${stderr}\n`, stdout })
}

test('classifyGhError recognizes primary, secondary, 429 and abuse rate limits', () => {
  for (const stderr of [SECONDARY_403, PRIMARY_403, TOO_MANY_429, ABUSE_403]) {
    assert.equal(classifyGhError(ghFailure(stderr)).kind, 'rate_limited', stderr)
  }
  assert.equal(classifyGhError(ghFailure('gh: Bad credentials (HTTP 401)')).kind, 'unauthenticated')
  assert.equal(classifyGhError(ghFailure('gh: Not Found (HTTP 404)')).kind, 'other')
  assert.equal(classifyGhError({ code: 'ENOENT' }).kind, 'missing_gh')
})

test('computeRateLimitPauseUntil backs off 1, 2, 4, 8 min and caps at 8 min', () => {
  const now = 1_000_000
  const minutes = [0, 1, 2, 3, 4, 10].map((strikes) => (computeRateLimitPauseUntil(strikes, null, now) - now) / 60_000)
  assert.deepEqual(minutes, [1, 2, 4, 8, 8, 8])
})

test('computeRateLimitPauseUntil honors a future retry time from GitHub over the backoff', () => {
  const now = 1_000_000
  assert.equal(computeRateLimitPauseUntil(0, now + 300_000, now), now + 300_000)
  assert.equal(computeRateLimitPauseUntil(3, now + 30_000, now), now + 30_000)
  // A retry time already in the past falls back to backoff
  assert.equal(computeRateLimitPauseUntil(1, now - 5_000, now), now + 120_000)
})

test('parseRetryAt reads retry-after, then x-ratelimit-reset when the quota is spent', () => {
  const now = 1_700_000_000_000
  assert.equal(parseRetryAt('HTTP/2.0 403 Forbidden\r\nRetry-After: 120\r\nX-Ratelimit-Remaining: 4000', now), now + 120_000)
  assert.equal(
    parseRetryAt('HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 1700000600', now),
    1_700_000_600_000
  )
  assert.equal(parseRetryAt('HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 12\nX-Ratelimit-Reset: 1700000600', now), null)
  assert.equal(parseRetryAt('', now), null)
})

test('splitIncludeOutput separates gh api -i headers from the JSON body', () => {
  const out = splitIncludeOutput('HTTP/2.0 200 OK\r\nEtag: "abc"\r\n\r\n{"workflow_runs":[]}')
  assert.match(out.headers, /Etag/)
  assert.equal(out.body, '{"workflow_runs":[]}')
  assert.deepEqual(splitIncludeOutput('{"a":1}'), { headers: '', body: '{"a":1}' })
})

type GhCall = string[]

function rateLimitHost(cachedRuns: number) {
  const now = Date.now()
  const cached = buildWorkflowSnapshot({
    repoInputs: [
      {
        projectId: 'p1',
        projectName: 'app',
        repoFullName: 'org/app',
        path: '/',
        openBranches: ['main'],
        isFocused: true,
        error: null,
        rawRuns: Array.from({ length: cachedRuns }, (_, i) => ({
          id: i + 1,
          name: 'CI',
          status: 'completed',
          conclusion: 'success',
          head_branch: 'main',
          created_at: new Date(now - 60_000 - i).toISOString()
        }))
      }
    ],
    focusedProjectId: 'p1',
    focusedBranch: 'main',
    authStatus: 'ok',
    authError: null,
    fetchedAt: now
  })
  return mockHost({
    storage: { 'workflows:snapshot': cached as unknown as JsonValue },
    results: {
      'project.list': { projects: [{ id: 'p1', name: 'app', kind: 'git', hostId: 'local', path: '/' }], truncated: false },
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'app', projectId: 'p1', path: '/', branch: 'main', hostId: 'local' }],
        truncated: false
      },
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [] }
    }
  })
}

/** Stubs gh/git. `ghResult` answers every gh call; git always reports org/app as origin. */
function stubExec(ghResult: (args: string[]) => string | Error): GhCall[] {
  const ghCalls: GhCall[] = []
  setExecForTests(async (_file, args) => {
    if (args[0] === '-C') return { stdout: 'origin\thttps://github.com/org/app.git (fetch)\n', stderr: '' }
    ghCalls.push(args)
    const result = ghResult(args)
    if (result instanceof Error) throw result
    return { stdout: result, stderr: '' }
  })
  return ghCalls
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('rate limit pauses polling, keeps the last good snapshot and blocks all GitHub calls', async () => {
  const ghCalls = stubExec(() =>
    ghFailure(SECONDARY_403, 'HTTP/2.0 403 Forbidden\r\nRetry-After: 120\r\n\r\n{"message":"secondary"}')
  )
  const host = rateLimitHost(3)
  const worker = await mountWorker(main, { host })
  try {
    const first = await worker.request('workflows.refresh')
    assert.equal(ghCalls.length, 1)
    assert.match(first.error ?? '', /GitHub begränsar anrop, försöker igen kl\. \d\d:\d\d/)
    assert.equal(first.snapshot?.runs.length, 3, 'last good snapshot is kept')
    assert.equal(first.snapshot?.repos[0].error, null, 'no red per-repo error')
    const stored = host.data().storage['workflows:snapshot'] as { runs: unknown[] }
    assert.equal(stored.runs.length, 3, 'persisted snapshot is not overwritten')

    // Everything that would call GitHub is suppressed during the pause.
    const again = await worker.request('workflows.refresh')
    assert.equal(again.snapshot?.runs.length, 3)
    assert.match(again.error ?? '', /GitHub begränsar anrop/)
    const get = await worker.request('workflows.get')
    assert.match(get.error ?? '', /GitHub begränsar anrop/)
    await worker.emit('workspace.created', { workspaceId: 'w2', kind: 'worktree', path: '/', branch: 'feat' })
    await worker.emit('workspace.removed', { workspaceId: 'w2', kind: 'worktree', path: '/' })

    const jobs = await worker.request('workflows.jobs', { repoFullName: 'org/app', runId: 1 })
    assert.match(jobs.error ?? '', /GitHub begränsar anrop/)
    const rerun = await worker.request('workflows.rerun', { repoFullName: 'org/app', runId: 1, failedOnly: false })
    assert.equal(rerun.ok, false)
    assert.match(rerun.error ?? '', /GitHub begränsar anrop/)
    const cancel = await worker.request('workflows.cancel', { repoFullName: 'org/app', runId: 1 })
    assert.equal(cancel.ok, false)
    assert.match(cancel.error ?? '', /GitHub begränsar anrop/)

    await wait(800)
    assert.equal(ghCalls.length, 1, 'no gh calls while paused')
  } finally {
    await worker.deactivate()
    setExecForTests(null)
  }
})

test('a rate limit hit by rerun also pauses refreshes', async () => {
  const ghCalls = stubExec((args) => (args[0] === 'run' ? ghFailure(TOO_MANY_429) : 'HTTP/2.0 200 OK\r\n\r\n{"workflow_runs":[]}'))
  const worker = await mountWorker(main, { host: rateLimitHost(2) })
  try {
    const rerun = await worker.request('workflows.rerun', { repoFullName: 'org/app', runId: 1, failedOnly: true })
    assert.equal(rerun.ok, false)
    assert.match(rerun.error ?? '', /GitHub begränsar anrop/)
    const refreshed = await worker.request('workflows.refresh')
    assert.equal(ghCalls.length, 1, 'refresh did not call gh')
    assert.equal(refreshed.snapshot?.runs.length, 2)
  } finally {
    await worker.deactivate()
    setExecForTests(null)
  }
})

test('event-triggered refreshes are throttled to one per 10 s', async () => {
  const ghCalls = stubExec(() => 'HTTP/2.0 200 OK\r\nEtag: "x"\r\n\r\n{"workflow_runs":[]}')
  const worker = await mountWorker(main, { host: rateLimitHost(1) })
  try {
    const res = await worker.request('workflows.refresh')
    assert.equal(res.error, null)
    assert.equal(ghCalls.length, 1)
    assert.deepEqual(ghCalls[0].slice(0, 2), ['api', '-i'])

    // Without throttling these would refresh after their 600 ms debounce.
    await worker.emit('workspace.created', { workspaceId: 'w2', kind: 'worktree', path: '/', branch: 'feat' })
    await worker.emit('workspace.removed', { workspaceId: 'w2', kind: 'worktree', path: '/' })
    await wait(900)
    assert.equal(ghCalls.length, 1, 'event refresh deferred by the throttle')

    // An explicit refresh from the panel is not throttled.
    await worker.request('workflows.refresh')
    assert.equal(ghCalls.length, 2)
  } finally {
    await worker.deactivate()
    setExecForTests(null)
  }
})
