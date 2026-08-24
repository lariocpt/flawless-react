// flawless-react — compile the binary, publish it to the artifact plane, then publish the
// source npm package.
//
// TWO ARTIFACTS HERE, NOT ONE — and unlike crust they are genuinely different things:
//
//   binary  (apps plane) : standalone, needs no Bun on the target machine. Runs all five
//                          tasks, but the two biome-backed ones (a11y, react-rules) need a
//                          biome executable reachable at runtime — see below.
//   package (npm plane)  : the source, which carries @biomejs/biome as a real dependency.
//                          Needs Bun at runtime (bin/flawless-react is `#!/usr/bin/env bun`)
//                          but every task works with no further setup.
//
// So this is NOT a launcher package like crust's. Publishing the source is the point: it is
// 364 KB, and it is the only channel where the biome tasks work unconditionally.
//
// WHY THE BINARY IS BUILT FROM src/bin.ts
// bin/flawless-react has no file extension, so `bun build --compile` cannot pick a loader,
// treats it as an opaque asset, reports "bundle 1 modules", and emits a binary that exits 0
// with no output for every flag. src/cli.ts only *exports* main() and never calls it, so it
// produces the same silent no-op. src/bin.ts exists solely to be a real compile entry.
pipeline {
    agent any
    options {
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }
    environment {
        REGISTRY = 'https://npm.in.drlario.org'
    }
    stages {
        stage('Preflight') {
            steps {
                sh '''
                    set -eu
                    test -w /srv/apps || { echo "/srv/apps not writable"; exit 1; }
                    test -x /opt/publish/bin/apps-publish || { echo "apps-publish not mounted"; exit 1; }
                    test -f src/bin.ts || { echo "src/bin.ts (the compile entry) is missing"; exit 1; }
                    # package.json lists LICENSE in `files`; npm would ship a broken manifest
                    # entry without it, and for a while this repo did exactly that.
                    test -f LICENSE || { echo "LICENSE missing but declared in package.json files[]"; exit 1; }
                '''
            }
        }
        stage('Version') {
            steps {
                sh '''
                    set -eu
                    BASE=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1) ; BASE=${BASE%-dev}
                    SHA=$(git rev-parse --short HEAD)
                    # Two schemes on purpose — see publish/bin/apps-publish's header. semver
                    # ignores build metadata after `+` when ordering, so the registry cannot use
                    # the apps form; the shared short sha ties the two together.
                    echo "APPS_VERSION=${BASE}+${SHA}"                     > version.env
                    echo "NPM_VERSION=${BASE}-ci.${BUILD_NUMBER}.${SHA}"  >> version.env
                    cat version.env
                '''
            }
        }
        stage('Test') {
            steps {
                sh '''
                    set -eu
                    # No -v "$PWD:/w" anywhere in this file: the workspace is in the
                    # jenkins_home NAMED VOLUME, so that host path does not exist as the daemon
                    # resolves it. docker cp goes through the client and does see it.
                    # tests/emittedExecution.test.ts SOURCES and RUNS what the tool emits, so
                    # the interpreters a user would use have to be in here. The image has bash
                    # but neither zsh nor jq, and its `node` is a symlink to bun — which strips
                    # type annotations, so the emitted .mjs has to meet a REAL node or the
                    # check proves nothing (that is the exact bug it was written to catch).
                    # /usr/local/bun-node-fallback-bin is last in PATH, so the apt node wins.
                    # Those tests fail rather than skip when an interpreter is missing: a
                    # skipped zsh case in CI is how the env.sh bug survived the first time.
                    # --add-host: sibling containers cannot resolve LAN DNS, and
                    # tests/crustGate.test.ts (FR-021) needs the crust binary that the apps
                    # plane on this host serves. FLAWLESS_CI_BROWSER=1 arms the one gated
                    # real-browser case (FR-022).
                    CID=$(docker create -w /w --add-host apps.in.drlario.org:host-gateway \
                        -e FLAWLESS_CI_BROWSER=1 oven/bun:1 sh -c '
                        set -eu
                        cd /w
                        apt-get update >/dev/null
                        apt-get install -y --no-install-recommends jq zsh nodejs curl ca-certificates >/dev/null
                        for c in bash zsh jq node curl; do
                            command -v "$c" >/dev/null || { echo "$c missing after apt install"; exit 1; }
                        done
                        # Fails in a second here rather than 400 tests later, and says why.
                        node -p "typeof Bun" | grep -qx undefined || {
                            echo "node on PATH is the bun shim, which strips type annotations"
                            echo "the emitted .mjs would not really be checked — install a real node"
                            exit 1
                        }
                        # crust from the apps plane, the same install a fleet machine uses —
                        # failing HERE, loudly, is the point: the baseline gate stayed a
                        # comment for as long as running it was optional (FR-021).
                        curl -fsSL https://apps.in.drlario.org/install.sh | bash -s -- crust
                        cp "$HOME/.local/bin/crust" /usr/local/bin/crust
                        crust --version
                        bun install --frozen-lockfile
                        # A real chromium for the gated browser case (FR-022).
                        bunx playwright install --with-deps chromium >/dev/null
                        bun test
                        bunx tsc --noEmit
                        # The gate package.json declares and CI never ran (FR-023): biome ci
                        # lints AND format-checks the whole tree, which the pre-commit
                        # lint-staged hook only does for staged files — five shipped errors
                        # proved the difference the day this line was added.
                        bunx biome ci .
                    ')
                    trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
                    docker cp "$PWD/." "$CID:/w" >/dev/null
                    docker start -a "$CID"
                '''
            }
        }
        stage('Compile') {
            steps {
                sh '''
                    set -eu
                    . ./version.env
                    rm -rf out && mkdir -p out

                    # Published as the file name `flawless-react`: install.sh installs a tool BY
                    # FILE NAME, so the basename here becomes the command on every target host.
                    CID=$(docker create -w /w oven/bun:1 sh -c '
                        set -eu
                        cd /w
                        bun install --frozen-lockfile
                        bun build --compile --minify --outfile /w/out/flawless-react src/bin.ts
                    ')
                    trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

                    sed -i '0,/"version"/s|"version"[[:space:]]*:[[:space:]]*"[^"]*"|"version": "'"$APPS_VERSION"'"|' package.json
                    docker cp "$PWD/." "$CID:/w" >/dev/null
                    git checkout -- package.json

                    docker start -a "$CID"
                    docker cp "$CID:/w/out/flawless-react" "$WORKSPACE/out/flawless-react"
                    chmod 0755 out/flawless-react

                    ls -lh out/flawless-react
                    # A compile-entry regression emits a binary that silently does nothing, so
                    # assert on real output rather than on the exit code alone.
                    got=$(./out/flawless-react --version | tr -d "\\r")
                    echo "reported: $got"
                    case "$got" in
                        *"$APPS_VERSION"*) : ;;
                        *) echo "FAIL: binary reports '$got', expected it to contain '$APPS_VERSION'"; exit 1 ;;
                    esac
                    ./out/flawless-react --help | grep -q "multi-task quality kit" \
                        || { echo "FAIL: --help produced nothing — wrong compile entry?"; exit 1; }
                '''
            }
        }
        stage('Publish binary') {
            steps {
                sh '''
                    set -eu
                    . ./version.env
                    /opt/publish/bin/apps-publish bin flawless-react "$APPS_VERSION" "$WORKSPACE/out/flawless-react"
                    grep -q "	flawless-react	$APPS_VERSION	" /srv/apps/index.tsv \
                        || { echo "FAIL: $APPS_VERSION not in index.tsv"; exit 1; }
                '''
            }
        }
        stage('Publish npm') {
            steps {
                // credentials-binding masks the value in the rendered console, but Jenkins'
                // durable-task runs `sh -xe`, so the trace would still write the token into the
                // output file inside jenkins_home. `set +x` is what actually keeps it out.
                withCredentials([string(credentialsId: 'verdaccio-npm-token', variable: 'NPM_TOKEN')]) {
                    sh '''
                        set -eu
                        . ./version.env

                        rm -rf npmstage && mkdir npmstage
                        # Only what package.json's files[] declares. `bin` is the bun shim, not
                        # the compiled artifact — that goes to the apps plane, not the registry.
                        cp -r bin src README.md LICENSE package.json npmstage/
                        rm -f npmstage/bin/flawless-react-bin
                        sed -i '0,/"version"/s|"version"[[:space:]]*:[[:space:]]*"[^"]*"|"version": "'"$NPM_VERSION"'"|' npmstage/package.json

                        # Token never in argv (visible in host `ps`) and never in the log.
                        set +x
                        umask 077
                        printf '//npm.in.drlario.org/:_authToken=%s\\nregistry=%s\\n' "$NPM_TOKEN" "$REGISTRY" > npmstage/.npmrc
                        set -x

                        CID=$(docker create -w /w node:22-bookworm-slim sh -c 'set -eu; cd /w; npm publish')
                        trap 'docker rm -f "$CID" >/dev/null 2>&1 || true; rm -f npmstage/.npmrc' EXIT
                        docker cp "$PWD/npmstage/." "$CID:/w" >/dev/null
                        docker start -a "$CID" || {
                            echo "publish failed — if 403/ENEEDAUTH, the verdaccio-npm-token credential is wrong or the htpasswd user was never created"
                            exit 1
                        }
                        rm -f npmstage/.npmrc
                    '''
                }
            }
        }
        stage('Verify') {
            steps {
                sh '''
                    set -eu
                    . ./version.env
                    curl -fsSL https://apps.in.drlario.org/install.sh | bash -s -- --list | grep -q flawless-react \
                        || { echo "FAIL: flawless-react is not listed by install.sh"; exit 1; }
                    docker run --rm node:22-bookworm-slim \
                        npm view "flawless-react@$NPM_VERSION" dist.unpackedSize --registry "$REGISTRY"
                    echo "published flawless-react $NPM_VERSION (npm) / $APPS_VERSION (apps)"
                '''
            }
        }
    }
}
