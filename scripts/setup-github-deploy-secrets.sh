#!/usr/bin/env bash
# One-time: create VPS deploy key material + set GitHub Actions secrets.
# Requires: gh auth login (repo + secrets scopes), ssh to dwarf-vps.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${GITHUB_REPO:-jdwd40/footfive}"
KEY_DIR="${KEY_DIR:-$HOME/.ssh}"
KEY_PATH="${KEY_PATH:-$KEY_DIR/footfive_gha_deploy}"
VPS_HOST="${VPS_HOST:-213.165.91.221}"
VPS_PORT="${VPS_PORT:-4020}"
VPS_USER="${VPS_USER:-jd}"
VPS_ALIAS="${VPS_ALIAS:-dwarf-vps}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI required (https://cli.github.com/)"
  exit 1
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
  echo "Run: gh auth login -h github.com -s repo,admin:public_key"
  exit 1
fi

mkdir -p "$KEY_DIR"
if [[ ! -f "$KEY_PATH" ]]; then
  ssh-keygen -t ed25519 -N "" -C "footfive-github-actions-deploy" -f "$KEY_PATH"
  echo "Created $KEY_PATH"
else
  echo "Reusing existing $KEY_PATH"
fi

PUB="$(cat "${KEY_PATH}.pub")"
# Install pubkey on VPS if missing
if ssh -o BatchMode=yes "$VPS_ALIAS" "grep -qxF '$PUB' ~/.ssh/authorized_keys" 2>/dev/null; then
  echo "Public key already on VPS"
else
  ssh -o BatchMode=yes "$VPS_ALIAS" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$PUB' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
  echo "Installed public key on VPS"
fi

# Verify key works
ssh -p "$VPS_PORT" -i "$KEY_PATH" -o IdentitiesOnly=yes -o BatchMode=yes \
  "${VPS_USER}@${VPS_HOST}" 'echo deploy_key_ok'

gh secret set VPS_HOST -R "$REPO" --body "$VPS_HOST"
gh secret set VPS_PORT -R "$REPO" --body "$VPS_PORT"
gh secret set VPS_USER -R "$REPO" --body "$VPS_USER"
gh secret set VPS_SSH_PRIVATE_KEY -R "$REPO" <"$KEY_PATH"

echo "Secrets set on $REPO"
echo "Private key kept at $KEY_PATH (do not commit)"
