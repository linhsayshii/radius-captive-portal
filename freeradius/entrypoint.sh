#!/bin/sh
set -eu

# Debian's stock clients.conf does not automatically include clients.d. Replace
# the container-local client list at boot so every RADIUS_CLIENTS entry is
# actually loaded by FreeRADIUS.
client_file=/etc/freeradius/3.0/clients.conf
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
