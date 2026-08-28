#!/bin/sh
set -eu

mkdir -p /etc/freeradius/3.0/clients.d
client_file=/etc/freeradius/3.0/clients.d/portal-nas.conf
: > "$client_file"
old_ifs=$IFS
IFS=,
index=0
for address in $RADIUS_CLIENTS; do
  index=$((index + 1))
  trimmed=$(printf '%s' "$address" | tr -d '[:space:]')
  test -n "$trimmed" || continue
  printf 'client nas_%s {\n  ipaddr = %s\n  secret = %s\n}\n' "$index" "$trimmed" "$RADIUS_SHARED_SECRET" >> "$client_file"
done
IFS=$old_ifs

test -s "$client_file" || { echo 'RADIUS_CLIENTS is required'; exit 1; }
exec freeradius -f
