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
