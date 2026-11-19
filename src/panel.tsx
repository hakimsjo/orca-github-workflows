import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  EmptyState,
  Grid,
  Heading,
  IconButton,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  Separator,
  set,
  shell,
  Spinner,
  Stack,
  Switch,
  Tab,
  Tabs,
  Text,
  type PanelContext,
  type Tone
} from 'orca'
import type { RepoSummary, SnapshotResponse, WorkflowJob, WorkflowRun, WorkflowSnapshot, WorkflowStatusCategory } from './protocol'

const snapshotAtom = atom<WorkflowSnapshot | null>(null)
const refreshingAtom = atom<boolean>(false)
const activeTabAtom = atom<'active' | 'failed' | 'all' | 'repos'>('active', 'active', { persist: 'plugin' })
const selectedRepoAtom = atom<string>('repoFilter', 'all', { persist: 'plugin' })
const statusFilterAtom = atom<string>('statusFilter', 'all', { persist: 'plugin' })
const onlyOpenBranchesAtom = atom<boolean>('onlyOpenBranches', false, { persist: 'plugin' })

const expandedRunIdAtom = atom<number | null>(null)
const jobsByRunAtom = atom<Record<number, WorkflowJob[]>>({})
const jobsLoadingRunIdAtom = atom<number | null>(null)
const jobsErrorByRunAtom = atom<Record<number, string>>({})
const actionBusyRunIdAtom = atom<number | null>(null)
const actionErrorAtom = atom<string | null>(null)

let lastWorkerId: string | null = null
let lastSequence = -1
let refreshSafetyTimer: ReturnType<typeof setTimeout> | null = null

function clearRefreshSafetyTimer(): void {
  if (refreshSafetyTimer) {
    clearTimeout(refreshSafetyTimer)
    refreshSafetyTimer = null
  }
}

function setRefreshingSafe(next: boolean): void {
  clearRefreshSafetyTimer()
  set(refreshingAtom, next)
  if (next) {
    refreshSafetyTimer = setTimeout(() => {
      refreshSafetyTimer = null
      if (read(refreshingAtom)) {
        set(refreshingAtom, false)
        set(actionErrorAtom, 'Uppdateringen tog för lång tid. Försök igen.')
      }
    }, 32_000)
    refreshSafetyTimer.unref?.()
  }
}

function applySnapshotResponse(res: SnapshotResponse): void {
  if (res.workerId && res.workerId !== lastWorkerId) {
    lastWorkerId = res.workerId
    lastSequence = -1
  }
  const seq = typeof res.sequence === 'number' ? res.sequence : -1
  if (seq >= 0 && seq < lastSequence) {
    return
  }
  if (seq >= 0) {
    lastSequence = seq
  }
  if (res.snapshot !== undefined) {
    set(snapshotAtom, res.snapshot)
  }
  setRefreshingSafe(Boolean(res.refreshing))
  if (res.error) {
    set(actionErrorAtom, res.error)
  } else if (!res.refreshing) {
    set(actionErrorAtom, null)
  }
}

function statusTone(category: WorkflowStatusCategory): Tone {
  switch (category) {
    case 'running':
      return 'accent'
    case 'queued':
      return 'warning'
    case 'failed':
      return 'danger'
    case 'success':
      return 'success'
    case 'cancelled':
    case 'other':
      return 'neutral'
  }
}

function statusLabel(category: WorkflowStatusCategory, conclusion?: string | null): string {
  switch (category) {
    case 'running':
      return 'Pågående'
    case 'queued':
      return 'Köad'
    case 'failed':
      if (conclusion === 'timed_out') return 'Tidsgräns'
      if (conclusion === 'startup_failure') return 'Startfel'
      if (conclusion === 'action_required') return 'Åtgärd krävs'
      return 'Misslyckad'
    case 'success':
      return 'Lyckad'
    case 'cancelled':
      if (conclusion === 'skipped') return 'Överhoppad'
      return 'Avbruten'
    case 'other':
      return 'Okänd'
  }
}

async function handleRefresh(): Promise<void> {
  if (read(refreshingAtom)) return
  setRefreshingSafe(true)
  set(actionErrorAtom, null)
  try {
    const res = await plugin.request('workflows.refresh', undefined, { timeoutMs: 35_000 })
    applySnapshotResponse(res)
  } catch (err) {
    set(actionErrorAtom, err instanceof Error ? err.message : 'Kunde inte uppdatera workflows.')
  } finally {
    if (read(refreshingAtom)) {
      setRefreshingSafe(false)
    }
  }
}

async function handleToggleJobs(run: WorkflowRun): Promise<void> {
  const current = read(expandedRunIdAtom)
  if (current === run.id) {
    set(expandedRunIdAtom, null)
    return
  }

  set(expandedRunIdAtom, run.id)
  const nextErrors = { ...read(jobsErrorByRunAtom) }
  delete nextErrors[run.id]
  set(jobsErrorByRunAtom, nextErrors)

  const cachedJobs = read(jobsByRunAtom)[run.id]
  if (cachedJobs && run.category !== 'running' && run.category !== 'queued') {
    return
  }

  set(jobsLoadingRunIdAtom, run.id)
  try {
    const res = await plugin.request(
      'workflows.jobs',
      { repoFullName: run.repoFullName, runId: run.id },
      { timeoutMs: 20_000 }
    )
    if (res.error) {
      set(jobsErrorByRunAtom, { ...read(jobsErrorByRunAtom), [run.id]: res.error })
    } else {
      set(jobsByRunAtom, { ...read(jobsByRunAtom), [run.id]: res.jobs })
    }
  } catch (err) {
    set(jobsErrorByRunAtom, {
      ...read(jobsErrorByRunAtom),
      [run.id]: err instanceof Error ? err.message : 'Kunde inte hämta jobb.'
    })
  } finally {
    if (read(jobsLoadingRunIdAtom) === run.id) {
      set(jobsLoadingRunIdAtom, null)
    }
  }
}

async function handleRerun(run: WorkflowRun, failedOnly: boolean): Promise<void> {
  set(actionBusyRunIdAtom, run.id)
  set(actionErrorAtom, null)
  try {
    const res = await plugin.request(
      'workflows.rerun',
      { repoFullName: run.repoFullName, runId: run.id, failedOnly },
      { timeoutMs: 20_000 }
    )
    if (!res.ok) {
      set(actionErrorAtom, res.error ?? 'Kunde inte starta om workflow.')
    }
  } catch (err) {
    set(actionErrorAtom, err instanceof Error ? err.message : 'Kunde inte starta om workflow.')
  } finally {
    set(actionBusyRunIdAtom, null)
  }
}

async function handleCancel(run: WorkflowRun): Promise<void> {
  set(actionBusyRunIdAtom, run.id)
  set(actionErrorAtom, null)
  try {
    const res = await plugin.request(
      'workflows.cancel',
      { repoFullName: run.repoFullName, runId: run.id },
      { timeoutMs: 20_000 }
    )
    if (!res.ok) {
      set(actionErrorAtom, res.error ?? 'Kunde inte avbryta workflow.')
    }
  } catch (err) {
    set(actionErrorAtom, err instanceof Error ? err.message : 'Kunde inte avbryta workflow.')
  } finally {
    set(actionBusyRunIdAtom, null)
  }
}

function handleFilterByRepo(repoFullName: string): void {
  set(selectedRepoAtom, repoFullName)
  set(statusFilterAtom, 'all')
  set(activeTabAtom, 'all')
}

export function setup(ctx: PanelContext): () => void {
  lastWorkerId = null
  lastSequence = -1
  let receivedUpdateEvent = false

  ctx.subscriptions.push(
    plugin.on('workflows.updated', (payload) => {
      receivedUpdateEvent = true
      applySnapshotResponse(payload)
    })
  )

  void plugin
    .request('workflows.get', undefined, { timeoutMs: 15_000 })
    .then((res) => {
      if (receivedUpdateEvent && res.sequence === undefined) {
        return
      }
      applySnapshotResponse(res)
    })
    .catch((err) => {
      setRefreshingSafe(false)
      set(actionErrorAtom, err instanceof Error ? err.message : 'Kunde inte kontakta bakgrundsprocessen.')
    })

  return () => {
    clearRefreshSafetyTimer()
  }
}

function StatusBadge({ category, conclusion }: { category: WorkflowStatusCategory; conclusion?: string | null }) {
  const label = statusLabel(category, conclusion)
  if (category === 'failed') {
    return (
      <Box direction="row" align="center" gap="xs" border paddingX="sm" height={20} radius="full" shrink={false}>
        <Text size="xs" tone="danger">
          ●
        </Text>
        <Text size="xs" weight="medium">
          {label}
        </Text>
      </Box>
    )
  }
  return <Badge tone={statusTone(category)}>{label}</Badge>
}

function HeaderBar({ snapshot, refreshing }: { snapshot: WorkflowSnapshot | null; refreshing: boolean }) {
  const runningTotal = snapshot ? snapshot.counts.running + snapshot.counts.queued : 0
  const failedTotal = snapshot ? snapshot.counts.currentFailing : 0

  return (
    <Row justify="between" align="center" gap="sm">
      <Stack gap="none">
        <Row gap="xs" align="center" wrap>
          <Heading level={2}>GitHub Workflows</Heading>
          {runningTotal > 0 ? <Badge tone="accent">{`${runningTotal} aktiva`}</Badge> : null}
          {failedTotal > 0 ? (
            <Box direction="row" align="center" gap="xs" border paddingX="sm" height={20} radius="full" shrink={false}>
              <Text size="xs" tone="danger">
                ●
              </Text>
              <Text size="xs" weight="medium">
                {`${failedTotal} fel`}
              </Text>
            </Box>
          ) : null}
        </Row>
        <Text muted size="xs">
          {snapshot ? `${snapshot.counts.repos} öppna repon i Orca` : 'Läser öppna repon...'}
        </Text>
      </Stack>
      <Row gap="xs" align="center">
        {refreshing ? <Spinner label="Uppdaterar workflows..." labelHidden /> : null}
        <IconButton
          icon="refresh"
          label="Uppdatera"
          tooltip="Hämta senaste workflow-körningar"
          variant="ghost"
          size="sm"
          disabled={refreshing}
          onPress={handleRefresh}
        />
      </Row>
    </Row>
  )
}

function SummaryStrip({ snapshot }: { snapshot: WorkflowSnapshot }) {
  const { running, queued, currentFailing, repos } = snapshot.counts
  const activeCount = running + queued

  return (
    <Grid columns={3} gap="xs">
      <Box border background="card" padding="sm" radius="md" gap="none">
        <Text size="xs" muted>
          Aktiva
        </Text>
        <Text size="md" weight="semibold" tone={activeCount > 0 ? 'accent' : 'neutral'}>
          {String(activeCount)}
        </Text>
      </Box>

      <Box border background="card" padding="sm" radius="md" gap="none">
        <Text size="xs" muted>
          Misslyckade
        </Text>
        <Text size="md" weight="semibold" tone={currentFailing > 0 ? 'danger' : 'neutral'}>
          {String(currentFailing)}
        </Text>
      </Box>

      <Box border background="card" padding="sm" radius="md" gap="none">
        <Text size="xs" muted>
          Repon
        </Text>
        <Text size="md" weight="semibold">
          {String(repos)}
        </Text>
      </Box>
    </Grid>
  )
}

function JobBreakdown({ run }: { run: WorkflowRun }) {
  const loadingId = read(jobsLoadingRunIdAtom)
  const jobs = read(jobsByRunAtom)[run.id]
  const error = read(jobsErrorByRunAtom)[run.id]

  if (loadingId === run.id && !jobs) {
    return (
      <Row gap="xs" align="center">
        <Spinner label="Hämtar jobb..." labelHidden />
        <Text size="xs" muted>
          Hämtar jobb...
        </Text>
      </Row>
    )
  }

  if (error) {
    return (
      <Text size="xs" tone="danger">
        {error}
      </Text>
    )
  }

  if (!jobs || jobs.length === 0) {
    return (
      <Text size="xs" muted>
        Inga jobb rapporterade ännu.
      </Text>
    )
  }

  return (
    <Stack gap="xs">
      <Separator />
      {jobs.map((job) => {
        const highlightSteps = job.steps.filter((s) => s.category === 'failed' || s.category === 'running')
        return (
          <Stack key={job.id} gap="none">
            <Row justify="between" align="center" gap="xs">
              <Text size="xs" weight="medium" truncate>
                {job.name}
              </Text>
              <StatusBadge category={job.category} conclusion={job.conclusion} />
            </Row>
            {highlightSteps.map((step) => (
              <Text key={`${job.id}-${step.number}`} size="xs" tone={statusTone(step.category)} truncate>
                {`• Steg ${step.number}: ${step.name}`}
              </Text>
            ))}
          </Stack>
        )
      })}
    </Stack>
  )
}

function RunCard({ run }: { run: WorkflowRun }) {
  const expanded = read(expandedRunIdAtom) === run.id
  const busy = read(actionBusyRunIdAtom) === run.id
  const isActive = run.category === 'running' || run.category === 'queued'

  return (
    <Box border background="card" padding="sm" radius="md" gap="xs">
      <Row justify="between" align="center" gap="xs">
        <Row gap="xs" align="center">
          <StatusBadge category={run.category} conclusion={run.conclusion} />
          <Text size="sm" weight="semibold" truncate>
            {run.projectName}
          </Text>
        </Row>
        <RelativeTime at={run.updatedAtMs || run.createdAtMs} format="short" muted />
      </Row>

      <Row justify="between" align="center" gap="xs">
        <Text size="xs" weight="medium" truncate>
          {run.runNumber > 0 ? `${run.name} #${run.runNumber}` : run.name}
        </Text>
        {run.matchesOpenBranch ? <Badge tone="accent">Öppen branch</Badge> : null}
      </Row>

      <Text size="xs" muted truncate>
        {`${run.branch ?? '—'} · ${run.displayTitle}`}
      </Text>

      <Row justify="between" align="center" gap="xs">
        <Button
          size="xs"
          variant="ghost"
          icon={expanded ? 'collapse' : 'expand'}
          onPress={() => handleToggleJobs(run)}
        >
          {expanded ? 'Dölj jobb' : 'Visa jobb'}
        </Button>

        <Row gap="xs" align="center">
          {isActive ? (
            <IconButton
              size="xs"
              variant="ghost"
              tone="warning"
              icon="stop"
              label="Avbryt körning"
              tooltip="Avbryt workflow-körning"
              disabled={busy}
              onPress={() => handleCancel(run)}
            />
          ) : null}
          {run.category === 'failed' ? (
            <IconButton
              size="xs"
              variant="ghost"
              tone="accent"
              icon="refresh"
              label="Kör om misslyckade jobb"
              tooltip="Kör om misslyckade jobb"
              disabled={busy}
              onPress={() => handleRerun(run, true)}
            />
          ) : null}
          <IconButton
            size="xs"
            variant="ghost"
            icon="open-external"
            label="Öppna på GitHub"
            tooltip="Öppna körningen på GitHub"
            onPress={() => shell.openExternal(run.htmlUrl)}
          />
        </Row>
      </Row>

      {expanded ? <JobBreakdown run={run} /> : null}
    </Box>
  )
}

function ActiveRunsTab({ snapshot }: { snapshot: WorkflowSnapshot }) {
  if (snapshot.counts.repos === 0) {
    return (
      <EmptyState
        icon="folder"
        title="Inga öppna GitHub-repon"
        description="Lägg till eller visa ett Git-repo med en GitHub-remote i Orca så visas dess workflows här."
      />
    )
  }

  const activeRuns = snapshot.runs
    .filter((r) => r.category === 'running' || r.category === 'queued')
    .slice(0, 40)

  if (activeRuns.length === 0) {
    return (
      <Callout tone="neutral" icon="check" title="Inga aktiva workflows">
        <Text size="xs" muted>
          {`Inga workflows körs eller väntar i kö just nu bland ${snapshot.counts.repos} öppna repon.`}
        </Text>
      </Callout>
    )
  }

  return (
    <Stack gap="xs">
      {activeRuns.map((run) => (
        <RunCard key={run.id} run={run} />
      ))}
    </Stack>
  )
}

function FailedRunsTab({ snapshot }: { snapshot: WorkflowSnapshot }) {
  if (snapshot.counts.repos === 0) {
    return (
      <EmptyState
        icon="folder"
        title="Inga öppna GitHub-repon"
        description="Lägg till eller visa ett Git-repo med en GitHub-remote i Orca så visas dess workflows här."
      />
    )
  }

  const failedRuns = snapshot.runs
    .filter((r) => r.category === 'failed' && r.isLatestForKey)
    .slice(0, 40)

  if (failedRuns.length === 0) {
    return (
      <Callout tone="success" icon="check" title="Inga misslyckade workflows">
        <Text size="xs" muted>
          {`Alla senaste körningar i ${snapshot.counts.repos} öppna repon är utan fel.`}
        </Text>
      </Callout>
    )
  }

  return (
    <Stack gap="xs">
      {failedRuns.map((run) => (
        <RunCard key={run.id} run={run} />
      ))}
    </Stack>
  )
}

function AllRunsTab({ snapshot }: { snapshot: WorkflowSnapshot }) {
  const selectedRepo = read(selectedRepoAtom)
  const statusFilter = read(statusFilterAtom)
  const onlyOpenBranches = read(onlyOpenBranchesAtom)

  const repoOptions = [
    { value: 'all', label: 'Alla repon' },
    ...snapshot.repos.map((r) => ({ value: r.repoFullName, label: r.projectName }))
  ]

  const statusOptions = [
    { value: 'all', label: 'Alla statusar' },
    { value: 'active', label: 'Pågående / köade' },
    { value: 'failed', label: 'Misslyckade' },
    { value: 'success', label: 'Lyckade' },
    { value: 'cancelled', label: 'Avbrutna' }
  ]

  const filtered = snapshot.runs
    .filter((run) => {
      if (selectedRepo !== 'all' && run.repoFullName !== selectedRepo) return false
      if (onlyOpenBranches && !run.matchesOpenBranch) return false
      if (statusFilter === 'active') return run.category === 'running' || run.category === 'queued'
      if (statusFilter === 'failed') return run.category === 'failed'
      if (statusFilter === 'success') return run.category === 'success'
      if (statusFilter === 'cancelled') return run.category === 'cancelled'
      return true
    })
    .slice(0, 40)

  return (
    <Stack gap="sm">
      <Grid columns={2} gap="xs">
        <Select
          label="Filtrera på repo"
          labelHidden
          value={selectedRepo}
          options={repoOptions}
          onChange={(val) => set(selectedRepoAtom, val)}
        />
        <Select
          label="Filtrera på status"
          labelHidden
          value={statusFilter}
          options={statusOptions}
          onChange={(val) => set(statusFilterAtom, val)}
        />
      </Grid>

      <Switch
        label="Endast öppna branches i Orca"
        checked={onlyOpenBranches}
        onChange={(checked) => set(onlyOpenBranchesAtom, checked)}
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon="filter"
          title="Inga matchande körningar"
          description="Prova att ändra repo- eller statusfiltret."
        />
      ) : (
        <Stack gap="xs">
          {filtered.map((run) => (
            <RunCard key={run.id} run={run} />
          ))}
        </Stack>
      )}
    </Stack>
  )
}

function RepoCard({ repo }: { repo: RepoSummary }) {
  const latest = repo.latestRun

  return (
    <Box border background="card" padding="sm" radius="md" gap="xs">
      <Row justify="between" align="center" gap="xs">
        <Row gap="xs" align="center">
          <Text size="sm" weight="semibold" truncate>
            {repo.projectName}
          </Text>
          {repo.isFocused ? <Badge tone="accent">Fokuserat</Badge> : null}
        </Row>
        {latest ? (
          <StatusBadge category={latest.category} conclusion={latest.conclusion} />
        ) : (
          <Badge tone="neutral">Inga körningar</Badge>
        )}
      </Row>

      <Text size="xs" muted truncate>
        {repo.openBranches.length > 0
          ? `${repo.repoFullName} · Öppna: ${repo.openBranches.join(', ')}`
          : repo.repoFullName}
      </Text>

      {repo.error ? (
        <Text size="xs" tone="danger">
          {repo.error}
        </Text>
      ) : null}

      <Row justify="between" align="center" gap="xs">
        <Button size="xs" variant="ghost" icon="filter" onPress={() => handleFilterByRepo(repo.repoFullName)}>
          Visa körningar
        </Button>
        <IconButton
          size="xs"
          variant="ghost"
          icon="open-external"
          label="Öppna Actions på GitHub"
          tooltip="Öppna GitHub Actions för detta repo"
          onPress={() => shell.openExternal(`https://github.com/${repo.repoFullName}/actions`)}
        />
      </Row>
    </Box>
  )
}

function ReposTab({ snapshot }: { snapshot: WorkflowSnapshot }) {
  if (snapshot.repos.length === 0) {
    return (
      <EmptyState
        icon="folder"
        title="Inga öppna GitHub-repon hittades"
        description="Lägg till ett Git-projekt med GitHub-remote i Orca."
      />
    )
  }

  return (
    <Stack gap="xs">
      {snapshot.repos.map((repo) => (
        <RepoCard key={repo.repoFullName} repo={repo} />
      ))}
    </Stack>
  )
}

export default function Panel() {
  const snapshot = read(snapshotAtom)
  const refreshing = read(refreshingAtom)
  const activeTab = read(activeTabAtom)
  const actionError = read(actionErrorAtom)

  return (
    <Stack gap="md">
      <HeaderBar snapshot={snapshot} refreshing={refreshing} />

      {actionError ? (
        <Callout tone="warning" icon="warning" title="Kunde inte hämta alla uppgifter">
          <Stack gap="sm">
            <Text size="xs">{actionError}</Text>
            <Row gap="xs">
              <Button size="xs" variant="ghost" icon="refresh" onPress={handleRefresh} disabled={refreshing}>
                Försök igen
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}

      {!snapshot ? (
        <Box border background="card" padding="lg" radius="lg" align="center" gap="sm">
          {refreshing ? (
            <>
              <Spinner label="Hämtar GitHub Workflows..." />
              <Text muted size="xs">
                Läser öppna repon och workflow-körningar...
              </Text>
            </>
          ) : (
            <EmptyState
              icon="layers"
              title="Inga workflows hämtade än"
              description="Klicka på Hämta nu för att läsa aktiva och misslyckade workflows för dina öppna repon."
            >
              <Button icon="refresh" onPress={handleRefresh}>
                Hämta nu
              </Button>
            </EmptyState>
          )}
        </Box>
      ) : (
        <>
          {snapshot.authStatus !== 'ok' ? (
            <Callout tone="warning" icon="warning" title="GitHub CLI behöver loggas in">
              <Stack gap="sm">
                <Text size="xs">{snapshot.authError ?? 'Kör "gh auth login" i en terminal.'}</Text>
                <Row gap="xs">
                  <Button size="xs" variant="ghost" icon="refresh" onPress={handleRefresh} disabled={refreshing}>
                    Försök igen
                  </Button>
                </Row>
              </Stack>
            </Callout>
          ) : null}

          <SummaryStrip snapshot={snapshot} />

          <Tabs
            label="Workflow-vyer"
            value={activeTab}
            onChange={(val) =>
              set(activeTabAtom, val === 'failed' || val === 'all' || val === 'repos' ? val : 'active')
            }
          >
            <Tab value="active" label="Aktiva" icon="layers">
              <ActiveRunsTab snapshot={snapshot} />
            </Tab>
            <Tab value="failed" label="Fel" icon="warning">
              <FailedRunsTab snapshot={snapshot} />
            </Tab>
            <Tab value="all" label="Alla" icon="branch">
              <AllRunsTab snapshot={snapshot} />
            </Tab>
            <Tab value="repos" label="Repon" icon="folder">
              <ReposTab snapshot={snapshot} />
            </Tab>
          </Tabs>

          <Separator />
          <Row justify="between" align="center">
            <Text muted size="xs">
              Uppdaterad <RelativeTime at={snapshot.fetchedAt} format="short" muted />
            </Text>
            <Text muted size="xs">
              {snapshot.counts.running + snapshot.counts.queued > 0 ? 'Pollar var 15:e sek' : 'Bakgrundspolling aktiv'}
            </Text>
          </Row>
        </>
      )}
    </Stack>
  )
}
