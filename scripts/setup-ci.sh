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

if [ -d "$sample/.git" ]; then
  git -C "$sample" remote remove ci >/dev/null 2>&1 || true
  git -C "$sample" remote add ci "$bare"
fi

echo "ci remote: $bare"
