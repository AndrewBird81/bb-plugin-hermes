#!/bin/sh
# POST a knob to the running strict fake's control endpoint (test/fake-hermes/run.ts): e2e/fake-ctl.sh <op> '<json>'
ctl=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/private/tmp/bb-hermes-test/e2e-bb/fake.json","utf8")).control)')
exec curl -fsS -X POST -H 'content-type: application/json' --data "${2:-{\}}" "$ctl/$1"
