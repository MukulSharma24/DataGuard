#!/bin/bash
# Run this script ONCE after Xcode CLT is installed.
# Usage: bash push_to_github.sh <your-github-pat-token>
# Example: bash push_to_github.sh ghp_xxxxxxxxxxxxxxxxxxxx

set -e

TOKEN=${1:-""}
REPO="https://MukulSharma24:${TOKEN}@github.com/MukulSharma24/DataGuard.git"
DIR="/Users/mukulsharma/Desktop/DataGuard"

echo "==> Setting up git in $DIR"
cd "$DIR"

git init -b main
git config user.email "shajagsystems@gmail.com"
git config user.name "MukulSharma24"

echo "==> Staging files"
git add .
git status --short | head -20
echo "..."

echo "==> Creating initial commit"
git commit -m "feat: initial commit - DataGuard v1.0

- Next.js 14 frontend with Tailwind CSS (Stripe/Linear-inspired UI)
- Express.js backend with PostgreSQL (Supabase) and MongoDB support
- PII scanner with 11 categories and LLM-enhanced classification
- JWT auth, encrypted credentials, full CRUD for sources/profiles/scans
- Data catalogue, data map, logs, and live scan streaming"

echo "==> Pushing to GitHub"
git remote add origin "$REPO" 2>/dev/null || git remote set-url origin "$REPO"
git push -u origin main --force

echo ""
echo "✅ Done! View your repo at: https://github.com/MukulSharma24/DataGuard"
