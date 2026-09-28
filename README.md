# Local CI

Local CI accepts pushes to a local bare repository, validates the exact temporary merge commit with the project's local workflows, and serves its dashboard and API from one Fastify process. GitHub remains the shared remote and can later be only a backup.

## Start

Install Git, Node 24+, Docker Engine/Desktop, and act. Start the Docker daemon first. Then:

    npm ci --prefix scheduler
    npm ci --prefix dashboard
    npm run dev

Open http://127.0.0.1:6001. One command starts the API and rebuilds the dashboard as files change. For a built run use npm start. The server binds to loopback by default.

For Docker Compose, set the absolute path so the host Docker daemon and act can mount the same workspace:

    export LOCAL_CI_ROOT="$(pwd -P)"
    docker compose up --build

Compose binds port 6001 to loopback and mounts the host Docker socket. SQLite and bare repositories stay in this project directory. The first build downloads the pinned act binary and Node dependencies. Share the directory with Docker Desktop if needed.

## Connect repositories

Choose Add repository in the dashboard and enter a display name and GitHub SSH or HTTPS remote. The repository ID is a generated UUID. Local CI creates a bare repository under ci/repos, fetches GitHub branches, and initializes local develop from GitHub develop or main. The repository selector shows each project's branches, queue, history, and logs. Runs across projects are serialized.

In a working copy, click Connect and use the bare path it shows:

    git remote add ci /absolute/path/to/local-ci/ci/repos/<repository-id>.git
    git push ci feature/my-change

A push notifies the scheduler. If a push arrived while the scheduler was offline, click Run beside that branch after restarting. The runner clones the retained candidate SHA into a disposable checkout, runs `act pull_request` against `.local-ci/workflows/*.yml` (falling back to `.github/workflows` if the local directory is absent), records streamed logs and exit status in SQLite, and deletes the checkout. It simulates a PR from the pushed branch to `develop` on a merge commit whose subject is `Merge branch '<branch>' into develop`. A develop-to-main check uses `Merge branch 'develop' into main`. A reconciliation uses `Merge GitHub develop into local develop`. Branch and path filters select applicable workflows; a repository without an open/synchronize PR test workflow fails instead of appearing green. A workflow excluded by its path filters has no checks, as on GitHub. The GitHub-only PR-closed reset workflow is excluded. Failed upload-artifact steps can write to `scheduler/data/work/artifacts/<run-id>`.

The run detail panel lists each selected YAML with its live status and exit code. Click a workflow to see only its logs, or All logs for the complete run. The same data is available through `GET /api/runs/:id/workflows` and `GET /api/runs/:id/logs?workflow=<encoded-path>`.

`git push ci feat/branch` creates a local candidate and starts validation. A passing run automatically advances local `develop` to that exact tested merge commit and deletes that feature branch from the CI repository. The branch in your working copy stays. A smoke workflow keeps the branch until the smoke check passes. It does not open or merge a GitHub pull request. Failed runs leave `develop` unchanged and the worker proceeds to the next item. A newer push supersedes an older pending result from the same branch. When another candidate moves `develop`, queued candidates are rebuilt and retested on the new base. A conflict fails and must go back to the agent; local-ci never rewrites an agent branch.

An agent can poll its result with `node scripts/ci-wait.mjs <repository-id> <branch> [head-sha]`; exit 0 means integrated, 1 means failed, and 2 means timed out. `GET /api/runs/:id/result` returns machine-readable run state, failure lines, artifact directory and logs URL. The task identifier currently defaults to the feature branch name. The agent must run this command itself and repair its own failures; local-ci does not send messages to a suspended agent process.

Define each repository's checks in its own `.local-ci/workflows` directory. You can copy existing GitHub workflow YAML as a starting point and then evolve the local pipeline independently. Commit these files to the project before testing the branch. `act` uses the host Docker daemon for fresh runners and workflow service containers. It reuses locally cached images; a first run downloads missing images. LOCAL_CI_ACT_PLATFORM selects the ubuntu-latest image, LOCAL_CI_CONTAINER_ARCH selects its architecture (default: linux/amd64, same as GitHub), and LOCAL_CI_RUN_TIMEOUT_MINUTES defaults to 45.

## Promotion and recovery

1. Each passing candidate automatically integrates into local `develop`. Click Push to develop when you want to send that exact tested snapshot to GitHub staging. The button stays disabled when local develop and GitHub develop are already the same commit. The push temporarily freezes integration for that repository; other projects continue.
2. Click Validate develop → main to freeze that repository and test a fixed release snapshot. Once passed, click Push main to GitHub. If validation fails, the freeze releases. Push main is a local promotion gate, not a GitHub pull request.
3. After main is pushed, click Reset develop to main, or Release promotion to keep the current develop history. Reset uses a GitHub force-with-lease guard and an exact local compare-and-swap. If GitHub reset succeeds but local update is interrupted, retry Reset develop; the operation recognizes the already-reset remote. A conflicting local change blocks integration for explicit recovery. The freeze persists across scheduler restarts. Waiting feature branches are retested after it releases.

Optionally define `.local-ci/workflows/develop-smoke.yml` with `on: push` for `develop`. This short workflow runs ahead of other candidates after each local integration, pauses staging and further merges, and rolls back the exact local commit if it fails. A moved ref blocks rollback and needs explicit recovery. Without a smoke workflow that checks application health, there is no automatic health rollback.

The line under the title shows `GitHub develop: <relation> · local <sha> · GitHub <sha>`. It updates when the page loads and when you click Sync GitHub. `same` means the tips match. `local-ahead` means the tested merge is only local, so Push to develop can send it. `github-ahead` means GitHub has commits the local branch does not, and Sync GitHub fast-forwards. `diverged` means both sides moved: the line turns red, and Match GitHub develop plus Validate reconciliation appear. Match GitHub develop moves local develop to GitHub's existing commit and does not create a commit. Validate reconciliation still runs the workflow against a merge of the two tips, then Reconcile develop points local develop at that new merge commit. Push the resulting develop separately. Resolve conflicts in a working copy.

When a feature branch exceeds the drift limit at ingress, Sync/Rebase shows commands for an explicit rebase in the working copy and a guarded push back to ci. The scheduler never rewrites feature branches itself. Cancel handles queued/running runs; Retry reuses a candidate only if its source and base SHAs still match; Run makes a new validation. Interrupted jobs become failed on restart and can be retried. Results and logs persist in SQLite. There is no automatic failure retry or agent notification transport; agents should use the wait command.

## Done and missing

| Area | State |
| --- | --- |
| Multiple projects, selector, branch status, per-project history/logs | Done |
| Per-YAML workflow statuses and log drilldown | Done; full Docker job behavior needs acceptance run |
| One command and one HTTP server for dashboard and API | Done |
| Exact merge candidate, serial SQLite queue, automatic integration, latest-base retesting, superseded pushes | Implemented; integration test passes |
| Local workflow selection, PR event, workflow services and browser jobs via act, isolated checkout, logs, timeout/cancel | Implemented; needs actual Docker/workflow acceptance run |
| GitHub sync, divergence reconciliation, explicit guarded pushes/reset | Implemented; needs test with your GitHub permissions and branch rules |
| Durable per-repository promotion freeze, staging snapshot, guarded reset and recovery | Implemented; needs live GitHub acceptance run |
| Agent wait command, task branch result, manual enqueue, cancel, retry | Done; interrupted jobs require manual retry |
| Optional priority post-merge smoke and safe rollback | Implemented; no project health YAML configured yet and needs Docker acceptance run |
| Message delivery to suspended agents, automatic feature rebase, built-in secret management | Missing; use the agent wait command and working copy, configure act secrets externally |
| Sample app | Removed; connect your real repositories in the dashboard |

## First test

1. Start Docker; verify `docker info` and `act --version` (Compose installs act inside its container). Start Local CI; connect two repositories. Ensure their `.local-ci/workflows` files have been merged into each develop branch or are present on the feature branch you push.
2. In a connected project's working copy, `git remote add ci <path displayed in dashboard>`, then `git push ci feat/some-branch`. Wait for automatic integration with `node /path/to/local-ci/scripts/ci-wait.mjs <repository-id> feat/some-branch <head-sha>`. Check the PR event, selected workflows, candidate SHA, and individual job output. A deliberately failing test must leave develop unchanged. If workflows use services or artifacts, inspect their behavior on failure.
3. Push the healthy local develop snapshot to GitHub when staging is desired, then `git fetch origin && git pull --ff-only origin develop` in your working copy. Validate develop against main, push main, and explicitly reset or release promotion. Submit another branch during promotion and verify that it waits and is retested after reset.
4. Add a second repository and check the selector and shared queue. Change GitHub develop outside Local CI to test fast-forward or divergence before using production branches.

INTENT.md describes the target behavior. This development environment has no Docker or act binary, so real workflow containers and the GitHub deployment flow remain acceptance tests. The TypeScript builds, fake-act workflow selection, and a real-Git/SQLite integration test were exercised. Keep existing GitHub checks in place until the connected repositories' workflows pass on the deployment machine.
