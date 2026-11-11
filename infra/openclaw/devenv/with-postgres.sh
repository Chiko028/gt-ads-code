#!/usr/bin/env bash
# Startet eine fluechtige PostgreSQL-17-Instanz (nur Unix-Socket, kein TCP, Daten in /tmp), fuehrt den Befehl aus und raeumt auf.
#   with-postgres <befehl> [argumente...]
# Setzt: PGHOST (Socket-Verzeichnis), PGUSER, PGDATABASE=gt_ads_test, GT_ADS_DB_URL (pg-Verbindungszeichenfolge fuer den Socket).
set -Eeuo pipefail
BIN=/usr/lib/postgresql/17/bin
[ "$#" -ge 1 ] || { echo "Verwendung: with-postgres <befehl> [argumente...]" >&2; exit 2; }
DATA="$(mktemp -d /tmp/pgdata.XXXXXX)"; SOCK="$(mktemp -d /tmp/pgsock.XXXXXX)"
cleanup() { "$BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA" "$SOCK"; }
trap cleanup EXIT
"$BIN/initdb" -D "$DATA" -U gtads -A trust -E UTF8 --no-sync >/dev/null
"$BIN/pg_ctl" -D "$DATA" -w -l "$DATA/server.log" start \
  -o "-c listen_addresses='' -c unix_socket_directories=$SOCK -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c shared_buffers=64MB -c max_connections=50" >/dev/null
export PGHOST="$SOCK" PGUSER=gtads PGDATABASE=gt_ads_test
"$BIN/createdb" gt_ads_test
export GT_ADS_DB_URL="postgres://gtads@localhost/gt_ads_test?host=$SOCK"
"$@"
