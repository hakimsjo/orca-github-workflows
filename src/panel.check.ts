import type { JsonValue } from 'orca'
import { defineCheck } from 'orca/testing'
import { buildWorkflowSnapshot } from './github'

const now = Date.now()

const activeAndFailedSnapshot = buildWorkflowSnapshot({
  repoInputs: [
    {
      projectId: 'proj-qvitta',
      projectName: 'qvitta',
      repoFullName: 'systembydesign/qvitta',
      path: '/repos/qvitta',
      openBranches: ['main', 'feat/checkout'],
      isFocused: true,
      error: null,
      rawRuns: [
        {
          id: 101,
          name: 'CI',
          display_title: 'feat(checkout): add invoice preview',
          run_number: 660,
          run_attempt: 1,
          status: 'in_progress',
          conclusion: null,
          head_branch: 'feat/checkout',
          event: 'pull_request',
          html_url: 'https://github.com/systembydesign/qvitta/actions/runs/101',
          created_at: new Date(now - 90_000).toISOString(),
          updated_at: new Date(now - 10_000).toISOString(),
          run_started_at: new Date(now - 85_000).toISOString(),
          actor: { login: 'hakimsjo' }
        },
        {
          id: 100,
          name: 'Deploy production',
          display_title: 'Deploy production',
          run_number: 282,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'failure',
          head_branch: 'main',
          event: 'push',
          html_url: 'https://github.com/systembydesign/qvitta/actions/runs/100',
          created_at: new Date(now - 600_000).toISOString(),
          updated_at: new Date(now - 420_000).toISOString(),
          run_started_at: new Date(now - 595_000).toISOString(),
          actor: { login: 'hakimsjo' }
        }
      ]
    },
    {
      projectId: 'proj-akers',
      projectName: 'akers',
      repoFullName: 'systembydesign/akers',
      path: '/repos/akers',
      openBranches: ['main'],
      isFocused: false,
      error: null,
      rawRuns: [
        {
          id: 201,
          name: 'Build & Test',
          display_title: 'chore: bump dependencies',
          run_number: 44,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'success',
          head_branch: 'main',
          event: 'push',
          html_url: 'https://github.com/systembydesign/akers/actions/runs/201',
          created_at: new Date(now - 3_600_000).toISOString(),
          updated_at: new Date(now - 3_400_000).toISOString(),
          run_started_at: new Date(now - 3_590_000).toISOString(),
          actor: { login: 'hakimsjo' }
        }
      ]
    }
  ],
  focusedProjectId: 'proj-qvitta',
  focusedBranch: 'feat/checkout',
  authStatus: 'ok',
  authError: null,
  fetchedAt: now
})

const allGreenSnapshot = buildWorkflowSnapshot({
  repoInputs: [
    {
      projectId: 'proj-akers',
      projectName: 'akers',
      repoFullName: 'systembydesign/akers',
      path: '/repos/akers',
      openBranches: ['main'],
      isFocused: true,
      error: null,
      rawRuns: [
        {
          id: 301,
          name: 'CI',
          display_title: 'fix: tighten validation',
          run_number: 45,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'success',
          head_branch: 'main',
          event: 'push',
          html_url: 'https://github.com/systembydesign/akers/actions/runs/301',
          created_at: new Date(now - 900_000).toISOString(),
          updated_at: new Date(now - 720_000).toISOString(),
          run_started_at: new Date(now - 890_000).toISOString(),
          actor: { login: 'hakimsjo' }
        }
      ]
    }
  ],
  focusedProjectId: 'proj-akers',
  focusedBranch: 'main',
  authStatus: 'ok',
  authError: null,
  fetchedAt: now
})

export default defineCheck({
  fresh: {},
  activeAndFailed: {
    storage: {
      'workflows:snapshot': activeAndFailedSnapshot as unknown as JsonValue
    }
  },
  allGreen: {
    storage: {
      'workflows:snapshot': allGreenSnapshot as unknown as JsonValue
    }
  }
})
