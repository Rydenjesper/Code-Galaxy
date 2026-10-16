#!/usr/bin/env bash
# Publish the files in <dir> as the only content of <branch> in <remote>.
# The branch is a single orphan commit, force-pushed every run: no history piles up,
# and nothing lands on the default branch (so no commit loops).
# Usage: publish.sh <dir> <remote-url> <branch> <source-sha>
set -euo pipefail

dir="$1"
remote="$2"
branch="$3"
sha="${4:-unknown}"

cd "$dir"
rm -rf .git
git init --quiet
git checkout --quiet --orphan "$branch"
git add -A
git -c user.name="code-galaxy" -c user.email="code-galaxy@users.noreply.github.com" \
  commit --quiet -m "Galaxy for ${sha:0:7}"
git push --quiet --force "$remote" "HEAD:refs/heads/$branch"
echo "Published $(ls | tr '\n' ' ')to branch '$branch'"
