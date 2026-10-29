#!/usr/bin/env bash
# Build and start the forvia-core dev stack, then follow the logs. Ctrl+C stops the
# containers (they are kept, so the next run is fast; `./run.sh down` removes them).
# Extra arguments are passed straight to `docker compose`, e.g. `./run.sh ps`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

compose() {
    local env_args=()
    [ -f "$ROOT_DIR/.env" ] && env_args=(--env-file "$ROOT_DIR/.env")
    docker compose -f "$SCRIPT_DIR/docker-compose.yml" "${env_args[@]}" "$@"
}

# Shared with the other Forvia repos' dev stacks.
docker network inspect forvia >/dev/null 2>&1 || docker network create forvia >/dev/null

if [ $# -gt 0 ]; then
    compose "$@"
    exit
fi

trap 'echo; echo "Stopping containers..."; compose stop' INT TERM

compose up --build -d
compose logs -f &
wait
