# Intent: Local CI/CD Scheduler

## Purpose

Build a local CI/CD scheduler that replaces most of the GitHub Actions usage for personal development workflows, while keeping GitHub as the main remote repository and collaboration surface for now.

The immediate goal is not to build a full GitHub replacement. The goal is to create a small, reliable CI system that:

- runs locally first,
- isolates CI workloads from normal development,
- supports multiple agents working in parallel,
- keeps `develop` healthy,
- validates production candidates before promotion,
- exposes useful status and history through a local UI,
- can later be moved to a dedicated home server with minimal architectural change.

A secondary goal is to use the project to learn Git internals, CI/CD design, containers, queues, server administration, networking, observability, and failure recovery through a real tool that is useful every day.

---

## Core Design Principle

The scheduler owns execution and promotion decisions.

Git hooks should only notify the scheduler that something changed. Hooks should not run builds, tests, merges, or deployments themselves.

Conceptually:

```text
git push ci <branch>
        |
        v
Bare Git repository
        |
        | post-receive hook
        v
Scheduler API
        |
        v
Queue
        |
        v
Isolated runner/container
        |
        +--> build
        +--> tests
        +--> validation
        |
        v
Run result + logs + metadata
        |
        v
Database + Dashboard
```

---

## Local-First Architecture

The first version should run entirely on the development Mac.

The Mac will host:

- a bare Git repository,
- the scheduler,
- the job queue,
- isolated CI runners,
- the database,
- the local administration UI.

The scheduler may run inside its own long-lived Docker container, but it should **not** run Docker-in-Docker.

Instead, the scheduler container should communicate with the host Docker daemon and ask the host to create and destroy ephemeral runner/service containers.

Conceptually:

```text
scheduler container
      |
      | host Docker socket / Docker API
      v
Host Docker daemon
      |
      +--> ephemeral runner container
      +--> ephemeral Postgres container
      +--> ephemeral OpenSearch container
      +--> other per-run services
```

No public internet exposure is required for the local version.

The development repository should configure an additional Git remote, for example:

```bash
git remote add ci <local-bare-repository>
```

A developer or agent can then run:

```bash
git push ci feature/my-change
```

The bare repository receives the push and its `post-receive` hook sends an event to the scheduler.

This architecture should remain portable so that later the bare repository, scheduler, database, and runners can move to a dedicated server without changing the overall workflow.

---

## Git Server

Use a bare Git repository as the CI ingress point.

Example conceptual layout:

```text
~/ci/repos/project.git
```

The bare repository should:

- accept pushes from the local development repository,
- support arbitrary feature branches,
- support `develop`,
- eventually support `main`,
- use `post-receive` to notify the scheduler.

The hook should emit only lightweight metadata such as:

- repository,
- branch/ref,
- old commit SHA,
- new commit SHA,
- timestamp.

The scheduler should derive all other behavior from that event.

---

## Scheduler

The scheduler is the central component.

Responsibilities:

- receive Git events,
- persist runs,
- enqueue work,
- manage concurrency,
- launch isolated runners,
- track status,
- collect logs,
- determine which tests must run,
- coordinate merge validation,
- prevent broken code from entering protected branches,
- expose run status and manual actions through the UI.

The scheduler must never automatically promote code to `develop`, `main`, or GitHub. Promotion and deployment are explicit human actions initiated from the dashboard.

The scheduler should not decide which project commands or tests need to run. The project workflow definition owns that decision.

For the initial version, the runner should execute the GitHub Actions workflows that already exist in the repository. The `.yml` workflow files remain the source of truth for CI behavior.

---

## Queue

Jobs should be queued instead of immediately executing without limits.

Initial behavior:

- concurrency defaults to `1`,
- additional jobs wait in the queue,
- concurrency can later be increased based on measured CPU, RAM, disk, and thermal impact.

The scheduler should expose:

- queued jobs,
- running jobs,
- completed jobs,
- failed jobs,
- canceled jobs.

The queue must protect the development machine from CI workloads overwhelming normal development processes.

---

## Runner Isolation

Every CI execution should run in its own isolated environment.

Preferred initial approach:

- containers,
- one fresh runner environment per CI run,
- fresh mutable service state per CI run,
- reuse locally cached Docker images where safe.

The scheduler must **not** create a nested Docker daemon inside itself. There should be no Docker-in-Docker architecture in V1.

The host Docker daemon owns all runner and service containers.

A runner should not share mutable application state with local development.

In particular, CI jobs must not accidentally use or modify:

- local development databases,
- local queues,
- local caches,
- local application processes,
- local environment files,
- local ports unless explicitly allocated.

Each run should receive its own:

- workspace,
- checkout,
- environment,
- services,
- temporary database if required,
- logs.

Docker images should be reused from the host's local image cache. A run should not redownload Postgres, OpenSearch, or other service images when the required image already exists locally.

Mutable service data should normally **not** be reused between CI runs. For example:

- Postgres data directories should be fresh per run,
- OpenSearch indexes should be fresh per run,
- application runtime state should be fresh per run.

Safe caches such as package-manager caches or build caches may be reused separately if they do not compromise test isolation.

The runner should check out the exact commit SHA requested by the scheduler.

---

## Workflow Execution and Test Selection

The scheduler and runner are orchestration infrastructure. They should not contain project-specific knowledge about which commands, builds, or checks to execute.

For the initial version, each project keeps its existing GitHub Actions workflow files under `.github/workflows/*.yml`.

Conceptually:

```text
Git event
    |
    v
Scheduler
    |
    v
Runner/container
    |
    v
Read project workflow YAML
    |
    v
Execute the workflow
```

The workflow files remain the source of truth for CI behavior.

The scheduler determines:

- when a run should happen,
- which commit/ref should be tested,
- queue order,
- concurrency,
- runner lifecycle,
- run status,
- merge/promotion gating.

The runner executes the requested workflow in an isolated environment and reports the result.

### Initial testing policy

For V1, every pull-request merge candidate should run the complete required test suite.

There is no dependency-graph-based test selection in the initial version.

Because the CI runs on local hardware rather than metered GitHub Actions minutes, correctness and simplicity are more important than minimizing the number of tests executed.

The important rule is:

> The exact commit that would become `develop` must pass the complete required workflow before the merge button is enabled.

Dependency-graph optimization may be added later if local CI execution becomes a real bottleneck.

## Merge Queue

Passing tests on a PR branch by itself is not sufficient. The scheduler must validate the exact state that would exist after merging that PR into the current `develop`.

Pull-request branches are not automatically rebased or updated when `develop` changes.

Instead, the scheduler creates a temporary merge candidate against the current target branch.

Example:

```text
develop = A
PR1 = A -> B
PR2 = A -> C
PR3 = A -> D
```

To validate PR1:

```text
current develop A + PR1 changes B
            |
            v
temporary merge candidate M1
            |
            v
full required workflow
            |
          PASS
            |
            v
ready for manual merge
```

If the user merges PR1, `develop` advances to the exact validated merge result.

```text
develop = M1
```

At that point, any PRs previously validated against the old `develop` SHA become stale.

The scheduler should not automatically rewrite or rebase those PR branches. Instead, when a stale PR reaches the front of the queue, the scheduler creates a new temporary merge candidate against the new current `develop` and runs the full required workflow again.

Conceptually:

```text
develop = A+B

PR2 branch still based on A
        |
        v
temporary candidate = (A+B) + PR2 changes
        |
        v
full workflow
```

This is a serial merge queue, not a speculative merge train.

Only one candidate needs to be actively validated at a time.

The scheduler should:

1. take the current `develop` SHA,
2. take the next PR candidate,
3. create a temporary merge result without modifying the PR branch,
4. run the repository's complete required workflow against that exact result,
5. if validation fails, leave `develop` unchanged,
6. if validation passes, mark the candidate as ready for manual merge,
7. enable the merge button only while `develop` still matches the SHA used for validation,
8. if `develop` changes before the merge occurs, mark the validation as stale,
9. revalidate the PR against the new `develop` when it reaches the front of the queue again.

The scheduler validates and prepares changes; the human authorizes branch movement.

The primary invariant is:

> `develop` only moves to a commit that has already passed the complete required workflow and was explicitly approved by the user.

## Develop Branch Policy

`develop` is a protected integration branch.

Nothing should enter `develop` unless the exact merge candidate has passed the complete required workflow defined by the repository **and** the user explicitly approves the merge from the dashboard.

A failed candidate must not leave `develop` broken.

A passing candidate should remain staged as "ready to merge" only while the target `develop` SHA remains unchanged.

If `develop` changes, that validation becomes stale and must be repeated before merging.

PR branches may remain behind `develop`; the scheduler should not automatically rebase or update them.

The scheduler should always know the latest healthy `develop` commit.

---

## Manual Promotion and Deployment

There is no automatic branch promotion.

All branch movement must require an explicit user action in the dashboard.

Conceptually:

```text
feature branch
      |
      v
validated candidate
      |
      | user clicks
      | "Merge to develop"
      v
develop
      |
      v
validation for main
      |
      | user clicks
      | "Merge to main"
      v
main
      |
      | user clicks
      | "Deploy / Push to GitHub"
      v
GitHub remote
```

The dashboard should expose separate, explicit actions for:

- merging an approved candidate into `develop`,
- merging an approved `develop` state into `main`,
- pushing the local `develop` branch to GitHub,
- pushing the local `main` branch to GitHub.

These actions must not be triggered automatically by successful tests.

Before enabling a merge button:

- the exact temporary merge candidate must have passed the complete required repository workflow,
- the source PR commit must still match the commit that was validated,
- the target branch SHA must still match the SHA used to create the validated candidate.

Before enabling a push/deploy button:

- the local branch must be in a valid state,
- the user must explicitly request the push,
- the UI should make clear which local commit will be pushed and to which GitHub branch.

If either the source PR or target branch changes after validation, the previous result becomes stale and the candidate must be revalidated.

A PR being behind `develop` is not, by itself, a reason to rewrite or rebase the PR branch. Validation is performed by creating a temporary merge result against the current `develop`.

Whether validation runs the full suite, additional checks, or selective checks remains defined by the repository's workflow configuration rather than hard-coded into the scheduler.

## PR Branch Update Policy

Do not automatically rebase or update PR branches when `develop` changes.

A PR may legitimately show that it is several commits behind its target branch.

The scheduler should track:

- source PR commit SHA,
- current target branch SHA,
- SHA against which the candidate was last validated,
- how many commits the PR branch is behind the target,
- whether the last validation is current or stale.

Example dashboard state:

```text
PR #12
Source SHA:         a1b2c3
Current develop:    f8e9d0
Behind by:          37 commits
Validated against:  f8e9d0
Status:             READY
```

A PR can still be mergeable while being behind if the temporary merge candidate against the current target passed the full workflow.

Optional future safety/ergonomic rules may warn or block when a branch is extremely far behind or requires manual conflict resolution, but commit distance alone is not the correctness mechanism.

The correctness rule is:

> A PR cannot be merged unless its exact merge result has been validated against the current target SHA.

## Failure Recovery

The system should be designed around explicit failure scenarios.

Important cases:

- runner crashes,
- scheduler crashes,
- machine restarts,
- test process hangs,
- container exits unexpectedly,
- merge fails,
- tests pass on a feature branch but fail during integration,
- multiple agents submit competing changes,
- a job is duplicated,
- a push occurs while another integration run is active.

Desired property:

> The system should be recoverable without losing track of which commit is known-good.

Persistent state should make it possible to restart the scheduler and reconstruct pending/running work safely.

---

## Database

Start with SQLite.

The initial scale does not justify a separate database server.

Persist at least:

### Repositories
- repository ID,
- name,
- bare repository path.

### Runs
- run ID,
- repository,
- branch/ref,
- commit SHA,
- trigger,
- status,
- created time,
- start time,
- completion time.

### Jobs
- job ID,
- run ID,
- type,
- status,
- runner/container ID,
- start/end time,
- exit code.

### Merge candidates
- source branch,
- source SHA,
- target branch,
- generated integration SHA,
- status.

### Logs / artifacts metadata
Logs themselves may eventually live outside SQLite, but their location and metadata should be persisted.

---

## Administration UI

Build a local web dashboard.

The UI should initially bind only to localhost or a private interface.

It should show:

- current queue,
- active runs,
- recent runs,
- pass/fail status,
- branch,
- commit SHA,
- duration,
- selected vs full-suite testing,
- test output/logs,
- merge queue state,
- latest known-good `develop`,
- latest known-good `main`.

Useful actions should include:

- retry,
- cancel,
- inspect logs,
- manually enqueue a run,
- merge an approved candidate into `develop`,
- merge an approved `develop` state into `main`,
- push `develop` to GitHub,
- push `main` to GitHub.

Branch promotion and deployment actions must always require a user click.

The UI is an operational tool, not just a visualization.

---

## Networking and Security

For the local version:

- bind the UI/API to localhost,
- no public exposure,
- authentication is optional while everything is local.

For the future server version:

- do not expose the administration UI directly to the public internet,
- access it through a private network such as Tailscale or another VPN,
- use SSH keys for server access,
- avoid password-only public administration endpoints.

If GitHub is later used to trigger this CI server through webhooks, expose only a narrow webhook endpoint and verify webhook signatures.

---

## Resource Management

The scheduler itself should be lightweight.

The expensive part is the workload executed by runners:

- builds,
- tests,
- containers,
- databases,
- compilers,
- integration services.

Initial policy:

```text
max concurrent CI runs = 1
```

Increase concurrency only after measuring real resource usage.

Relevant measurements:

- CPU utilization,
- memory pressure,
- disk I/O,
- test duration,
- container startup time,
- machine responsiveness,
- thermal throttling.

The point at which CI meaningfully interferes with daily development is one of the signals that moving the system to dedicated hardware is justified.

---

## Migration to a Dedicated Server

The local architecture should deliberately resemble the future server architecture.

Local:

```text
Mac
 ├── development repo
 ├── bare Git repo
 ├── scheduler
 ├── queue
 ├── SQLite
 ├── containers
 └── dashboard
```

Future:

```text
Mac
 └── git push ci ...

Home server
 ├── bare Git repo
 ├── scheduler
 ├── queue
 ├── database
 ├── containers
 └── dashboard

Access:
 ├── SSH
 └── private VPN
```

Ideally, moving to the server should mainly require changing the `ci` Git remote and deployment configuration rather than redesigning the application.

---



## Post-Promotion Develop Reset

After a validated `develop -> main` promotion is successfully pushed to GitHub, Local CI should offer an explicit post-promotion action to reset `develop` to the newly promoted `main`.

```text
BEFORE

main:     A--------------M
           \            /
develop:    B--C--D-----/

AFTER

main:                     M
                          ^
develop:                  M
```

This keeps `develop` and `main` aligned after a release and avoids carrying unnecessary branch-history divergence into future promotions.

### User interaction

The reset must not happen silently. After successfully pushing `main`, the dashboard should offer an explicit action such as:

```text
Promotion complete.

main is now abc123.
develop still points to def456.

Reset develop to the newly promoted main?

[Reset develop -> main]   [Not now]
```

### Concurrency guard

Local CI must remember the GitHub `develop` SHA involved in the promotion. Before resetting, it must fetch GitHub again and verify that `origin/develop` still points to that exact SHA.

```text
remembered develop = D
new main           = M
        |
        v
fetch GitHub
        |
        v
origin/develop still D?
        |
   yes  +--> reset local develop to M
        |    update GitHub develop to M
        |
        no
        v
STOP: develop changed since promotion
```

If another developer has merged or pushed changes into GitHub `develop`, Local CI must refuse the reset.

### Remote update safety

Updating GitHub `develop` may require a history rewrite. It must use compare-and-swap / `--force-with-lease` semantics rather than an unrestricted force push.

> Reset GitHub `develop` only if it still points to the exact SHA Local CI expects.

Local CI must never use an unconditional force push for this operation.

After a successful reset:

```text
local CI main    = M
local CI develop = M
GitHub main      = M
GitHub develop   = M
```

Any validation based on the previous `develop` state becomes stale. This operation is part of the promotion lifecycle but remains optional and manually authorized.

## CI Git Remote and Repository Registration

Each project using Local CI has two Git remotes with different responsibilities:

```text
origin -> GitHub
ci     -> bare Git repository managed by Local CI
```

The name `ci` is only a conventional Git remote name. Git does not assign any special meaning to it.

### Local-first setup

While Local CI runs on the same machine as the developer repository, the `ci` remote may simply be a filesystem path to the bare repository created and managed by Local CI.

Example:

```text
~/code/
├── my-app/
└── local-ci/
    └── ci/
        └── repos/
            └── my-app.git/
```

The developer repository can register it with:

```bash
git remote add ci /absolute/path/to/local-ci/ci/repos/my-app.git
```

Then:

```bash
git push ci feature/foo
```

pushes the branch into the Local CI bare repository. Its `post-receive` hook notifies the scheduler, which creates and queues the appropriate validation candidate.

Conceptually:

```text
working repository
       |
       | git push ci feature/foo
       v
Local CI bare repository
       |
       | post-receive
       v
scheduler
       |
       v
validation candidate
```

### Setup UX

Users should not need to discover or construct the CI remote URL manually.

When a repository is registered, Local CI should display the exact command needed to connect the working repository.

Example:

```text
Repository registered successfully.

CI remote:
/Users/user/local-ci/ci/repos/my-app.git

Add it to your project:

git remote add ci /Users/user/local-ci/ci/repos/my-app.git
```

The setup script and/or dashboard should expose this value and make it easy to copy.

### Future dedicated-server setup

When Local CI moves to another machine, the same Git interface remains in place. Only the remote URL changes.

For example:

```bash
git remote set-url ci ci@local-ci:/srv/local-ci/repos/my-app.git
```

or:

```bash
git remote set-url ci ssh://ci@192.168.1.50/srv/local-ci/repos/my-app.git
```

The developer workflow remains:

```bash
git push ci feature/foo
```

but transport changes from a local filesystem operation to Git over SSH.

```text
TODAY

git push ci
    |
    v
local filesystem
    |
    v
bare repository


FUTURE

git push ci
    |
    v
SSH / private network
    |
    v
home server
    |
    v
bare repository
```

This allows the Git ingress interface to remain stable as Local CI moves from the development machine to dedicated hardware.

### Expected repository configuration

A typical project should eventually look like:

```text
origin  git@github.com:organization/my-app.git
ci      ci@local-ci:/srv/local-ci/repos/my-app.git
```

`origin` remains the shared GitHub repository used by the team. `ci` is the Local CI ingress repository used to submit branches for local validation and promotion.

## Maximum Branch Drift Before Merge

Local CI must prevent a PR/candidate from being merged when its source branch is too far behind the current target branch.

### V1 policy

The maximum allowed drift is **10 commits behind the target branch**.

If a source branch is more than 10 commits behind its target, Local CI must not allow it to enter the normal merge/promotion path until the branch has been synchronized with the target.

```text
PR branch
    |
    | compare with current target
    v
commits behind target
    |
    +-- 0-10  -> eligible for validation/merge
    |
    +-- >10   -> BLOCKED: sync/rebase required
```

Example:

```text
PR #42
Target: develop
Behind by: 14 commits

Status: SYNC REQUIRED

This branch is more than 10 commits behind develop.
Sync/rebase it with the current target before it can be merged.
```

### Sync/rebase action

When the threshold is exceeded, the dashboard should expose a clear `Sync/Rebase with target` action.

The purpose of this action is to bring the source branch onto the current target branch so that subsequent validation occurs against a reasonably current branch history.

The synchronization operation must be explicit. Local CI must not silently rewrite a developer branch merely because it crossed the drift threshold.

After synchronization/rebase:

```text
source branch
      |
      v
current target incorporated
      |
      v
behind count returns to 0
      |
      v
previous validation becomes stale
      |
      v
full CI validation required
```

Because rebasing rewrites the source branch history, the source SHA changes. Any candidate or successful validation associated with the previous source SHA must therefore be invalidated.

### Merge guard

The merge button must remain disabled when:

```text
commitsBehindTarget > 10
```

even if an older candidate previously passed CI.

The merge invariant becomes:

> A PR may be merged only when its exact candidate has passed the required CI suite against the current target SHA, its source SHA has not changed, its target SHA has not changed, and the source branch is no more than 10 commits behind the target branch.

### Dashboard visibility

For every PR/candidate, Local CI should display the branch drift explicitly:

```text
PR #42
Source SHA:         a1b2c3
Current develop:    f8e9d0
Behind by:          7 commits
Validated against:  f8e9d0
Status:             READY
```

or:

```text
PR #43
Source SHA:         112233
Current develop:    f8e9d0
Behind by:          14 commits
Status:             SYNC REQUIRED
```

The 10-commit limit is the V1 policy and should be represented as a configurable policy value internally rather than scattered as a magic number throughout the codebase.

## GitHub Synchronization and Divergence

Local CI operates alongside normal GitHub development. Other developers may continue pushing branches to GitHub, opening PRs against `develop`, and merging there. Therefore GitHub's `develop` can change independently from Local CI.

### Authority and synchronization

GitHub `develop` is the authoritative shared branch for synchronization. Before Local CI creates or validates a merge candidate, it must fetch GitHub and compare local CI `develop` with `origin/develop`.

```text
SAME
  -> Continue normally.

GITHUB AHEAD
  -> Fast-forward local CI develop to GitHub develop.

LOCAL CI AHEAD
  -> Preserve local commits. They may be a validated promotion
     that has not yet been manually pushed.

DIVERGED
  -> Do not automatically merge, reset, rebase, or force-push.
     Reconcile the histories and revalidate the resulting candidate.
```

Automatic synchronization must be **fast-forward-only** and must never manufacture an automatic merge commit.

### Divergence

Divergence can legitimately happen when Local CI has validated and manually merged `C`, but it has not yet been pushed, while another developer merges `D` into GitHub:

```text
             C  <- Local CI develop
            /
A -- B
     \
      D          <- GitHub develop
```

Local CI must treat this as a first-class `diverged` state. The previously validated local state cannot simply be pushed because it was validated against an older base.

Local CI must reconcile the latest GitHub state with the pending local changes, create a new candidate, and run the complete required CI suite again:

```text
GitHub develop D
       +
pending local C
       ↓
reconciliation candidate E
       ↓
full CI validation
       ↓
eligible for manual promotion only if it passes
```

### GitHub-aware validation invariant

> A candidate is valid only if its exact merge result was validated against the latest known GitHub `develop`, and the relevant source and target SHAs have not changed.

Before validation:

```text
fetch GitHub
    ↓
compare origin/develop with local CI develop
    ↓
same       -> continue
GH ahead   -> fast-forward local develop, then continue
CI ahead   -> preserve pending local promotion
diverged   -> reconcile and revalidate
```

A change to the relevant base SHA makes previous validation stale.

### Recheck immediately before pushing

Local CI must fetch GitHub again immediately before a manual push. If GitHub `develop` changed after validation began, the validation is stale and Local CI must synchronize/reconcile and revalidate before promotion.

A successful test run never authorizes overwriting a GitHub branch that changed after the run began.

### Synchronization safety rules

- Fetching GitHub may happen automatically.
- Local CI may automatically fast-forward local refs when GitHub is strictly ahead and no local commits would be lost.
- Synchronization must not silently create merge commits.
- Local CI must not automatically rebase developer branches.
- Local CI must not automatically reset away validated local commits.
- Local CI must not force-push `develop` or `main`.
- Divergence must be explicit and must trigger reconciliation and revalidation.
- Pushing to GitHub remains an explicit manual action.


## Chosen Technology Stack

Keep the implementation intentionally simple and close to familiar technologies so the learning focus stays on Git, CI/CD, Docker, queues, isolation, and failure handling rather than on learning an unrelated application stack.

### Backend / Scheduler

- Node.js
- TypeScript
- Fastify for the HTTP API
- Native `git` commands for repository operations
- Docker Engine API for creating and destroying runner/service containers
- SQLite for scheduler state
- Drizzle ORM for database access

The scheduler should use a simple DB-backed queue in SQLite for V1.

Do not introduce Redis, RabbitMQ, Temporal, or another external queue unless there is a demonstrated need.

### Frontend

- React
- TypeScript
- Material UI

The dashboard communicates with the Fastify API and exposes run state, queue state, logs, validation state, and manual merge/push actions.

### Workflow Execution

Use the repository's existing `.github/workflows/*.yml` files as the source of truth.

For V1, use `act` as the GitHub Actions-compatible execution engine rather than implementing a GitHub Actions interpreter from scratch.

Conceptually:

```text
.github/workflows/*.yml
          |
          v
         act
          |
          v
runner/service containers
```

`act` is an implementation detail behind a workflow-runner abstraction so it can be replaced later if its GitHub Actions compatibility becomes limiting.

Conceptual interface:

```ts
interface WorkflowRunner {
  run(input: RunRequest): Promise<RunResult>
}
```

The scheduler should depend on this abstraction rather than directly embedding `act` behavior throughout the codebase.

### Packaging

Use Docker Compose to run the long-lived local system components.

Conceptually:

```text
React dashboard
      |
      v
Fastify API / Scheduler
      |
      +--> SQLite
      |
      +--> Git operations
      |
      +--> DB-backed queue
      |
      +--> Docker Engine API
              |
              +--> ephemeral runner
              +--> ephemeral Postgres
              +--> ephemeral OpenSearch
              +--> other per-run services
```

### Explicit V1 stack non-goals

Do not introduce the following unless the current architecture demonstrably requires them:

- Go services,
- PostgreSQL for scheduler state,
- Redis,
- RabbitMQ,
- Temporal,
- Kubernetes,
- custom GitHub Actions YAML interpreter.

The goal is to keep infrastructure minimal until real constraints justify additional components.

## Non-Goals for the Initial Version

Do not initially build:

- a complete GitHub replacement,
- issue tracking,
- code review UI,
- user/org management,
- public repository hosting,
- highly available infrastructure,
- distributed runners,
- Kubernetes,
- complex authentication,
- autoscaling,
- AI-based test selection,
- AI-based merge decisions,
- scheduler-owned test-selection logic,
- dependency-graph-based selective testing in V1,
- automatic PR rebasing/updating,
- speculative merge trains,
- Docker-in-Docker,
- a separate CLI.

These can be explored later only if a real need appears.

---

## Initial MVP

The first useful milestone should support this complete flow:

```text
1. Developer/agent changes code in a branch
2. `git push ci feature/foo`
3. Bare Git repo receives push
4. `post-receive` notifies scheduler
5. Scheduler creates a run
6. Run enters queue
7. Scheduler starts an isolated container
8. Container checks out exact SHA
9. Runner executes the repository's existing GitHub Actions workflow
10. The complete required test suite runs
11. Result is persisted
12. Dashboard displays result
```

Then add:

```text
13. Candidate enters merge queue for `develop`
14. Scheduler creates a temporary merge candidate against the current `develop` SHA
15. Runner executes the complete required workflow against that exact candidate
16. If PASS -> candidate becomes ready for manual merge
17. User explicitly clicks "Merge to develop"
18. `develop` advances to the exact validated merge result
19. Other validations against the previous `develop` SHA become stale
20. If FAIL -> `develop` remains unchanged
```

Then add:

```text
21. Healthy `develop` can be validated for promotion to `main`
22. User explicitly clicks "Merge to main"
23. User explicitly clicks "Push main to GitHub" when ready to deploy
```

---

## Success Criteria

The project is successful when:

- multiple development agents can work independently,
- they can push candidate branches to the local CI system,
- tests execute without interfering with local development state,
- `develop` cannot silently become broken,
- integration failures are caught before merge by testing the exact temporary merge result,
- production cannot advance from a broken state,
- no branch promotion or GitHub push happens without explicit user approval,
- PR branches are not rewritten merely because `develop` advanced,
- stale validations are detected from exact source/target SHAs,
- all runs are inspectable,
- failures are reproducible,
- the system survives restarts without losing important state,
- running the workflow no longer depends on GitHub Actions minutes.

The system should be useful before it becomes sophisticated.
# Autonomous integration amendment (27 September 2026)

This section is the current contract. It supersedes any conflicting manual merge, post-merge full rerun, and promotion wording later in this document. The later sections preserve the original design history and its still-applicable safety constraints.

## Agent handoff

Each agent works in its own Git worktree and pushes a feature branch to its repository's local `ci` remote. The branch name is the task identifier unless a richer task registry is added later. A GitHub PR is optional for discussion or an audit trail; it is not the local CI gate. `git push ci feat/task` creates a temporary merge of that branch tip with the latest local `develop` and runs the applicable `.local-ci/workflows` PR checks on the exact merge commit. GitHub workflows are a fallback only when the local directory is absent.

The scheduler records the individual YAML files selected for the run. Each has a queued, running, passed, failed, or canceled state, exit code, and filtered logs. Agents can poll the run or use `scripts/ci-wait.mjs` and repair their own failures. Local CI does not presume it can resume or send messages to a suspended agent process.

## Serial integration

Run one resource-intensive test suite at a time across connected repositories. A failed run stays failed and the queue continues. A newer push on the same branch supersedes its older queued/passed result. Before integrating a passed run, check that the branch tip and `develop` still match the tested head/base. An exact compare-and-swap advances local `develop` to the tested merge commit; no click or duplicate full-suite run is required. If the base moved, rebuild the temporary merge and retest the unchanged agent branch. Never silently rewrite a feature branch. A conflict or failed test stays out of `develop` and is reported to the owning task.

An optional `.local-ci/workflows/develop-smoke.yml` with `on: push` for `develop` may run a short health check immediately after integration. It takes priority over waiting candidates and pauses further integration and staging pushes. If it fails, roll local `develop` back only when it still points to that exact candidate SHA; mark the candidate defective. If the ref moved, block integration and require explicit recovery. A project with no smoke workflow has no automatic runtime health/rollback signal; its passing candidate checks are its only local gate.

## Manual staging and production

The user decides when to send staging and production snapshots to GitHub. Push develop to GitHub sends an exact tested local SHA while briefly freezing local integration for that repository. A push failure must not advance the GitHub branch silently. GitHub synchronization and divergence checks remain mandatory.

Selecting Validate develop → main starts a durable, per-repository promotion freeze. Record the `develop` SHA before validating; feature pushes can queue but cannot integrate. Only the tested snapshot may be pushed to GitHub main. After main is pushed, offer Reset develop → main or Release promotion. The reset checks the remembered GitHub and local SHAs, uses a remote force-with-lease and a local compare-and-swap, and can resume after a crash between the remote and local updates. Conflicting state blocks automatic integration. Releasing without reset expires that reset opportunity before newer candidates integrate. Once the freeze ends, waiting candidates are rebuilt and retested against the current `develop`. Other repositories continue throughout.

Promotion, GitHub staging push, GitHub main push, and the post-promotion reset remain manual. Automatic integration only changes **local** develop.

## Verification boundary

The scheduler must be tested with real Git/SQLite races and fake `act` workflow events, then accepted on the intended Docker host with each connected repository's actual workflows, including any service containers and browser jobs they use. Passing YAML checks does not establish product correctness or production health. Do not remove existing hosted checks until those real runs and the recovery drills pass.

---
