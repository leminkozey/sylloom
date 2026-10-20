#!/bin/bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_MODELS=all
LINK_COMMAND=1
CONFIGURE_PATH=1
CHECK_ONLY=0

usage() {
    cat <<'HELP'
Sylloom installer for macOS on Apple Silicon

Usage: ./install.sh [--dictation-only | --skip-models] [--no-link] [--no-path] [--check]

  --dictation-only  Download Whisper Turbo and the dictation formatter only
  --skip-models     Install dependencies and build without downloading models
  --no-link         Do not create a sylloom command in ~/.local/bin
  --no-path         Install the command without changing shell configuration
  --check           Check requirements without installing or changing anything
  --help           Show this help

By default, installs four local models (about 7.3 GiB), then installs the command
and configures PATH for zsh, bash or fish if needed. No sudo is used.
Set SYLLOOM_HOME to choose a data directory; SYLLOOM_BIN_DIR chooses the link directory.
Existing recordings, settings and unrelated commands are preserved.
HELP
}

for argument in "$@"; do
    case "$argument" in
        --dictation-only) INSTALL_MODELS=dictation ;;
        --skip-models) INSTALL_MODELS=none ;;
        --no-link) LINK_COMMAND=0 ;;
        --no-path) CONFIGURE_PATH=0 ;;
        --check) CHECK_ONLY=1 ;;
        --help|-h) usage; exit 0 ;;
        *) printf 'Unknown option: %s\n' "$argument" >&2; usage >&2; exit 2 ;;
    esac
done

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
    printf 'Sylloom currently supports macOS on Apple Silicon. Run in a native arm64 terminal.\n' >&2
    exit 1
fi
OS_VERSION="$(sw_vers -productVersion)"
OS_MAJOR="${OS_VERSION%%.*}"
OS_REST="${OS_VERSION#*.}"
OS_MINOR="${OS_REST%%.*}"
if (( OS_MAJOR < 14 || (OS_MAJOR == 14 && OS_MINOR < 4) )); then
    printf 'System audio capture requires macOS 14.4 or later.\n' >&2
    exit 1
fi

# Find an existing Homebrew installation without changing shell configuration.
if ! command -v brew >/dev/null 2>&1; then
    for candidate in /opt/homebrew/bin /usr/local/bin; do
        if [[ -x "$candidate/brew" ]]; then export PATH="$candidate:$PATH"; break; fi
    done
fi
node_ready() {
    command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
        node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>22||(major===22&&minor>=18)?0:1)'
}
need_brew() {
    if ! command -v brew >/dev/null 2>&1; then
        printf 'Install Homebrew from https://brew.sh, then run this installer again.\n' >&2
        exit 1
    fi
}

MISSING=0
if ! node_ready; then
    printf 'Node.js 22.18 or later and npm are required.\n'
    if (( CHECK_ONLY )); then MISSING=1; else
        need_brew
        brew install node@24
        export PATH="$(brew --prefix node@24)/bin:$PATH"
        node_ready || { printf 'Node.js setup failed.\n' >&2; exit 1; }
    fi
fi
for requirement in whisper-server:whisper.cpp llama-server:llama.cpp; do
    binary="${requirement%%:*}"
    formula="${requirement#*:}"
    if ! command -v "$binary" >/dev/null 2>&1; then
        printf 'Required binary: %s (Homebrew: %s)\n' "$binary" "$formula"
        if (( CHECK_ONLY )); then MISSING=1; else need_brew; brew install "$formula"; fi
    fi
done
if (( CHECK_ONLY )); then
    if (( MISSING )); then exit 1; fi
    printf 'Requirements ready. No changes made.\n'; exit 0
fi

cd "$ROOT"
printf '\nInstalling Sylloom dependencies…\n'
npm ci
npm run build
chmod +x "$ROOT/sylloom"

case "$INSTALL_MODELS" in
    all) node "$ROOT/sylloom" models install all --keep-selection ;;
    dictation)
        node "$ROOT/sylloom" models install dictation-whisper --keep-selection
        node "$ROOT/sylloom" models install formatter --keep-selection
        ;;
esac

if (( LINK_COMMAND )); then
    if (( CONFIGURE_PATH )); then node "$ROOT/sylloom" install;
    else node "$ROOT/sylloom" install --no-path; fi
fi

if (( LINK_COMMAND )); then printf '\nSylloom is ready. Start it from any directory with: sylloom\n';
else printf '\nSylloom is ready. Start it with: %s\n' "$ROOT/sylloom"; fi
printf 'Allow microphone and system audio recording for your terminal when macOS asks.\n'
if [[ "$INSTALL_MODELS" == none ]]; then printf 'Models were skipped. Install them with: sylloom models install all\n'; fi
