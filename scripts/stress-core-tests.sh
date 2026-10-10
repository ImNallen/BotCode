#!/usr/bin/env bash
# Runs the bot-core test binaries several times at once so timing assumptions
# that hold on an idle machine fail locally the way they do on CI runners.
#
#   scripts/stress-core-tests.sh [rounds] [copies] [binary-substring] [-- test filter args]
#
# Prints a count of failed tests. Logs stay in $STRESS_OUT (default /tmp/bot-core-stress).
set -u
rounds=${1:-5}
copies=${2:-4}
only=${3:-}
shift $(($# < 3 ? $# : 3))
[ "${1:-}" = "--" ] && shift
out=${STRESS_OUT:-/tmp/bot-core-stress}
root=$(git rev-parse --show-toplevel)
rm -rf "$out" && mkdir -p "$out"
bins=$(cd "$root" && cargo test -p bot-core --locked --no-run --message-format=json 2>/dev/null |
  jq -r 'select(.profile.test == true and .executable != null) | .executable' |
  grep -- "$only")
[ -n "$bins" ] || { echo "no test binaries match '$only'" >&2; exit 2; }
for r in $(seq 1 "$rounds"); do
  for c in $(seq 1 "$copies"); do
    (for b in $bins; do (cd "$root/crates/bot-core" && "$b" "$@" 2>&1); done >"$out/r$r-c$c.log") &
  done
  wait
done
runs=$((rounds * copies))
failures=$(grep -h -- '\.\.\. FAILED$' "$out"/*.log | sed -e 's/^test //' -e 's/ \.\.\. FAILED$//' | sort | uniq -c | sort -rn)
if [ -z "$failures" ]; then
  echo "no failures in $runs runs"
else
  echo "failures in $runs runs:"
  echo "$failures"
  exit 1
fi
