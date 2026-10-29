#!/usr/bin/env bash
# Open a shell inside a running service of the forvia-core dev stack.
#   ./attach.sh            → core-api
#   ./attach.sh db         → psql on the database
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="${1:-core-api}"

compose() {
    "$SCRIPT_DIR/run.sh" "$@"
}

if ! compose ps --status running --services | grep -qx "$SERVICE"; then
    echo "Service '$SERVICE' is not running. Start the stack with ./run.sh first." >&2
    exit 1
fi

if [ "$SERVICE" = "db" ]; then
    compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
else
    compose exec "$SERVICE" sh
fi
