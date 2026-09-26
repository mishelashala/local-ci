# local-ci

Local CI for one app. GitHub stays the remote. This scheduler runs the tests and moves `develop` and `main` only when you click.

## First time

1. Start the two servers, from the repo root:

```bash
npm install --prefix scheduler && npm run dev --prefix scheduler
```

```bash
npm install --prefix dashboard && npm run dev --prefix dashboard
```

2. Turn `sample-app` into its own git repo if this is a fresh clone, then register the local bare repo:

```bash
cd sample-app
git init -b main
git add .
git commit -m "Initial sample app"
cd ..
./scripts/setup-ci.sh
```

`./scripts/setup-ci.sh` creates `ci/repos/sample-app.git`, installs the hooks, and creates local `main` and `develop` if they are missing. Direct pushes to `develop` and `main` are rejected. Those refs move only from the dashboard.

3. Open `http://127.0.0.1:5173`. If GitHub is not set yet, the page asks for the remote. Paste `git@github.com:you/sample-app.git` and click **Save remote**. That is where **Push to develop** and **Push main to GitHub** send commits.

## Tomorrow

1. In `sample-app`: `git push ci feat/branch-name`
2. The scheduler tests the merge of that branch into current `develop`.
3. When the row is `passed`, click **Merge to develop**. Local `develop` becomes that commit.
4. Click **Push to develop**. That sends local `develop` to GitHub `develop`.
5. Click **PR develop → main**. That runs the tests for merging `develop` into `main`.
6. When that row passes, click **Push main to GitHub**. That sends the tested commit to GitHub `main` and moves local `main` to the same commit.

One test at a time. A failed run leaves `develop` and `main` where they were.

## What is not built

Containers, and running the workflow file with `act`. The runner executes `npm ci` and `npm test`. Restarting the scheduler marks an in-flight run `failed`.
