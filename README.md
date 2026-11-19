# GitHub Workflows — Orca Plugin

An [Orca](https://orca.stably.ai) sidebar plugin and status bar indicator that monitors **GitHub Actions workflows** across all open Git repositories in Orca — highlighting running, queued, and failed runs.

## Features

- **Active & Failed View (`Aktiva & fel`)**: Immediately surfaces currently running/queued workflows and workflows whose latest run failed for your open Orca repositories.
- **Status Bar Indicator**: Displays live counts (`2 körs · 1 fel`, or `Workflows: OK`) in Orca's bottom status bar and keeps background polling active.
- **Smart Polling**: Polls every 15 seconds while workflows are running/queued and relaxes to your configured interval (default 60 seconds) when idle.
- **Inline Job & Step Breakdown**: Expand any run (`Visa jobb`) to inspect individual jobs and see which step is running or failed.
- **Quick Actions**: Re-run failed jobs, cancel running workflows, or open the run directly on GitHub.
- **Filters & Repo Overview**: Filter all recent runs by repository, status, or open Orca branches, or inspect per-repo status in the `Repon` tab.

## Requirements

- GitHub CLI (`gh`) installed and authenticated (`gh auth login`).

## Development & Verification

```bash
orca plugin validate .
orca plugin test .
orca plugin check .
orca plugin dev load .
```
