# Local CI

Local CI runs repository workflows on your own machine and provides a local dashboard for validation and branch promotion. GitHub remains the shared remote.

## Start the app

Install dependencies once:

```bash
npm ci --prefix scheduler
npm ci --prefix dashboard
```

Then run the whole application with one command:

```bash
npm run dev
```

The scheduler serves both the dashboard and API at [http://127.0.0.1:3001](http://127.0.0.1:3001). The dashboard is rebuilt as files change. For a built run, use `npm start` from the project root.

## Connect repositories

Choose **Add repository** in the dashboard and provide an ID, display name, and GitHub remote. Local CI creates a bare repository under `ci/repos/<id>.git`, fetches its branches, and creates `develop` at `main` if no `develop` exists yet.

Add the shown path as a remote in your working copy:

```bash
git remote add ci /absolute/path/to/local-ci/ci/repos/rxrise-server.git
git push ci feature/my-change
```

The repository selector switches the dashboard among all connected projects. Each project keeps its own run history and branch states; CI still runs one job at a time.

## Branch status and promotion

- `queued`, `running`, `passed`, and `failed` describe CI for the branch.
- `ready to merge` means the exact candidate passed against the current `develop` and the branch has no more than 10 commits of drift.
- `sync required` blocks normal validation and merging when a branch is more than 10 commits behind `develop`.
- `ready to deploy` means the current `develop` passed validation against the current `main`. **Push main to GitHub** publishes that validated candidate.

The drift limit defaults to 10 commits and can be changed with `LOCAL_CI_MAX_BRANCH_DRIFT`.

Local CI never moves protected branches or pushes to GitHub automatically. Merge and push actions require a click in the dashboard.

## Current MVP limits

The runner currently executes `npm ci` and `npm test` in an isolated checkout directory. Running arbitrary GitHub Actions YAML with `act`, Docker runner isolation, GitHub branch synchronization/reconciliation, post-promotion `develop` reset, cancellation/retry controls, and the full failure-recovery model from [`INTENT.md`](./INTENT.md) remain to be implemented.
