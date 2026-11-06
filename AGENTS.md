# AGENTS.md

Never commit personal values (machine or tailnet names, IPs, home paths, ids, names, work details): write the variable from `docs/variables.md` instead, and run `node scripts/check-private.mjs` before every commit.

Run every jj command here with `TZ=UTC` (for example `TZ=UTC jj commit`), so commit times stay UTC.
