import { assert, mockHost, mount, test } from 'orca/testing'
import { buildWorkflowSnapshot } from './github'
import * as panel from './panel'

function createSampleSnapshot(options?: { includeActiveAndFailed?: boolean }) {
  const now = Date.now()
  const includeActiveAndFailed = options?.includeActiveAndFailed ?? true

  return buildWorkflowSnapshot({
    repoInputs: [
      {
        projectId: 'proj-1',
        projectName: 'qvitta',
        repoFullName: 'systembydesign/qvitta',
        path: '/repos/qvitta',
        openBranches: ['main', 'feat/workflows'],
        isFocused: true,
        error: null,
        rawRuns: includeActiveAndFailed
          ? [
              {
                id: 1001,
                name: 'CI',
                display_title: 'feat: live workflow status',
                run_number: 660,
                status: 'in_progress',
                conclusion: null,
                head_branch: 'feat/workflows',
                event: 'push',
                html_url: 'https://github.com/systembydesign/qvitta/actions/runs/1001',
                created_at: new Date(now - 30_000).toISOString(),
                updated_at: new Date(now - 5_000).toISOString()
              },
              {
                id: 1000,
                name: 'Deploy',
                display_title: 'release v1.2',
                run_number: 120,
                status: 'completed',
                conclusion: 'failure',
                head_branch: 'main',
                event: 'push',
                html_url: 'https://github.com/systembydesign/qvitta/actions/runs/1000',
                created_at: new Date(now - 300_000).toISOString(),
                updated_at: new Date(now - 240_000).toISOString()
              }
            ]
          : [
              {
                id: 1002,
                name: 'CI',
                display_title: 'all good',
                run_number: 661,
                status: 'completed',
                conclusion: 'success',
                head_branch: 'main',
                event: 'push',
                html_url: 'https://github.com/systembydesign/qvitta/actions/runs/1002',
                created_at: new Date(now - 300_000).toISOString(),
                updated_at: new Date(now - 240_000).toISOString()
              }
            ]
      }
    ],
    focusedProjectId: 'proj-1',
    focusedBranch: 'feat/workflows',
    authStatus: 'ok',
    authError: null,
    fetchedAt: now
  })
}

test('panel separates active and failed runs into separate tabs and expands jobs', async () => {
  const snapshot = createSampleSnapshot({ includeActiveAndFailed: true })

  const host = mockHost({
    requests: {
      'workflows.get': () => ({ snapshot, refreshing: false }),
      'workflows.jobs': () => ({
        jobs: [
          {
            id: 99,
            name: 'test-suite',
            status: 'in_progress',
            conclusion: null,
            category: 'running',
            startedAtMs: Date.now() - 20_000,
            completedAtMs: null,
            htmlUrl: null,
            steps: [
              { number: 1, name: 'Install', status: 'completed', conclusion: 'success', category: 'success' },
              { number: 2, name: 'Vitest', status: 'in_progress', conclusion: null, category: 'running' }
            ]
          }
        ]
      })
    }
  })

  const view = await mount(panel, { host })

  // Default tab ("Aktiva") shows only running/queued runs
  assert.ok(view.find({ text: 'GitHub Workflows' }))
  assert.ok(view.find({ text: 'Pågående' }))
  assert.ok(view.find({ text: 'CI #660' }))
  assert.equal(view.find({ text: 'Deploy #120' }), null)

  // Expand jobs for the running run
  const expandButton = view.find({ type: 'Button', text: 'Visa jobb' })
  assert.ok(expandButton)
  await view.press(expandButton)

  assert.ok(view.find({ text: 'test-suite' }))
  assert.ok(view.find({ text: '• Steg 2: Vitest' }))

  // Switch to "Fel" tab -> shows failed run with red dot + Misslyckad
  await view.select({ type: 'Tabs' }, 'failed')
  assert.ok(view.find({ text: 'Deploy #120' }))
  assert.ok(view.find({ text: 'Misslyckad' }))
  assert.ok(view.find({ text: '●' }))
  assert.equal(view.find({ text: 'CI #660' }), null)

  // Switch to "Repon" tab
  await view.select({ type: 'Tabs' }, 'repos')
  assert.ok(view.find({ text: 'Fokuserat' }))
  assert.ok(view.find({ text: 'systembydesign/qvitta · Öppna: main, feat/workflows' }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('panel shows empty callouts on active and failed tabs when all workflows succeed', async () => {
  const snapshot = createSampleSnapshot({ includeActiveAndFailed: false })
  const host = mockHost({
    requests: {
      'workflows.get': () => ({ snapshot, refreshing: false })
    }
  })

  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'Inga aktiva workflows' }))

  await view.select({ type: 'Tabs' }, 'failed')
  assert.ok(view.find({ label: 'Inga misslyckade workflows' }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('panel recovers cleanly when workflows.get fails instead of hanging', async () => {
  const host = mockHost({
    requests: {
      'workflows.get': () => {
        throw new Error('Tillfälligt anslutningsfel')
      }
    }
  })

  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'Kunde inte hämta alla uppgifter' }))
  assert.ok(view.find({ text: /Tillfälligt anslutningsfel/ }))
  assert.ok(view.find({ type: 'Button', text: 'Försök igen' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
