#!/usr/bin/env bash
# Repeatable Linux-container validation for colony worker deployment.
# Touches only the colony-worker-test compose project/container/volume.
# No --privileged, no Docker socket, no host home/keys/workspace mount, no ports.
#
#   bash container/scripts/validate.sh            # keep the test volume
#   bash container/scripts/validate.sh --reset    # delete ONLY this test volume first

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
CONTAINER="colony-worker-test"
COMPOSE=(docker compose -f container/compose.yml --project-name colony-worker-test)
export MSYS_NO_PATHCONV=1

RESET=0
[ "${1:-}" = "--reset" ] && RESET=1

TMP="$(mktemp -d)"
cleanup() {
  # Remove only the files this script creates, then the now-empty mktemp dir.
  rm -f "$TMP"/*.out "$TMP"/*.err "$TMP"/*.stdout 2>/dev/null || true
  rmdir "$TMP" 2>/dev/null || true
}
trap cleanup EXIT
FAILURES=0
LAST_OUT=""
LAST_ERR=""
LAST_CODE=0

say() { printf '\n### %s\n' "$*" ; }
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
abort() {
  printf '\nABORT: %s\n' "$*"
  printf 'stopping the test container (image and volume kept)\n'
  "${COMPOSE[@]}" stop >/dev/null 2>&1 || true
  exit 1
}

# Run in the container with stdout and stderr in separate files.  The JSON
# commands below are parsed from the complete stdout file, never from a guessed
# line mixed with logs.
run() {
  local label="$1" expected="$2"
  shift 2
  local workdir=()
  if [ "${1:-}" = "--workdir" ]; then workdir=(-w "$2"); shift 2; fi
  local safe out err
  safe="$(printf '%s' "$label" | tr -c 'A-Za-z0-9_-' '_')"
  out="$TMP/$safe.out"
  err="$TMP/$safe.err"
  say "$label"
  printf '$ docker exec %s %s %s\n' "${workdir[*]}" "$CONTAINER" "$*"
  docker exec "${workdir[@]}" "$CONTAINER" "$@" >"$out" 2>"$err"
  LAST_CODE=$?
  LAST_OUT="$out"
  LAST_ERR="$err"
  printf -- '--- stdout ---\n'; sed -n '1,160p' "$out"
  printf -- '--- stderr ---\n'; sed -n '1,160p' "$err"
  printf '[exit %s]\n' "$LAST_CODE"
  if [ "$LAST_CODE" -eq "$expected" ]; then pass "$label (exit $LAST_CODE)"; else fail "$label: expected exit $expected, got $LAST_CODE"; fi
}

# Read one field from the complete JSON object on stdout.
jget() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      const data = JSON.parse(s);
      let value = data;
      for (const part of process.argv[1].split(".")) value = value?.[part];
      process.stdout.write(value === undefined || value === null ? "" : String(value));
    });
  ' "$1" <"$LAST_OUT"
}

say "colony worker Linux-container validation"
printf 'repo: %s\ncontainer: %s\nvolume: colony-worker-test-home\n' "$ROOT" "$CONTAINER"

if [ "$RESET" -eq 1 ]; then
  say "reset ONLY the colony-worker-test project volume"
  "${COMPOSE[@]}" down -v
fi

say "build image colony-worker-test:local"
if "${COMPOSE[@]}" build; then pass "image build"; else fail "image build"; abort "image build failed"; fi

say "start container"
if "${COMPOSE[@]}" up -d; then pass "container start"; else fail "container start"; abort "container start failed"; fi
if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]; then pass "container running"; else fail "container not running"; abort "container not running"; fi

say "container security boundary"
SEC="$(docker inspect "$CONTAINER" | node -e '
  let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
    const i = JSON.parse(s)[0], h = i.HostConfig, p = [];
    if (h.Privileged !== false) p.push("privileged");
    if (Object.keys(h.PortBindings || {}).length) p.push("published-ports");
    if (h.NetworkMode === "host") p.push("host-network");
    const mounts = i.Mounts || [];
    // HostConfig.Binds also lists named volumes; only Mounts[].Type tells a
    // real host bind apart from the dedicated colony volume.
    if (mounts.some((m) => m.Type === "bind")) p.push(`host-binds=${mounts.filter((m) => m.Type === "bind").map((m) => m.Source).join(",")}`);
    const unexpected = mounts.filter((m) => !(m.Type === "volume" && m.Name === "colony-worker-test-home" && m.Destination === "/home/colony"));
    if (unexpected.length) p.push(`mounts=${unexpected.map((m) => `${m.Type}:${m.Name || m.Source}->${m.Destination}`).join(",")}`);
    if (!(h.SecurityOpt || []).some((v) => v.includes("no-new-privileges"))) p.push("no-new-privileges-missing");
    const summary = mounts.map((m) => `${m.Type}:${m.Name || m.Source}->${m.Destination}`).join(",");
    console.log(p.length ? `PROBLEMS: ${p.join("; ")}` : `ok: mounts=${summary}, no host binds, no ports, no-new-privileges`);
    process.exit(p.length ? 1 : 0);
  });
' 2>&1)"; SEC_CODE=$?
printf '%s\n[exit %s]\n' "$SEC" "$SEC_CODE"
[ "$SEC_CODE" -eq 0 ] && pass "container isolation boundary" || { fail "container isolation boundary: $SEC"; abort "isolation boundary check failed"; }

run "tools and isolation probes" 0 sh -c '
  node --version
  npm --version
  git --version
  curl --version | head -1
  echo "user=$(id -un) uid=$(id -u)"
  test -S /var/run/docker.sock && echo docker-socket=present || echo docker-socket=absent
  command -v claude || echo claude=absent
  command -v codex || echo codex=absent
'
grep -Eq '^v(2[2-9]|[3-9][0-9])\.' "$LAST_OUT" && pass "Node.js 22+" || fail "Node.js 22+"
grep -q 'docker-socket=absent' "$LAST_OUT" && pass "no Docker socket" || fail "no Docker socket"
grep -q 'claude=absent' "$LAST_OUT" && grep -q 'codex=absent' "$LAST_OUT" && pass "no agent runtime/login (expected)" || fail "unexpected agent runtime"

run "status before deploy (fresh empty home)" 1 sh -c 'rm -rf /tmp/colony-empty && colony --home /tmp/colony-empty worker status --json'
grep -q 'imd not found' "$LAST_ERR" && pass "missing imd fails clearly" || fail "missing imd message absent"

run "deploy dry-run (pins the tag)" 0 colony worker deploy --dry-run --json
[ "$LAST_CODE" -eq 0 ] || abort "deploy dry-run failed"
TAG="$(jget release.tag)" || abort "cannot parse release tag"
VERSION="$(jget release.version)" || abort "cannot parse release version"
DIGEST="$(jget release.assetDigest)" || abort "cannot parse release digest"
printf 'pinned tag=%s version=%s digest=%s\n' "$TAG" "$VERSION" "$DIGEST"
EXPECTED_PKG_VERSION="${VERSION%%-*}"
printf '%s' "$TAG" | grep -q '^worker-v' && pass "pinned tag" || { fail "pinned tag"; abort "invalid tag"; }
printf '%s' "$DIGEST" | grep -Eq '^[0-9a-f]{64}$' && pass "release metadata digest" || { fail "release metadata digest"; abort "invalid digest"; }

run "deploy explicit --version $TAG" 0 colony worker deploy --version "$TAG" --json
[ "$LAST_CODE" -eq 0 ] || abort "deploy failed; later checks would be false positives"
DEPLOY_SHA="$(jget install.sha256)" || abort "cannot parse deploy sha256"
DEPLOY_IMD="$(jget install.imdPath)" || abort "cannot parse deploy imd path"
[ "$(jget release.tag)" = "$TAG" ] && pass "deployed requested tag" || { fail "deployed tag mismatch"; abort "deploy tag mismatch"; }
[ "$DEPLOY_SHA" = "$DIGEST" ] && pass "checksum matches release metadata" || { fail "checksum mismatch"; abort "deploy checksum mismatch"; }

run "installed worker release" 0 sh -c '
  PREFIX="$COLONY_HOME/worker/prefix"
  test -x "$PREFIX/bin/imd" && echo "imd=$PREFIX/bin/imd"
  node -p "require(\"$PREFIX/lib/node_modules/@identitymd/worker/build.json\").version"
  test -f "$COLONY_HOME/worker-state.json" && echo state=recorded
'
[ "$LAST_CODE" -eq 0 ] || abort "installed worker check failed"
grep -q '^imd=' "$LAST_OUT" && pass "official imd executable" || { fail "official imd missing"; abort "official imd missing"; }
[ "$(sed -n '2p' "$LAST_OUT")" = "$EXPECTED_PKG_VERSION" ] && pass "installed build.json version $EXPECTED_PKG_VERSION" || { fail "installed version differs"; abort "installed version differs"; }
grep -q 'state=recorded' "$LAST_OUT" && pass "colony install state recorded" || { fail "colony install state missing"; abort "install state missing"; }

run "official imd help" 0 sh -c '"$COLONY_HOME/worker/prefix/bin/imd" help | head -1'
grep -q 'IdentityMD contributor daemon' "$LAST_OUT" && pass "official worker CLI runs" || fail "official worker CLI did not run"
run "imd whoami before pairing" 1 sh -c '"$COLONY_HOME/worker/prefix/bin/imd" whoami'

run "status after deploy (unpaired)" 1 colony worker status --json
SERVICE_CODE="$(jget service.exitCode)"
STANDING_ERROR="$(jget standingError)"
[ -n "$SERVICE_CODE" ] && pass "raw service exit code=$SERVICE_CODE" || fail "service exit code missing"
[ -n "$STANDING_ERROR" ] && pass "standing unavailable: $STANDING_ERROR" || fail "standing error not reported"

run "doctor (missing runtime is expected)" 1 colony worker doctor --json
DOCTOR_EXIT="$(jget exitCode)"
DOCTOR_OUT="$TMP/doctor.stdout"
jget stdout >"$DOCTOR_OUT"
[ "$DOCTOR_EXIT" != "0" ] && pass "doctor exit=$DOCTOR_EXIT" || fail "doctor unexpectedly succeeded"
grep -q 'git' "$DOCTOR_OUT" && pass "doctor checked git" || fail "doctor did not report git"
grep -Eq 'runtime|claude|codex' "$DOCTOR_OUT" && pass "doctor reports missing runtime" || fail "doctor did not report runtime"

run "update explicit --version $TAG" 0 colony worker update --version "$TAG" --json
[ "$(jget release.tag)" = "$TAG" ] && [ "$(jget install.sha256)" = "$DEPLOY_SHA" ] && pass "update re-verified $TAG" || fail "update did not reproduce verified archive"

run "unknown release fails before install" 1 colony worker deploy --version no-such-worker-release --dry-run --json
grep -q 'no worker release matches' "$LAST_ERR" && pass "unknown release rejected" || fail "unknown release error unclear"

run "service install without pairing fails" 1 colony worker service install --json

say "container restart keeps the isolated volume/install"
docker restart "$CONTAINER" >/dev/null
sleep 2
run "status after container restart" 1 colony worker status --json
[ "$(jget service.exitCode)" != "" ] && pass "install survived container restart" || fail "install did not survive restart"

say "Linux task-result tests (copied, not part of the image)"
docker cp "./test/." "$CONTAINER:/opt/colony/test" >/dev/null || abort "docker cp test failed"
run "task-result tests (17)" 0 --workdir /opt/colony node --test test/task-result.test.mjs

say "summary"
printf 'installed tag=%s version=%s sha256=%s\n' "$TAG" "$VERSION" "$DEPLOY_SHA"
printf 'failures=%s\n' "$FAILURES"
printf 'stopping the test container (image and volume are kept)\n'
"${COMPOSE[@]}" stop
printf 'resume: docker compose -f container/compose.yml --project-name colony-worker-test start\n'
printf 'reset: bash container/scripts/validate.sh --reset  (removes only colony-worker-test-home)\n'
[ "$FAILURES" -eq 0 ]
