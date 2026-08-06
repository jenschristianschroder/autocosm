#!/bin/sh
# Autocosm container entrypoint.
#
# One image, four modes. The mode comes from the first argument (what Container Apps Jobs set as
# `args`) or from AUTOCOSM_MODE. An unknown mode is a hard failure: silently defaulting to `web`
# inside a scheduled job would produce a container that never exits and bills forever.
set -eu

MODE="${1:-${AUTOCOSM_MODE:-web}}"
export AUTOCOSM_MODE="$MODE"

case "$MODE" in
  web)
    exec node ./apps/world-web/dist/main.js
    ;;
  tick)
    exec node ./apps/world-tick/dist/main.js
    ;;
  think)
    exec node ./apps/agent-think/dist/main.js
    ;;
  admin)
    # Internal-ingress read-only storage inspector. See apps/world-admin and infra/app.bicep.
    exec node ./apps/world-admin/dist/main.js
    ;;
  seed)
    # Local development only. Production startup refuses this; see apps/world-tick/src/config.ts.
    exec node ./apps/world-tick/dist/seed.js
    ;;
  *)
    echo "autocosm: unknown mode '$MODE' (expected: web | tick | think | admin | seed)" >&2
    exit 64
    ;;
esac
