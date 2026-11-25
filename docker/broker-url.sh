#!/bin/sh
# Points the browsers at $BROKER_URL, e.g. wss://user:pass@broker.example.com/mqtt
set -eu

[ -n "${BROKER_URL:-}" ] || exit 0
printf 'export default { brokers: { default: "%s" } };\n' "$BROKER_URL" > /usr/share/nginx/html/js/config.js
