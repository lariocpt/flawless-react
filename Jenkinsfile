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
                    BASE=$(node -p "require('./package.json').version" | sed 's/-dev$//')
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
                    CID=$(docker create -w /w oven/bun:1 sh -c '
                        set -eu
                        cd /w
                        bun install --frozen-lockfile
                        bun test
                        bunx tsc --noEmit
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

                    node -e "const f='package.json',p=require('./'+f);p.version=process.env.V;require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\\n')" \
                        V="$APPS_VERSION"
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
                        node -e "const f='npmstage/package.json',p=require('./'+f);p.version=process.env.V;require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\\n')" \
                            V="$NPM_VERSION"

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
