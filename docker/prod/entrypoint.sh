#!/bin/sh
# Starts as root only long enough to hand $DATA_DIR to the unprivileged `node` user, then drops
# to it. Volumes written by the older images (which ran as root) hold root-owned files — the 0600
# session secret and VAPID keys among them — so without this an upgraded container could not
# read its own data. Once everything is owned by `node` the check finds nothing and is a no-op.
set -e

if [ "$(id -u)" = "0" ]; then
    DATA_DIR="${DATA_DIR:-/data}"
    mkdir -p "$DATA_DIR"
    if [ -n "$(find "$DATA_DIR" ! -user node -print -quit)" ]; then
        chown -R node:node "$DATA_DIR"
    fi
    exec su-exec node "$@"
fi

exec "$@"
