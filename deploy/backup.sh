#!/usr/bin/env bash
# Saves the only data the site keeps (ratings and feedback) to ~/backups.
#     bash deploy/backup.sh
# Copy the file it makes to your PC now and then, for example with:
#     scp -i your-key.key ubuntu@SERVER_IP:~/backups/feedback-*.tar.gz .
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
mkdir -p "$HOME/backups"
STAMP="$(date +%Y-%m-%d)"
CONTAINER="$(docker compose ps -q app)"
if [ -z "$CONTAINER" ]; then
  echo "The app isn't running, so there is nothing to back up."
  exit 1
fi
docker run --rm --volumes-from "$CONTAINER" -v "$HOME/backups:/backup" alpine \
  tar czf "/backup/feedback-$STAMP.tar.gz" -C /app data
# Keep the newest 12 backups.
ls -1t "$HOME/backups"/feedback-*.tar.gz | tail -n +13 | xargs -r rm --
echo "Saved $HOME/backups/feedback-$STAMP.tar.gz"
