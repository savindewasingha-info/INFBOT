#!/bin/bash
# Push to GitHub using Personal Access Token
# Usage:
#   export GITHUB_TOKEN=your_github_token
#   bash push_to_github.sh "your commit message"

set -e

REPO="https://github.com/silsava/INFBOT.git"
BRANCH="${GIT_BRANCH:-main}"

if [ -z "$GITHUB_TOKEN" ]; then
  echo "❌ Error: GITHUB_TOKEN environment variable is not set."
  echo "   Set it with:"
  echo "   export GITHUB_TOKEN=your_personal_access_token"
  exit 1
fi

AUTH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/silsava/INFBOT.git"

echo "📦 Staging all changes..."
git add -A

if git diff --cached --quiet; then
  echo "✅ Nothing to commit — working tree clean."
else
  COMMIT_MSG="${1:-Auto push: $(date '+%Y-%m-%d %H:%M:%S')}"

  echo "💬 Committing: $COMMIT_MSG"

  git \
    -c user.email="bot@infinitymd.app" \
    -c user.name="Infinity MD" \
    commit -m "$COMMIT_MSG"
fi

echo "🚀 Pushing to GitHub ($BRANCH)..."

git push "$AUTH_URL" "$BRANCH"

echo "✅ Push completed successfully!"