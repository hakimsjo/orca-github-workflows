<p align="center">
  <img src="assets/icon.png" alt="GitHub Workflows Orca Plugin Icon" width="96" height="96" />
</p>

# GitHub Workflows — Orca Plugin

An [Orca](https://orca.stably.ai) sidebar plugin and status bar indicator that monitors **GitHub Actions workflows** across all open Git repositories in Orca — making it easy to spot running, queued, and failed workflows at a glance.

## Features

- **Dedicated Tabs**:
  - **Aktiva**: Shows only currently running (`Pågående`) and queued (`Köad`) workflows across your open Orca repositories.
  - **Fel**: Surfaces currently failing workflows (`Misslyckad`, `Tidsgräns`, `Startfel`, `Åtgärd krävs`) whose latest run for that workflow & branch has not succeeded yet.
  - **Alla**: Browse recent runs across all open repositories with filters for repository, status, and open Orca worktree branches.
  - **Repon**: Overview per open repository showing its focused state, open branches in Orca, latest workflow status, and quick link to GitHub Actions.
- **Status Bar Indicator**: Displays a calm, neutral **`Workflows`** item in Orca's bottom status bar; hover over it for a live breakdown of active, queued, failed, and monitored repositories.
- **Smart Background Polling**: Polls every **15 seconds** while any workflow is running or queued, and relaxes to your configured interval (default **60 seconds**) when idle.
- **Inline Job & Step Inspection**: Expand any run (`Visa jobb`) to inspect individual jobs and highlight running or failed steps without leaving Orca.
- **Quick Actions**: Re-run failed jobs, cancel in-progress runs, or open any workflow run directly on GitHub.

## Requirements

- [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated:

```bash
gh auth login
```

## Installation

Install directly from GitHub using the Orca CLI:

```bash
orca plugin install hakimsjo/orca-github-workflows
```

Because this plugin runs a `trusted-worker` to discover open Orca projects, query `gh`, and cache snapshots in `orca.storage`, Orca will print an approval fingerprint (`ap1-...`) on the first run. Re-run with `--approve <fingerprint>` to enable it:

```bash
orca plugin install hakimsjo/orca-github-workflows --approve <fingerprint>
```

Open the panel in Orca's right sidebar:

```bash
orca plugin open hakimsjo.github-workflows --panel workflows
```

## Settings

Configurable under **Settings → Plugins → GitHub Workflows** in Orca:

| Setting | Default | Description |
| --- | --- | --- |
| `pollIntervalSeconds` | `60` | Background poll interval in seconds when idle (15–600). Drops to 15s while runs are active. |
| `runsPerRepo` | `10` | Number of recent workflow runs fetched per open repository (3–25). |
| `includeHiddenProjects` | `false` | Whether to include Git repositories marked as hidden in Orca's sidebar. |

## How It Works

1. The worker queries Orca's host API (`project.list`, `workspace.list`, and `workspace.readContext`) to discover open Git repositories and currently checked-out worktree branches.
2. Each repository's GitHub `owner/repo` slug is resolved from its Git remotes (`git remote -v`).
3. Workflow runs are fetched concurrently via `gh api repos/{owner}/{repo}/actions/runs` and cached in `orca.storage` so the panel opens instantaneously.
4. Workspace events (`workspace.created`, `workspace.removed`, `workspace.changed`) keep open branches and newly added worktrees in sync.

## Development & Testing

```bash
# Validate manifest, capabilities, and host API usage
orca plugin validate .

# Run unit tests (GitHub parser, worker, and panel)
orca plugin test .

# Render and verify panel check scenarios
orca plugin check .

# Load locally in development mode
orca plugin dev load .
```

## Project Structure

- `orca-plugin.json` — Plugin manifest (sidebar panel, status bar item, events, settings, and capabilities).
- `assets/icon.png` — Plugin icon.
- `src/protocol.ts` — Typed request and event contract between panel and worker.
- `src/github.ts` — Pure helpers for Git remote parsing, status classification, and snapshot aggregation.
- `src/worker.ts` — Node.js worker discovering open repos, polling `gh`, updating the status bar, and handling actions.
- `src/panel.tsx` — Declarative Orca components UI.
- `src/panel.check.ts` — Check scenarios rendered by `orca plugin check`.
- `src/worker.test.ts` & `src/panel.test.tsx` — Unit tests using `orca/testing`.
