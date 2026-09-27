# Local CI

Local CI accepts pushes to a local bare repository, validates the exact temporary merge commit with the project's local workflows, and serves its dashboard and API from one Fastify process. GitHub remains the shared remote and can later be only a backup.

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

A push notifies the scheduler. If a push arrived while the scheduler was offline, click Run beside that branch after restarting. The runner clones the retained candidate SHA into a disposable checkout, runs `act pull_request` against `.local-ci/workflows/*.yml` (falling back to `.github/workflows` if the local directory is absent), records streamed logs and exit status in SQLite, and deletes the checkout. It simulates a PR from the pushed branch to `develop` on the exact temporary merge commit. Branch and path filters select applicable workflows; a repository without an open/synchronize PR test workflow fails instead of appearing green. A workflow excluded by its path filters has no checks, as on GitHub. The GitHub-only PR-closed reset workflow is excluded. Failed Playwright upload-artifact steps can write to `scheduler/data/work/artifacts/<run-id>`.

The current `rxrise-server` local workflow runs architecture, migration undo, and backend tests with a Postgres service and Node 22/pnpm 10.15.0. The `rxrise-marketplaces` local workflows run architecture, unit, and Playwright tests with Node 20/pnpm 10.15.0. They are copied from each project's current `develop` YAML; edit `.local-ci/workflows` independently as the local pipeline evolves. Commit these files to the project before testing the branch. `act` uses the host Docker daemon for fresh runners and workflow service containers. It reuses locally cached images; a first run downloads missing images. LOCAL_CI_ACT_PLATFORM selects the ubuntu-latest image, LOCAL_CI_CONTAINER_ARCH selects its architecture, and LOCAL_CI_RUN_TIMEOUT_MINUTES defaults to 45.

## Promotion and recovery

1. A feature push validates a temporary merge against current develop. Ready to merge requires a passed candidate with unchanged source/base SHAs and at most 10 commits of drift (configurable with LOCAL_CI_MAX_BRANCH_DRIFT). Click Merge to develop. Local CI automatically queues the same complete test suite again against the now-current develop SHA; only after that verification passes does Push to develop become available. A failed post-merge run can be retried, but cannot authorize a GitHub push.
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
| Local workflow selection, PR event, Postgres/Playwright via act, isolated checkout, logs, timeout/cancel, post-merge verification | Implemented; needs actual Docker/workflow acceptance run |
| GitHub sync, divergence reconciliation, explicit guarded pushes/reset | Implemented; needs test with your GitHub permissions and branch rules |
| Manual enqueue, cancel, retry, restart recovery | Done; interrupted jobs require manual retry |
| GitHub PR creation/review, automatic feature rebase, built-in secret management | Outside V1; use GitHub and working copy, configure act secrets externally |

## First test

1. Start Docker; verify `docker info` and `act --version` (Compose installs act inside its container). Start Local CI; connect rxrise-server and rxrise-marketplaces. Ensure their `.local-ci/workflows` files have been merged into each develop branch or are present on the feature branch you push.
2. In either project's working copy, `git remote add ci <path displayed in dashboard>`, then `git push ci feat/some-branch`. Inspect the PR event, selected workflows, candidate SHA, individual job output, and pass/fail. A deliberately failing test must prevent Merge to develop. Check the Postgres service and Playwright artifact path on failure.
3. Merge a passed candidate locally; wait for the second complete run to pass before Push to develop becomes enabled. Push develop to GitHub, then `git fetch origin && git pull --ff-only origin develop` in your working copy. Validate develop against main, push main, and explicitly reset develop if desired.
4. Add a second repository and check the selector and shared queue. Change GitHub develop outside Local CI to test fast-forward or divergence before using production branches.

INTENT.md describes the target behavior. This development environment has no Docker or act binary, so the real container/GitHub deployment flow remains an acceptance test. The TypeScript builds and a local scheduler/queue smoke run were exercised.
