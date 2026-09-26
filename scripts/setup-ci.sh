#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
bare="$root/ci/repos/sample-app.git"
sample="$root/sample-app"

mkdir -p "$root/ci/repos"
if [ ! -d "$bare/hooks" ]; then
  git init --bare -b main "$bare"
fi
cp "$root/scheduler/hooks/post-receive" "$bare/hooks/post-receive"
chmod +x "$bare/hooks/post-receive"
cp "$root/scheduler/hooks/pre-receive" "$bare/hooks/pre-receive"
chmod +x "$bare/hooks/pre-receive"

github="${1:-}"

if [ -d "$sample/.git" ]; then
  git -C "$sample" remote remove ci >/dev/null 2>&1 || true
  git -C "$sample" remote add ci "$bare"
  if [ -z "$github" ]; then
    github=$(git -C "$sample" remote get-url origin 2>/dev/null || true)
  fi
fi

if [ -n "$github" ]; then
  if git --git-dir="$bare" remote get-url origin >/dev/null 2>&1; then
    git --git-dir="$bare" remote set-url origin "$github"
  else
    git --git-dir="$bare" remote add origin "$github"
  fi
fi

if ! git --git-dir="$bare" show-ref --verify --quiet refs/heads/main; then
  if [ -d "$sample/.git" ] && git -C "$sample" show-ref --verify --quiet refs/heads/main; then
    git --git-dir="$bare" fetch "$sample" '+refs/heads/main:refs/heads/main'
  fi
fi

if ! git --git-dir="$bare" show-ref --verify --quiet refs/heads/develop; then
  if git --git-dir="$bare" show-ref --verify --quiet refs/heads/main; then
    git --git-dir="$bare" update-ref refs/heads/develop refs/heads/main
  else
    tip=$(git --git-dir="$bare" for-each-ref --format='%(objectname)' --count=1 refs/heads)
    if [ -n "$tip" ]; then
      git --git-dir="$bare" update-ref refs/heads/develop "$tip"
    fi
  fi
fi

echo "ci remote: $bare"
if [ -n "$github" ]; then
  echo "github: $github"
else
  echo "github: not set. Open http://127.0.0.1:5173 and save the GitHub remote."
fi
