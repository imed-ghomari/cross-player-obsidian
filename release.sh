#!/usr/bin/env bash
set -e

VERSION="${1:?Usage: ./release.sh <version>}"

npm version "$VERSION" --no-git-tag-version || true
npm run build
git add .
git commit -m "Release $VERSION"
git tag -a "$VERSION" -m "Release $VERSION"
git push origin main
git push origin "$VERSION"
