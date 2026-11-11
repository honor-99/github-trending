#!/usr/bin/env bash
# 提交并推送快照数据；无变化时静默跳过（幂等，可反复跑）。
# cron 环境用：env -i HOME=$HOME PATH=/usr/local/bin:/usr/bin:/bin
set -euo pipefail

REPO="${REPO:-$HOME/projects/github-trending}"
BRANCH="${BRANCH:-master}"
cd "$REPO"

git add data
if git diff --cached --quiet; then
  echo "[publish] 数据无变化，跳过提交"
  exit 0
fi

git commit -q -m "data: snapshot $(date +%Y-%m-%d)"
git push -q origin "HEAD:${BRANCH}"
echo "[publish] 已推送 $(git rev-parse --short HEAD) → ${BRANCH}"
