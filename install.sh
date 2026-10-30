#!/usr/bin/env bash
# flawless-react — install the prebuilt binary from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/lariocpt/flawless-react/main/install.sh | bash
#
# Downloads the release binary for this OS/architecture, verifies it against the SHA256SUMS
# published beside it, and installs it to ~/.local/bin. No clone, no Bun, no build.
#
# The checksum is not decoration: the download is verified while it is still a temp file with
# no execute bit, and only then moved into place. A truncated or tampered download must never
# be executable on disk, not even briefly.
#
# What this binary cannot do is stated here too, because it is the one surprise users hit:
# `react-rules`, and `a11y` on the web path, shell out to biome, and a single-file Bun binary
# cannot carry biome inside itself. A missing biome does NOT fail the install — three of the
# five tasks need none — it prints which two will refuse and what to do about it. The source
# package (`@lariocpt/flawless-react`) carries @biomejs/biome as a real dependency and needs no
# such setup.
#
# Options (also settable as environment variables):
#   --version <tag>   FLAWLESS_VERSION       release tag to install, e.g. v0.3.0 (default: latest)
#   --dir <path>      FLAWLESS_INSTALL_DIR   install directory (default: ~/.local/bin)
#   --repo <o/r>      FLAWLESS_GITHUB_REPO   source repository (default: lariocpt/flawless-react)
#                     FLAWLESS_DOWNLOAD_BASE base URL holding the assets, for a mirror or a test
#   --skills          install the agent skills without asking (scripted installs)
#   --no-skills       never touch the skills; same as declining the prompt
set -euo pipefail

REPO="${FLAWLESS_GITHUB_REPO:-lariocpt/flawless-react}"
VERSION="${FLAWLESS_VERSION:-latest}"
INSTALL_DIR="${FLAWLESS_INSTALL_DIR:-$HOME/.local/bin}"

say()  { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$1" >&2; exit 1; }

SKILLS="${FLAWLESS_SKILLS:-ask}"   # ask | yes | no

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --dir)     INSTALL_DIR="${2:-}"; shift 2 ;;
    --repo)    REPO="${2:-}"; shift 2 ;;
    --skills)    SKILLS="yes"; shift ;;
    --no-skills) SKILLS="no";  shift ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --dir=*)     INSTALL_DIR="${1#*=}"; shift ;;
    --repo=*)    REPO="${1#*=}"; shift ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done
[ -n "$VERSION" ] || die "--version needs a value"
[ -n "$INSTALL_DIR" ] || die "--dir needs a value"

# Platform support is decided BEFORE tool availability: telling an Alpine user "curl is
# required" hides the real answer, which is that no binary exists for them.
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
  linux|darwin) ;;
  *) die "unsupported OS '$OS' — build from source: https://github.com/$REPO#build-from-source" ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture '$(uname -m)' — build from source: https://github.com/$REPO#build-from-source" ;;
esac

# The published Linux binaries are glibc-only (bun's own builds are). Without this check an
# Alpine user downloads one, passes the checksum, and then gets `flawless-react: not found` —
# which reads as a broken install rather than an unsupported platform. Fail here, with the
# real reason.
if [ "$OS" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then
  die "musl libc detected (Alpine?) — the published binaries are glibc-only.
  Build from source instead: https://github.com/$REPO#build-from-source"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"

# sha256sum on GNU userland, shasum on macOS. Refusing to install unverified is the point, so
# there is no third branch that skips the check.
if command -v sha256sum >/dev/null 2>&1; then
  sha_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "need sha256sum or shasum to verify the download"
fi

ASSET="flawless-react-${OS}-${ARCH}"

if [ -n "${FLAWLESS_DOWNLOAD_BASE:-}" ]; then
  BASE="${FLAWLESS_DOWNLOAD_BASE%/}"
elif [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/flawless-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

say "Fetching checksums for $ASSET ($VERSION)"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" \
  || die "could not fetch $BASE/SHA256SUMS — is $VERSION a published release of $REPO?"

WANT=$(awk -v a="$ASSET" '$2 == a || $2 == "*" a { print $1 }' "$TMP/SHA256SUMS" | head -1)
if [ -z "$WANT" ]; then
  HAVE=$(awk '{ print $2 }' "$TMP/SHA256SUMS" | tr '\n' ' ')
  die "release $VERSION has no $ASSET (it has: $HAVE)"
fi

say "Downloading $ASSET"
curl -fSL --progress-bar "$BASE/$ASSET" -o "$TMP/$ASSET" || die "download failed: $BASE/$ASSET"

GOT=$(sha_of "$TMP/$ASSET")
[ "$GOT" = "$WANT" ] || die "checksum mismatch for $ASSET
  expected $WANT
  got      $GOT"
say "Checksum verified"

mkdir -p "$INSTALL_DIR" || die "cannot create $INSTALL_DIR"
chmod 0755 "$TMP/$ASSET"
# Verified first, executable second, in place third.
mv -f "$TMP/$ASSET" "$INSTALL_DIR/flawless-react" || die "cannot write $INSTALL_DIR/flawless-react"

INSTALLED_VERSION=$("$INSTALL_DIR/flawless-react" --version 2>/dev/null || echo "unknown")

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) warn "$INSTALL_DIR is not on your PATH. Add it:
    echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc   # or ~/.zshrc" ;;
esac

# The biome advisory. Deliberately a warning, not a gate: perf-harness, unit-browser and
# perf-static run without it, and refusing to install a working tool would be its own bug.
# The lookup below is only PATH — the tool itself ALSO searches the scanned project's
# node_modules/.bin/biome and every ancestor workspace root — so "not on PATH" is never a
# claim that a task will fail, only that this machine offers no global candidate.
if command -v biome >/dev/null 2>&1; then
  BIOME_LINE="found on PATH: $(command -v biome)"
else
  BIOME_LINE="no biome on PATH"
fi

cat <<EOF

  $(printf '\033[1;32m%s installed.\033[0m' "$INSTALLED_VERSION")

  Binary:    $INSTALL_DIR/flawless-react
  First run: flawless-react ./src/Button.tsx
  All tasks: flawless-react ./src/App.tsx --tasks unit-browser,perf-harness,perf-static,a11y,react-rules
  Docs:      https://github.com/$REPO#readme
  Uninstall: rm $INSTALL_DIR/flawless-react

  Biome ($BIOME_LINE):
    react-rules — and a11y on the web path — shell out to biome 2, looking in the scanned
    project's node_modules/.bin/biome, then each ancestor workspace root, then PATH. A
    project that already lints with biome 2 satisfies that for free; otherwise:
      bun add -d @biomejs/biome     in that project
    The source package carries @biomejs/biome as a dependency and needs no such setup — see
    the Install section of https://github.com/$REPO#readme
    (a11y under --expo is the tool's own native analyser and needs no biome.)

EOF

# --- Agent skills ------------------------------------------------------------
#
# Offered here because the skills are what make a coding agent useful on a
# generated suite, and nobody reads a README to discover they exist. The command
# stays the single implementation — this only asks, and then delegates which
# skills to install (a menu on a terminal, every one when piped).
#
# The answer is read from /dev/tty, NEVER stdin: under `curl -fsSL … | bash`
# stdin IS the script, so a plain `read` would take the installer's remaining
# lines as the reply and then execute a truncated installer — a failure that
# reports success. With no terminal at all (CI, or piped where /dev/tty is not
# usable) nothing is written and the command is printed instead.
offer_skills() {
  case "$SKILLS" in
    no)
      say "Skills skipped (--no-skills). Any time: flawless-react skills install"
      return 0 ;;
    yes) ;;
    ask)
      # `[ -w /dev/tty ]` is not a usable test here: the node exists and is
      # mode-666, so it reports writable even when the process has NO controlling
      # terminal — and the redirect then fails with a bare
      # `bash: line N: /dev/tty: No such device or address` where a sentence
      # belongs. The only honest probe is to actually open it, in a subshell so a
      # failure stays silent and costs nothing.
      if ( : >/dev/tty ) 2>/dev/null; then
        printf '\nInstall the agent skills into \033[1m%s\033[0m? [y/N] ' "$PWD" > /dev/tty
        ANSWER=""
        read -r ANSWER < /dev/tty || ANSWER=""
        case "$ANSWER" in
          [yY]|[yY][eE][sS]) ;;
          *) say "Skills not installed. Any time: flawless-react skills install"; return 0 ;;
        esac
      else
        warn "no terminal available: skills were not installed. Run: flawless-react skills install"
        return 0
      fi ;;
  esac
  "$INSTALL_DIR/flawless-react" skills install \
    || warn "skills install failed — run it yourself: flawless-react skills install"
}

offer_skills
