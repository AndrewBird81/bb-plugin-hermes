## Verdict
- **Not ship-ready.** The phases and tests are in good shape, but the plan can't yet get the build onto live bb or keep it updated there, and P0 and the drift check can't pass as written.
- **Biggest problem:** release and rollback (04 §Release and install, §Rollback). bb's git install fetches the repo over plain https as the bb server's own user. Reinstalling at a new tag is refused. A Git install has no in-place downgrade. A private repo will probably fail on the remote server unless that server's git user has GitHub credentials.
- **Confidence:** high on the six Must-fix items. Each was checked in bb 0.48.1 server source or docs, the Hermes source at `c314285f07`, or the spike notes. Medium on items marked SUSPECTED.

## Must fix

- **M1. Live bb can't install from a private repo as planned.** (04 §Release and install step 4) VERIFIED mechanism; SUSPECTED that the repo is private and that the server lacks credentials.
  - Fails if: the bb service user on the Linux server has no git credential for `https://github.com`.
  - Evidence:
    - bb 0.48.1 `start-server.js:207388-207410` turns `git:github.com/X/Y` into `https://github.com/X/Y`.
    - `runInstallCommand` (`:207716`) runs plain `git ls-remote` / `git clone` with `env: process.env`.
    - bb's GitHub credential helper and `GH_TOKEN` (`:63150-63215`, `machine-git`) are added only to thread environments. Plugin installs don't get them.
    - SSH URLs aren't accepted: `git@github.com:…` becomes an invalid `https://git@github.com:…` URL.
    - Local `.git/config` origin is `git@github.com:AndrewBird81/bb-plugin-hermes.git`, so the repo exists. That also resolves the plan's "ASSUMED; confirm at T0.1".
    - The bb guide (`distribution.md`) says nothing about auth.
  - Fix:
    - Add a P0 step: as the bb service user on the server, `git ls-remote https://github.com/AndrewBird81/bb-plugin-hermes` must list refs.
    - If it doesn't, the user chooses (Q1): a read-only, single-repo, fine-grained token in that user's git credential store, or `gh auth setup-git`. The server already has `gh` logged in, per code-review-workspace `docs/operations.md` "Git and gh run on the BB server".
    - `bb plugin outdated` and `bb plugin update` need the same credential.

- **M2. Release, update and rollback don't work as planned.** (04 §Release step 4, §Rollback "reinstall the previous tag … older build still reads the db") VERIFIED.
  - Fails if: bb refuses a second install of the same plugin, or pins exact tags. It does both.
  - Evidence:
    - `distribution.md`: "installing an already-installed managed plugin again is refused"; ranges are what `bb plugin update` moves along.
    - The user's own plugin docs (code-review-workspace `docs/guide.md:53`, `docs/operations.md`):
      - "exact tags are pinned and do not receive automatic updates";
      - "BB has no downgrade in place for a Git install: remove the plugin (which deletes its settings…)";
      - changing the source "requires removing the old source first, which can clear plugin data".
    - Losing `data.db` loses every binding. A re-import then duplicates provider handles, and the newer threads become 409 orphans (S1-S3 fact 4).
  - Fix:
    - First live install from a range, permanently: `bb plugin install git:github.com/AndrewBird81/bb-plugin-hermes@^0 --yes`, with tags `v0.x.y`.
    - Updates: `bb plugin update hermes`, then `stopHosted`. Its snapshot and auto-restore of `data.db` on a failed activation covers broken migrations (operations.md §Backups).
    - Rollback = roll forward (revert, then a new patch tag). Kill switch = `bb plugin disable hermes`. Never `remove` or `uninstall` without a `VACUUM INTO` copy of `data.db`.
    - Drop the "older build reads the db" claim; there is no downgrade.
    - SUSPECTED, worth a P0 check: whether `bb plugin update` swaps the worker like `bb plugin reload` does (S7 §7 tested only `reload` on a local path).

- **M3. E2E can silently drive live Hermes.** (03 §5 last bullet, §6 step 6: `HERMES_BB_ROOT_HOME`, "default `~/.hermes`") VERIFIED.
  - Fails if: the env var doesn't reach the host worker or the bridges. Everything then falls back to the live `~/.hermes/gateway.sock`.
    - P1 e2e's first message then runs a real `session.create` on live Hermes.
    - P2's state sync then sends `mutate` to live sessions.
  - Evidence:
    - S7 §6: `experimental_retainWorker` "not run (there is no way to set worker env here)".
    - The spike avoided env and used files and RPC instead: `spike-bb/src/s7-config.ts` reads `~/.bb-spike-logs/s7.json`; the socket path went through `ensureWatch({socketPath})`.
  - Fix:
    - Select the Hermes root with a server plugin setting, passed in host RPC (`ensureWatch({root})`) and in the bridge's provider options.
    - An install with no setting reports health `unconfigured` and makes no Hermes calls.
    - E2E asserts `diagnostics.instance_id` equals the fake's before step 7.

- **M4. The drift check has no venue and no trigger.** (03 §9 "Daily on $HERMES_HOST, after the canary update (bb automation)"; P0 exit criterion; R1 detection) VERIFIED.
  - Fails if: bb script automations run off $HERMES_HOST, or Hermes doesn't update itself daily. Both are true.
  - Evidence:
    - `automations/SKILL.md`: "Scripts run on the bb server". That box can't read `~/.hermes/hermes-agent` or `gateway.sock`.
    - `hermes-host/README.md` §Upgrading: updates are a manual `hermes update`. There is no scheduled updater.
  - Fix:
    - The host worker runs the check on connect whenever `runtime.describe` version or `instance_id` changes. The result goes to health and `bb.log`.
    - Keep `npm run contract:check` as a manual step before `hermes update`.
    - Run the Python-symbol part read-only with `~/.hermes/hermes-agent/venv/bin/python -I -c 'import inspect, …'`.
    - Change the P0 exit criterion to "drift result shown in health".

- **M5. The `bb_tools` install isn't pinned, and the private repo will fail on $HERMES_HOST.** (04 §Release step 5) VERIFIED.
  - Fails if: `#hermes-plugin/bb_tools` is read as a ref (it's a subdirectory), or private access works through https without a credential (it doesn't).
  - Evidence:
    - `hermes_cli/plugins_cmd.py:318-333`: `#` is the subdirectory, and `owner/repo` becomes `https://github.com/…`.
    - The clone-failure text tells the user to `gh auth login` or put `GITHUB_TOKEN` in `.env`. That would add a credential to Hermes, against D1's spirit.
    - `subcommands/plugins.py:27-29` has `--ref COMMIT_SHA` and `--no-enable` / `--enable`. The plan uses neither.
    - `hermes plugins update` follows the branch, so `bb_tools` drifts from the `bindings.json` format the worker writes.
  - Fix:
    - Install: `hermes -p <p> plugins install git@github.com:AndrewBird81/bb-plugin-hermes.git#hermes-plugin/bb_tools --ref <release sha> --no-enable`, then `hermes -p <p> plugins enable bb_tools`.
    - Update: the same command with `--force --ref <new sha>`.
    - `bindings.json` gets a `schema_version`; `bb_tools` returns `tool_error` on a mismatch.
    - SUSPECTED: $HERMES_HOST's SSH key works for this same-UID gateway user. Check with `git ls-remote git@github.com:AndrewBird81/bb-plugin-hermes.git`.

- **M6. Hermes plugin tests have nowhere safe to run.** (03 §8 "pytest") VERIFIED.
  - Fails if: pytest has to be installed into the Hermes venv. The venv has no pytest (site-packages listing), and hermes-webui shares it (hermes-host README).
  - Fix:
    - Use a separate venv (`hermes-plugin/.venv`) with stubs for `gateway.session_ingress`, `gateway.session_context` and `ctx`.
    - Check the real symbols only through the drift check and the isolated-Hermes load.
    - Never `pip install` into `~/.hermes/hermes-agent/venv`.

## Should fix

- **S1. Observability is spread across the risk register and owned by no task.** (05 R1, R4, R5, R6, R11, R19 "in health/logs"; 02 §flows 16.4 "build id in `initialize` logs"; F12 health row) VERIFIED; SUSPECTED where bridge logs land.
  - `bb plugin logs` shows server `bb.log` (`backend-foundation.md:41`). Bridge and worker run on $HERMES_HOST; their log location isn't documented.
  - Fix: one server RPC `diagnostics`, built in T0.7/T0.8 and grown each phase:
    - build ids for server, worker and bridges; worker pid and uptime; watch state;
    - last reconcile; outbox depth and oldest entry; import queue; bindings by state;
    - hosted count; duplicate-binding query; drift result; last errors (ids only).
  - Every gate runs `bb plugin rpc call hermes diagnostics`.

- **S2. Interrupted imports aren't recoverable.** (02 flow 3: binding `replaying` is inserted before spawn; the queue lives in memory) VERIFIED gap.
  - $HERMES_HOST sleep, a bb update or a plugin update mid-import leaves a hidden, half-replayed thread.
  - Fix: store `replayed_index`. On start, resume any `replaying` binding from that index, or delete the hidden thread and the binding. Add a fake test that kills the server mid-import.

- **S3. Mapping-db migrations are untested.** (T0.5 "additive only") VERIFIED.
  - Fix:
    - Run migrations in one transaction at load, so a failed update restores via bb's snapshot.
    - Unit-test upgrading a db built by each earlier release's migrations.
    - `VACUUM INTO` a copy before the first live import.

- **S4. The work breakdown doesn't match its own graph.** (04 §Work breakdown) VERIFIED.
  - Critical path is wrong. T3.1 depends on T2.2, not T2.4. The path leaves out T0.1→T0.2 and T0.4. The real path is roughly T0.1→T0.3→T0.4→T1.1→T1.5b→T1.6→T1.11→T2.3→T2.4→T2.9→T3.x. Phase gates also serialize the phases; say so.
  - Nine tasks span two or more seams, against D14: T1.6, T1.9, T2.5, T2.7, T2.8, T3.2, T4.2, T5.2, T5.4. Split each per seam; the lead lands the contract change first.
  - Fixtures have no recording task ahead of the code that uses them: gateway restart before T1.8, compression before T2.8, subagent before T2.7, Conduit before T3.3. Add e2e tasks T1.0 and T2.0.

- **S5. The fake Hermes is looser than live Hermes.** (03 §5) VERIFIED.
  - `gateway-contract.openrpc.json` uses `additionalProperties:false`, and live refuses unknown keys (08 §1). The spike `fake-gateway.ts` accepts any params.
  - Fix: the fake validates every request against a vendored copy of the contract; the drift check diffs that copy against the live checkout.

- **S6. The P2 count check doesn't use the import filter.** (03 §10 [P2] query vs 02 §Invariants) VERIFIED.
  - The SQL leaves out subagents, bb-created ids, tombstones, the cron and one-shot definition, and the five profile DBs. "preview == SQL count" can then fail, or pass, by accident.
  - Fix: ship `e2e/eligibility` built from the same filter constants, run per profile home.

- **S7. bb upgrades have no runbook.** (05 R3 "re-run conformance on every bb upgrade"; `engines.bb >=0.48.1`) VERIFIED gap.
  - Fix: before a live bb upgrade, run e2e plus conformance on `npx bb-app@<new>`, then `bb plugin types --check`. Health shows the bb and SDK versions.
  - Keep `engines` open-ended. An upper bound would strand the plugin after an upgrade.

- **S8. Rollout and gates don't line up.** (04 §Rollout starts at P1; 03 dogfood P0 needs live bb) VERIFIED.
  - Fix: install on live in P0 (proves M1 and M2 early). Add "live install from `@^0` and one `bb plugin update` succeed" to the P0 exit criteria.

- **S9. Two recipe gaps.** (03 §6 step 2; 03 §Phase gates `npm run check`) VERIFIED.
  - Step 2 leaves out `BB_SKIP_ONBOARDING=1`, which every spike used (S7 §Isolated bb; 07 l.195).
  - The live `bb plugin build` fails (S1-S3 gotchas). Pin the bundled `bb` from `bb-app@0.48.1` in the `package.json` scripts.

- **S10. Cleanup order and safety.** (04 §Data cleanup; T6.4 depends on T2.5) VERIFIED order; SUSPECTED overlap.
  - Live ACP keeps creating empty probes until it is disabled: about 125 in 30 days (04 §5; 09 M6). "137" will be out of date.
  - Fix:
    - Make T6.4 depend on T6.3.
    - Exclude any session id bound to the 18 ACP threads.
    - Back up first: `sqlite3 "<home>/state.db" ".backup /private/tmp/…"`.

- **S11. The approvals list is incomplete.** (README §Approvals needed) VERIFIED.
  - Add:
    - the live gateway restart in dogfood P1 (a restart drops every live Hermes session, Discord and Conduit included; 04 l.277);
    - `hermes plugins install` into four live profile directories;
    - the new `~/.hermes/bb_tools/` files;
    - the server git credential (M1).

- **S12. No user docs.** (04 has no docs task) VERIFIED.
  - The user's own plugin ships `docs/guide.md` and `docs/operations.md`, and `distribution.md` recommends `PLUGIN_OVERVIEW.md`.
  - Fix: add T6.6 docs covering install, update, rollback, settings, approvals, Discord limits, cleanup and troubleshooting. Each phase appends to operations.md.

- **S13. The A9 check may not work as written.** (04 A9 "stop the isolated daemon") SUSPECTED.
  - `npx bb-app` starts the server and daemon together, so stopping only the daemon may not be possible.
  - Fix: name the exact command in T2.5, or test "$HERMES_HOST asleep" in the P2 live dogfood only.

## Questions for the user

- **Q1. Private repo on the remote bb server:** how should it authenticate?
  - **Recommended:** keep the repo private, with a read-only, single-repo, fine-grained token in the bb service user's git credential store.
  - Alternatives: `gh auth setup-git` uses the broader `gh` token. Making the repo public would publish the research docs (tailnet hostname, profile names, paths).
- **Q2. Drift check venue:**
  - **Recommended:** the host worker runs it when the Hermes version changes, plus a manual check before `hermes update`.
  - Alternatives: a $HERMES_HOST launchd job (a config change), or a daily agent automation (costs model turns).

## Checked and fine

- SDK 0.6.104 exports `runBridgeConformance`, `createDeltaAssembler`, `createFakePluginHost` and `experimental_defineHostEntry` (bundled-types).
- `apps/shared/src/gateway-contract.openrpc.json` exists. `model.options` is defined, but not in `x-canonical-methods`, as 11 §1 says.
- Redeploy (`reload` then `stopHosted`) and the 60 s keep-alive: VERIFIED in S7 §6–7.
- bb refuses moved tags (`distribution.md`), consistent with "new version, never retag".
- `bb plugin disable|remove|uninstall` and `bb provider enable` exist (bb-cli command index).
- Hermes `--ref`, `--no-enable` and `--force` exist; `enable` sends `reload-plugins` (08 l.218).
- The jj and gh release commands match `~/src/AGENTS.md`.