#!/bin/bash
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-4321}"
exec /usr/bin/node ./dist/server/entry.mjs
