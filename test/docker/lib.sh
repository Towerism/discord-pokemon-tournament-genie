# Shared helpers for the container scripts (sourced). Each script runs the image the way Unraid does: one /data
# bind mount, PUID/PGID, nothing else. Files are owned by PUID, so cleanup removes them from inside a container.

FAILURES=0
pass() { echo "  ok   $*"; }
# LOG_CONTAINER, when set, is the container whose log a failure prints (the one under test at that moment).
fail() {
  echo "  FAIL $*"
  FAILURES=$((FAILURES + 1))
  if [ -n "${LOG_CONTAINER:-}" ]; then docker logs "$LOG_CONTAINER" 2>&1 | tail -20 | sed 's/^/       | /'; fi
}
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }

# wipe <image> <dir>: removes a folder whose contents (and the folder itself, after the entrypoint's chown) are
# owned by PUID: empty it and hand it back to the caller from inside a container, then remove it.
wipe() {
  docker run --rm -v "$2:/data" --entrypoint sh "$1" -c "rm -rf /data/* /data/.[!.]* && chown $(id -u):$(id -g) /data" >/dev/null 2>&1 || true
  rmdir "$2" 2>/dev/null || true
}

# wait_healthy <container> [seconds]: polls /healthz inside the container until it answers or the deadline passes.
wait_healthy() {
  local name="$1" deadline="${2:-60}"
  for _ in $(seq 1 "$deadline"); do
    if docker exec "$name" node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "container $name never became healthy:"; docker logs "$name" 2>&1 | tail -40; return 1
}

# in_node <container> <js>: runs a script with node inside the container (fetch against the app, file checks).
in_node() { docker exec "$1" node -e "$2"; }

finish() {
  if [ "$FAILURES" -gt 0 ]; then echo "$FAILURES check(s) failed"; exit 1; fi
  echo "all checks passed"
}
