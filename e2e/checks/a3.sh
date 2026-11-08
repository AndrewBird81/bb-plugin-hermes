#!/bin/bash
# A3 on the isolated bb + strict fake: an approval that times out (or is answered elsewhere) closes its card by itself; the next message runs.
# usage: a3.sh <thread> timeout|elsewhere
cd "$(dirname "$0")/../.."
T=$1; MODE=$2
S=$(sqlite3 -readonly ~/.bb-hermes-e2e/plugins/hermes/data.db "select session_id from bindings where thread_id='$T'")
TO=8; [ "$MODE" = elsewhere ] && TO=120
e2e/fake-ctl.sh nextTurn '{"profile":"alex","script":{"tool":true,"approval":{"timeout_s":'$TO'}}}' >/dev/null
e2e/sbb thread tell $T "approval $MODE" | tail -1
sleep 4
[ -z "$S" ] && S=$(sqlite3 -readonly ~/.bb-hermes-e2e/plugins/hermes/data.db "select session_id from bindings where thread_id='$T'")
I=$(e2e/sbb thread interactions list $T | awk '/pending/{print $1}' | head -1); echo "card $I pending"
if [ "$MODE" = elsewhere ]; then
  P=$(e2e/fake-ctl.sh session '{"profile":"alex","session_id":"'$S'"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).prompts[0].prompt_id))')
  e2e/fake-ctl.sh answerElsewhere '{"profile":"alex","session_id":"'$S'","prompt_id":"'$P'","answer":"deny"}'; echo
fi
t0=$(date +%s)
for i in $(seq 1 40); do st=$(e2e/sbb thread interactions show $I $T 2>&1 | awk '/Status:/{print $2}'); [ "$st" != pending ] && break; sleep 1; done
echo "card $st after $(( $(date +%s) - t0 ))s: $(e2e/sbb thread interactions show $I $T 2>&1 | grep -E 'Reason|Resolution' | tr -s ' ' | tr '\n' ' ')"
e2e/sbb thread tell $T "next message after $MODE" | tail -1
e2e/sbb thread wait $T --timeout 30 | tail -1
e2e/sbb thread log $T | tail -1
