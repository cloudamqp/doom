#!/bin/sh
# Sends a bot into a game that waits for players.
#
#   bin/native-bot.sh <game> [skill] [name]
#
# <game> is the game's address in the browser or the id in it, skill is 1
# (easy) to 5 (hard). $BROKER_URL is the broker's mqtt:// or mqtts:// URL,
# the default is the one of docker compose. Builds the bot first if needed.
#
# The bot takes on new code while it plays: edit doom/src/doom/b_*.c and
# run make -C doom botlib. It tells what it does and how its fights went,
# here and in bot.log.
set -eu

if [ $# -lt 1 ]; then
  sed -n '2,11s/^# \{0,1\}//p' "$0" >&2
  exit 1
fi

root=$(cd "$(dirname "$0")/.." && pwd)
game=$(printf '%s' "$1" | sed -n 's/.*\([0-9a-f]\{12\}\).*/\1/p')
skill=${2:-3}
name=${3:-Bot}

if [ -z "$game" ]; then
  echo "No game id in $1" >&2
  exit 1
fi

make -s -C "$root/doom" native

# Doom writes its settings to the working directory
log=$PWD/bot.log
cd "$(mktemp -d)"
"$root/doom/build/native/doomq-bot" -iwad "$root/web/freedoom1.wad" \
  -broker "${BROKER_URL:-mqtt://guest:guest@localhost:1883}" \
  -game "$game" -connect 1 -pet "$name" -bot "$skill" \
  -botlib "$root/doom/build/native/bot.so" -bottrace 2>&1 | tee "$log"
