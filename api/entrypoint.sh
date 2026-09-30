#!/bin/sh
set -eu

db_file=/data/pool.db
marker=/data/.pool-initialized

if [ -f "$marker" ] && [ ! -s "$db_file" ]; then
  echo 'FATAL: The persisted pool database is missing or empty; refusing to create a replacement.' >&2
  exit 1
fi
if [ -e "${db_file}-wal" ] && [ ! -s "$db_file" ]; then
  echo 'FATAL: SQLite WAL exists without its database; refusing to create a replacement.' >&2
  exit 1
fi

if [ ! -e "$db_file" ]; then
  touch "$db_file"
fi
./node_modules/.bin/prisma migrate deploy
touch "$marker"
exec node dist/server.js
