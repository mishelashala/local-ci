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
