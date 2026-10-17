#!/usr/bin/env bash
# Point this repo's git hooks at the versioned scripts/git-hooks directory (`npm run hooks`, once per clone).
# One commit = one new build version (VERSION, BUILD segment bumped by the pre-commit hook). Skip: KNIFE_NO_BUMP=1 git commit ...
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath scripts/git-hooks
chmod +x scripts/git-hooks/pre-commit
echo "hooks installed: core.hooksPath=scripts/git-hooks (pre-commit bumps VERSION)"
