# Local CI

Local CI accepts pushes to a local bare repository, validates the exact temporary merge commit with the repository's existing GitHub Actions workflows, and serves its dashboard and API from one Fastify process. GitHub remains the shared remote.

## Start

Install Git, Node 24+, Docker Engine/Desktop, and act. Start the Docker daemon first. Then:

    npm ci --prefix scheduler
    npm ci --prefix dashboard
    npm run dev

Open http://127.0.0.1:3001. One command starts the API and rebuilds the dashboard as files change. For a built run use npm start. The server binds to loopback by default.

For Docker Compose, set the absolute path so the host Docker daemon and act can mount the same workspace:

    export LOCAL_CI_ROOT="$(pwd -P)"
    docker compose up --build

Compose binds port 3001 to loopback and mounts the host Docker socket. SQLite and bare repositories stay in this project directory. The first build downloads the pinned act binary and Node dependencies. Share the directory with Docker Desktop if needed.

## Connect repositories

Choose Add repository in the dashboard and enter an ID, display name, and GitHub SSH or HTTPS remote. Local CI creates a bare repository under ci/repos, fetches GitHub branches, and initializes local develop from GitHub develop or main. The repository selector shows each project's branches, queue, history, and logs. Runs across projects are serialized.

In a working copy, use the exact bare path displayed in the dashboard:

    git remote add ci /absolute/path/to/local-ci/ci/repos/rxrise-server.git
    git push ci feature/my-change

A push notifies the scheduler. If a push arrived while the scheduler was offline, click Run beside that branch after restarting. The runner clones the retained candidate SHA into a disposable checkout, runs act against its .github/workflows directory, records streamed logs and exit status in SQLite, and deletes the checkout. act uses the host Docker daemon for fresh runners and workflow service containers. It reuses locally cached images; a first run downloads missing images. LOCAL_CI_ACT_PLATFORM selects the ubuntu-latest image, LOCAL_CI_CONTAINER_ARCH selects its architecture, and LOCAL_CI_RUN_TIMEOUT_MINUTES defaults to 45.

## Promotion and recovery

1. A feature push validates a temporary merge against current develop. Ready to merge requires a passed candidate with unchanged source/base SHAs and at most 10 commits of drift (configurable with LOCAL_CI_MAX_BRANCH_DRIFT). Click Merge to develop, then Push to develop to publish it to GitHub.
2. Click PR develop → main to validate the exact proposed main commit. Once passed, click Push main to GitHub. This is a local promotion gate, not a GitHub pull request.
3. After main is pushed, click Reset develop to main. This explicitly moves GitHub and local develop to that promoted SHA. The remote update uses a force-with-lease guard on the remembered GitHub develop SHA and refuses changed local refs. It never happens automatically.

The dashboard fetches GitHub refs. A strictly ahead GitHub branch fast-forwards local develop/main. Local ahead commits remain intact. Divergence blocks normal validation and pushing: click Validate reconciliation to run the full workflow against a temporary merge of GitHub and local develop, then click Reconcile develop after it passes. Push the resulting develop separately. Resolve conflicts in a working copy.

When a feature branch exceeds the drift limit, Sync/Rebase shows commands for an explicit rebase in the working copy and a guarded push back to ci. The scheduler never rewrites feature branches itself. Cancel handles queued/running runs; Retry reuses a candidate only if its source and base SHAs still match; Run makes a new validation. Interrupted jobs become failed on restart and can be retried. Results and logs persist in SQLite.

## Done and missing

| Area | State |
| --- | --- |
| Multiple projects, selector, branch status, per-project history/logs | Done |
| One command and one HTTP server for dashboard and API | Done |
| Exact merge candidate, serial SQLite queue, stale SHA gates | Done |
| act workflow execution, host Docker, isolated checkout, logs, timeout/cancel | Implemented; needs actual Docker/workflow acceptance run |
| GitHub sync, divergence reconciliation, explicit guarded pushes/reset | Implemented; needs test with your GitHub permissions and branch rules |
| Manual enqueue, cancel, retry, restart recovery | Done; interrupted jobs require manual retry |
| GitHub PR creation/review, automatic feature rebase, built-in secret management | Outside V1; use GitHub and working copy, configure act secrets externally |

## First test

1. Start Docker; verify docker info and act --version. Start Local CI and connect a test GitHub repository with a small push-triggered workflow.
2. Push a feature branch to ci; inspect candidate SHA, logs, and status. Try Run, Cancel, and Retry.
3. Merge a passed candidate locally, push develop, validate develop against main, push main, and explicitly reset develop.
4. Add a second repository and check the selector and shared queue. Change GitHub develop outside Local CI to test fast-forward or divergence before using production branches.

INTENT.md describes the target behavior. This development environment has no Docker or act binary, so the real container/GitHub deployment flow remains an acceptance test. The TypeScript builds and a local scheduler/queue smoke run were exercised.
