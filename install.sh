#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROFILE_NAME=medivh

APP_DIR=${KARAZHAN_INSTALL_APP_DIR:-"$HOME/Applications"}
BIN_DIR=${KARAZHAN_INSTALL_BIN_DIR:-"$HOME/.local/bin"}
PROFILE_DIR=${KARAZHAN_MEDIVH_PROFILE_DIR:-"$HOME/.hermes/profiles/$PROFILE_NAME"}
STATE_DIR=${KARAZHAN_INSTALL_STATE_DIR:-"$HOME/.local/share/karazhan-installer"}
LAUNCHER_TARGET="$BIN_DIR/medivh"
APP_SOURCE=${KARAZHAN_INSTALL_APP_SOURCE:-"$SCRIPT_DIR/target/release/bundle/macos/Karazhan.app"}
MCP_SOURCE=${KARAZHAN_INSTALL_MCP_SOURCE:-"$SCRIPT_DIR/target/release/karazhan-mcp"}
SKIP_BUILD=${KARAZHAN_INSTALL_SKIP_BUILD:-0}
SKIP_APP=${KARAZHAN_INSTALL_SKIP_APP:-0}
INSTALL_PROXY=${KARAZHAN_INSTALL_PROXY:-http://127.0.0.1:7897}
INSTALL_VERSION=${KARAZHAN_INSTALL_VERSION:-$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SCRIPT_DIR/apps/desktop/src-tauri/tauri.conf.json" | sed -n '1p')}

die() {
  printf 'karazhan install: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

if [ -n "${KARAZHAN_HERMES_COMMAND:-}" ]; then
  HERMES_COMMAND=$KARAZHAN_HERMES_COMMAND
else
  HERMES_COMMAND=$(command -v hermes 2>/dev/null || true)
fi
[ -n "$HERMES_COMMAND" ] || die "Hermes is not installed or not on PATH"
[ -x "$HERMES_COMMAND" ] || die "Hermes command is not executable: $HERMES_COMMAND"

require_command cmp
require_command diff
require_command git
require_command shasum
require_command awk

version_compare() {
  awk -v left="$1" -v right="$2" 'BEGIN {
    if (left !~ /^[0-9]+\.[0-9]+\.[0-9]+$/ || right !~ /^[0-9]+\.[0-9]+\.[0-9]+$/) exit 2
    split(left, l, "."); split(right, r, ".")
    for (i = 1; i <= 3; i++) {
      if ((l[i] + 0) > (r[i] + 0)) { print 1; exit }
      if ((l[i] + 0) < (r[i] + 0)) { print -1; exit }
    }
    print 0
  }' || die "versions must use MAJOR.MINOR.PATCH: $1, $2"
}

[ -n "$INSTALL_VERSION" ] || die "cannot read install version from Tauri configuration"
[ "$(version_compare "$INSTALL_VERSION" "$INSTALL_VERSION")" = 0 ] || die "invalid install version: $INSTALL_VERSION"

INSTALL_TMP=$(mktemp -d "${TMPDIR:-/tmp}/karazhan-install.XXXXXX")
cleanup_install_tmp() {
  rm -rf "$INSTALL_TMP"
}
trap cleanup_install_tmp EXIT
trap 'exit 130' HUP INT TERM
INSTALL_TIMESTAMP=$(date '+%Y%m%d%H%M%S')
STATUS_FILE="$INSTALL_TMP/status"
: > "$STATUS_FILE"

paths_equal() {
  left=$1
  right=$2
  if [ -d "$left" ] && [ -d "$right" ]; then
    diff -qr "$left" "$right" >/dev/null 2>&1
  elif [ -f "$left" ] && [ -f "$right" ]; then
    cmp -s "$left" "$right"
  else
    return 1
  fi
}

preflight_managed_path() {
  source_path=$1
  target_path=$2
  baseline_path=$3

  [ -e "$source_path" ] || die "install source is missing: $source_path"
  [ ! -L "$target_path" ] || die "managed target must not be a symlink: $target_path"

  if [ -f "$baseline_path" ]; then
    if [ -e "$target_path" ]; then
      expected_digest=$(cat "$baseline_path")
      actual_digest=$(path_digest "$target_path")
      if [ "$actual_digest" != "$expected_digest" ]; then
        die "managed target was locally modified; refusing to overwrite: $target_path"
      fi
    fi
  fi

  version_path="$baseline_path.version"
  if [ -f "$version_path" ]; then
    deployed_version=$(cat "$version_path")
    comparison=$(version_compare "$INSTALL_VERSION" "$deployed_version")
    [ "$comparison" -ge 0 ] || \
      die "refusing to downgrade $target_path from $deployed_version to $INSTALL_VERSION"
    if [ ! -f "$baseline_path" ] && [ -e "$target_path" ] && \
       [ "$comparison" -eq 0 ] && ! paths_equal "$target_path" "$source_path"; then
      die "managed version exists without a baseline; refusing to overwrite: $target_path"
    fi
  fi
}

backup_existing_path() {
  target_path=$1
  backup_path="$target_path.pre-karazhan-$INSTALL_TIMESTAMP"
  [ ! -e "$backup_path" ] || die "backup path already exists: $backup_path"
  if [ -d "$target_path" ]; then
    cp -R "$target_path" "$backup_path"
  else
    cp -p "$target_path" "$backup_path"
  fi
  printf '%s' "$backup_path"
}

replace_path() {
  source_path=$1
  target_path=$2
  target_parent=$(dirname -- "$target_path")
  target_name=$(basename -- "$target_path")
  staged_path="$target_parent/.$target_name.karazhan-new.$$"
  backup_path="$target_parent/.$target_name.karazhan-old.$$"

  mkdir -p "$target_parent"
  [ ! -e "$staged_path" ] || die "staging path already exists: $staged_path"
  [ ! -e "$backup_path" ] || die "backup path already exists: $backup_path"

  if [ -d "$source_path" ]; then
    cp -R "$source_path" "$staged_path"
  else
    cp -p "$source_path" "$staged_path"
  fi

  if [ -e "$target_path" ]; then
    mv "$target_path" "$backup_path"
  fi
  if mv "$staged_path" "$target_path"; then
    if [ -d "$backup_path" ]; then
      rm -rf "$backup_path"
    elif [ -e "$backup_path" ]; then
      rm -f "$backup_path"
    fi
  else
    if [ -e "$backup_path" ]; then
      mv "$backup_path" "$target_path"
    fi
    die "could not install $target_path"
  fi
}

write_managed_state() {
  target_path=$1
  baseline_path=$2
  digest_source="$INSTALL_TMP/managed-digest"
  version_source="$INSTALL_TMP/managed-version"
  path_digest "$target_path" > "$digest_source"
  printf '%s\n' "$INSTALL_VERSION" > "$version_source"
  replace_path "$digest_source" "$baseline_path"
  replace_path "$version_source" "$baseline_path.version"
}

install_versioned_path() {
  label=$1
  source_path=$2
  target_path=$3
  baseline_path=$4
  version_path="$baseline_path.version"

  if [ ! -e "$target_path" ]; then
    if [ -f "$version_path" ]; then
      prior_version=$(cat "$version_path")
      install_status=restored
      install_detail="missing target; $prior_version -> $INSTALL_VERSION"
    else
      install_status=new
      install_detail="version $INSTALL_VERSION"
    fi
    replace_path "$source_path" "$target_path"
    write_managed_state "$target_path" "$baseline_path"
    printf '%s|%s|%s|%s\n' "$label" "$install_status" "$target_path" "$install_detail" >> "$STATUS_FILE"
    return
  fi

  if [ -f "$version_path" ]; then
    deployed_version=$(cat "$version_path")
    comparison=$(version_compare "$INSTALL_VERSION" "$deployed_version")
    if [ "$comparison" -eq 0 ] && [ -f "$baseline_path" ]; then
      printf '%s|no-op|%s|version %s\n' "$label" "$target_path" "$INSTALL_VERSION" >> "$STATUS_FILE"
      return
    fi
    if [ "$comparison" -gt 0 ]; then
      replace_path "$source_path" "$target_path"
      write_managed_state "$target_path" "$baseline_path"
      printf '%s|updated|%s|%s -> %s\n' "$label" "$target_path" "$deployed_version" "$INSTALL_VERSION" >> "$STATUS_FILE"
      return
    fi
  fi

  if paths_equal "$target_path" "$source_path"; then
    write_managed_state "$target_path" "$baseline_path"
    printf '%s|adopted-identical|%s|version %s\n' "$label" "$target_path" "$INSTALL_VERSION" >> "$STATUS_FILE"
    return
  fi

  backup_path=$(backup_existing_path "$target_path")
  replace_path "$source_path" "$target_path"
  write_managed_state "$target_path" "$baseline_path"
  printf '%s|adopted|%s|backup %s; version %s\n' "$label" "$target_path" "$backup_path" "$INSTALL_VERSION" >> "$STATUS_FILE"
}

tree_digest() {
  root=$1
  (
    cd "$root"
    find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
      shasum -a 256 "$file"
    done
  ) | shasum -a 256 | awk '{ print $1 }'
}

path_digest() {
  pathname=$1
  if [ -d "$pathname" ]; then
    tree_digest "$pathname"
  elif [ -f "$pathname" ]; then
    shasum -a 256 "$pathname" | awk '{ print $1 }'
  else
    die "cannot digest managed path: $pathname"
  fi
}

shell_quote() {
  escaped=$(printf '%s' "$1" | sed "s/'/'\\\\''/g")
  printf "'%s'" "$escaped"
}

select_rust_bin() {
  candidate=$1
  if [ -x "$candidate/cargo" ] && [ -x "$candidate/rustc" ]; then
    RUST_BIN=$candidate
    return 0
  fi
  return 1
}

resolve_rust_bin() {
  RUST_BIN=

  rust_channel=$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$SCRIPT_DIR/rust-toolchain.toml" | sed -n '1p')
  [ -n "$rust_channel" ] || die "cannot read Rust channel from $SCRIPT_DIR/rust-toolchain.toml"

  if [ -n "${KARAZHAN_RUST_TOOLCHAIN_BIN:-}" ]; then
    select_rust_bin "$KARAZHAN_RUST_TOOLCHAIN_BIN" || \
      die "KARAZHAN_RUST_TOOLCHAIN_BIN must contain executable cargo and rustc: $KARAZHAN_RUST_TOOLCHAIN_BIN"
    return
  fi

  cargo_command=$(command -v cargo 2>/dev/null || true)
  if [ -n "$cargo_command" ]; then
    select_rust_bin "$(dirname -- "$cargo_command")" || \
      die "cargo is on PATH but rustc is not available beside it: $cargo_command"
    return
  fi

  case "$(uname -m)" in
    arm64) rust_target=aarch64-apple-darwin ;;
    x86_64) rust_target=x86_64-apple-darwin ;;
    *) die "unsupported macOS architecture for Rust installation: $(uname -m)" ;;
  esac

  rustup_home=${RUSTUP_HOME:-"$HOME/.rustup"}
  cargo_home=${CARGO_HOME:-"$HOME/.cargo"}
  select_rust_bin "$rustup_home/toolchains/$rust_channel-$rust_target/bin" || true
  [ -n "$RUST_BIN" ] && return

  require_command curl
  rustup_command="$cargo_home/bin/rustup"
  if [ ! -x "$rustup_command" ]; then
    printf 'karazhan install: Rust %s is missing; installing rustup in %s\n' \
      "$rust_channel" "$cargo_home" >&2
    rustup_installer="$INSTALL_TMP/rustup-init.sh"
    HTTP_PROXY="$INSTALL_PROXY" HTTPS_PROXY="$INSTALL_PROXY" ALL_PROXY="$INSTALL_PROXY" \
      curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
        https://sh.rustup.rs --output "$rustup_installer"
    CARGO_HOME="$cargo_home" RUSTUP_HOME="$rustup_home" \
      HTTP_PROXY="$INSTALL_PROXY" HTTPS_PROXY="$INSTALL_PROXY" ALL_PROXY="$INSTALL_PROXY" \
      sh "$rustup_installer" -y --profile minimal --default-toolchain none
  fi

  [ -x "$rustup_command" ] || die "rustup installation did not create: $rustup_command"
  CARGO_HOME="$cargo_home" RUSTUP_HOME="$rustup_home" \
    HTTP_PROXY="$INSTALL_PROXY" HTTPS_PROXY="$INSTALL_PROXY" ALL_PROXY="$INSTALL_PROXY" \
    "$rustup_command" toolchain install "$rust_channel" --profile minimal \
      --component clippy --component rustfmt

  select_rust_bin "$rustup_home/toolchains/$rust_channel-$rust_target/bin" || \
    die "rustup did not install the expected Rust toolchain: $rust_channel-$rust_target"
}

if [ "$SKIP_BUILD" != 1 ]; then
  [ "$(uname -s)" = Darwin ] || die "the Karazhan desktop bundle currently supports macOS only"
  if [ "$SKIP_APP" != 1 ]; then
    require_command npm
  fi
  resolve_rust_bin
  (
    cd "$SCRIPT_DIR"
    PATH="$RUST_BIN:$PATH"
    export PATH
    rust_sysroot=$("$RUST_BIN/rustc" --print sysroot)
    [ -d "$rust_sysroot/lib" ] || die "Rust sysroot library directory is missing: $rust_sysroot/lib"
    if [ -n "${DYLD_LIBRARY_PATH:-}" ]; then
      rust_dyld_library_path="$rust_sysroot/lib:$DYLD_LIBRARY_PATH"
    else
      rust_dyld_library_path="$rust_sysroot/lib"
    fi
    HTTP_PROXY="$INSTALL_PROXY" HTTPS_PROXY="$INSTALL_PROXY" ALL_PROXY="$INSTALL_PROXY" \
      CARGO_NET_OFFLINE=false "$RUST_BIN/cargo" fetch --locked
    if [ "$SKIP_APP" != 1 ]; then
      HTTP_PROXY="$INSTALL_PROXY" HTTPS_PROXY="$INSTALL_PROXY" ALL_PROXY="$INSTALL_PROXY" npm ci
      HTTP_PROXY="$INSTALL_PROXY" HTTPS_PROXY="$INSTALL_PROXY" ALL_PROXY="$INSTALL_PROXY" \
        CARGO_NET_OFFLINE=true DYLD_LIBRARY_PATH="$rust_dyld_library_path" npm run desktop:build
    fi
    DYLD_LIBRARY_PATH="$rust_dyld_library_path" \
      "$RUST_BIN/cargo" build --offline --release -p karazhan-mcp
  )
fi

if [ "$SKIP_APP" != 1 ]; then
  [ -d "$APP_SOURCE" ] || die "Karazhan app bundle not found: $APP_SOURCE"
fi
[ -f "$MCP_SOURCE" ] || die "Karazhan MCP binary not found: $MCP_SOURCE"
[ -x "$MCP_SOURCE" ] || die "Karazhan MCP binary is not executable: $MCP_SOURCE"

[ ! -L "$PROFILE_DIR" ] || die "Medivh profile path must not be a symlink: $PROFILE_DIR"
if [ ! -d "$PROFILE_DIR" ]; then
  "$HERMES_COMMAND" profile create "$PROFILE_NAME" --no-skills \
    --description "Prepare top-level Project Workspaces without connecting to Karazhan"
  [ -d "$PROFILE_DIR" ] || die "Hermes did not create the expected profile: $PROFILE_DIR"
fi

PACKAGE_SOURCE="$INSTALL_TMP/custodian-startup-kit"
mkdir -p "$PACKAGE_SOURCE/.agents/skills"
cp -R "$SCRIPT_DIR/blueprints/skills/workspace-provisioning" \
  "$PACKAGE_SOURCE/.agents/skills/workspace-provisioning"
cp -R "$SCRIPT_DIR/blueprints/skills/karazhan-mcp-collaboration" \
  "$PACKAGE_SOURCE/.agents/skills/karazhan-mcp-collaboration"

SOURCE_COMMIT=$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || printf unknown)
SKILLS_DIGEST=$(tree_digest "$PACKAGE_SOURCE/.agents/skills")
if git -C "$SCRIPT_DIR" diff --quiet -- blueprints/skills && \
   git -C "$SCRIPT_DIR" diff --cached --quiet -- blueprints/skills; then
  SOURCE_STATE=clean
else
  SOURCE_STATE=modified
fi
cat > "$PACKAGE_SOURCE/.agents/skills/PACKAGE.md" <<EOF
# Custodian startup kit

- Install version: $INSTALL_VERSION
- Source repository: $SCRIPT_DIR
- Source commit: $SOURCE_COMMIT
- Source state: $SOURCE_STATE
- Skills digest (SHA-256): $SKILLS_DIGEST
- Installed Skills: workspace-provisioning, karazhan-mcp-collaboration
EOF

PROFILE_LITERAL=$(shell_quote "$PROFILE_DIR")
HERMES_LITERAL=$(shell_quote "$HERMES_COMMAND")
PROFILE_NAME_LITERAL=$(shell_quote "$PROFILE_NAME")
LAUNCHER_SOURCE="$INSTALL_TMP/medivh"
cat > "$LAUNCHER_SOURCE" <<EOF
#!/bin/sh
set -eu

# Managed by Karazhan install.sh version $INSTALL_VERSION. Local edits cause the next update to stop.
PROFILE_DIR=$PROFILE_LITERAL
HERMES_COMMAND=$HERMES_LITERAL
PROFILE_NAME=$PROFILE_NAME_LITERAL
LOCK_DIR="\$PROFILE_DIR/.medivh-launch.lock"

if command -v pgrep >/dev/null 2>&1 && \
   pgrep -f "[h]ermes.*(-p|--profile)[[:space:]]+\$PROFILE_NAME([[:space:]]|\$)" >/dev/null 2>&1; then
  printf 'medivh: Medivh is already running for profile %s\n' "\$PROFILE_NAME" >&2
  exit 3
fi

acquire_lock() {
  if mkdir "\$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "\$\$" > "\$LOCK_DIR/pid"
    return
  fi
  [ ! -L "\$LOCK_DIR" ] || {
    printf 'medivh: unsafe symlink at lock path: %s\n' "\$LOCK_DIR" >&2
    exit 1
  }
  old_pid=\$(cat "\$LOCK_DIR/pid" 2>/dev/null || true)
  case "\$old_pid" in
    ''|*[!0-9]*) ;;
    *)
      if kill -0 "\$old_pid" 2>/dev/null; then
        printf 'medivh: Medivh is already running (pid %s)\n' "\$old_pid" >&2
        exit 3
      fi
      ;;
  esac
  rm -f "\$LOCK_DIR/pid"
  rmdir "\$LOCK_DIR" 2>/dev/null || {
    printf 'medivh: cannot clear stale lock: %s\n' "\$LOCK_DIR" >&2
    exit 1
  }
  mkdir "\$LOCK_DIR"
  printf '%s\n' "\$\$" > "\$LOCK_DIR/pid"
}

release_lock() {
  rm -f "\$LOCK_DIR/pid"
  rmdir "\$LOCK_DIR" 2>/dev/null || true
}

acquire_lock
trap release_lock EXIT
trap 'exit 130' HUP INT TERM
cd "\$PROFILE_DIR"
"\$HERMES_COMMAND" -p "\$PROFILE_NAME" chat
EOF
chmod 755 "$LAUNCHER_SOURCE"

BASELINE_ROOT="$STATE_DIR/baseline"
PROFILE_SOUL_SOURCE="$SCRIPT_DIR/blueprints/medivh/SOUL.md"
PROFILE_AGENTS_SOURCE="$SCRIPT_DIR/blueprints/medivh/AGENTS.md"
PROFILE_SKILL_SOURCE="$SCRIPT_DIR/blueprints/skills/workspace-provisioning"
PROFILE_PACKAGE_TARGET="$PROFILE_DIR/packages/custodian-startup-kit"

if [ "$SKIP_APP" != 1 ]; then
  preflight_managed_path "$APP_SOURCE" "$APP_DIR/Karazhan.app" "$BASELINE_ROOT/app/Karazhan.app"
fi
preflight_managed_path "$MCP_SOURCE" "$BIN_DIR/karazhan-mcp" "$BASELINE_ROOT/bin/karazhan-mcp"
preflight_managed_path "$LAUNCHER_SOURCE" "$LAUNCHER_TARGET" "$BASELINE_ROOT/bin/medivh"
preflight_managed_path "$PROFILE_SOUL_SOURCE" "$PROFILE_DIR/SOUL.md" "$BASELINE_ROOT/medivh/SOUL.md"
preflight_managed_path "$PROFILE_AGENTS_SOURCE" "$PROFILE_DIR/AGENTS.md" "$BASELINE_ROOT/medivh/AGENTS.md"
preflight_managed_path "$PROFILE_SKILL_SOURCE" "$PROFILE_DIR/skills/karazhan/workspace-provisioning" "$BASELINE_ROOT/medivh/skills/workspace-provisioning"
preflight_managed_path "$PACKAGE_SOURCE" "$PROFILE_PACKAGE_TARGET" "$BASELINE_ROOT/medivh/packages/custodian-startup-kit"

if [ "$SKIP_APP" != 1 ]; then
  install_versioned_path "Karazhan app" "$APP_SOURCE" "$APP_DIR/Karazhan.app" "$BASELINE_ROOT/app/Karazhan.app"
else
  printf '%s|skipped|%s|KARAZHAN_INSTALL_SKIP_APP=1\n' "Karazhan app" "$APP_DIR/Karazhan.app" >> "$STATUS_FILE"
fi
install_versioned_path "Karazhan MCP" "$MCP_SOURCE" "$BIN_DIR/karazhan-mcp" "$BASELINE_ROOT/bin/karazhan-mcp"
install_versioned_path "Medivh launcher" "$LAUNCHER_SOURCE" "$LAUNCHER_TARGET" "$BASELINE_ROOT/bin/medivh"
install_versioned_path "Medivh SOUL" "$PROFILE_SOUL_SOURCE" "$PROFILE_DIR/SOUL.md" "$BASELINE_ROOT/medivh/SOUL.md"
install_versioned_path "Medivh AGENTS" "$PROFILE_AGENTS_SOURCE" "$PROFILE_DIR/AGENTS.md" "$BASELINE_ROOT/medivh/AGENTS.md"
install_versioned_path "Medivh provisioning Skill" "$PROFILE_SKILL_SOURCE" "$PROFILE_DIR/skills/karazhan/workspace-provisioning" "$BASELINE_ROOT/medivh/skills/workspace-provisioning"
install_versioned_path "Custodian startup kit" "$PACKAGE_SOURCE" "$PROFILE_PACKAGE_TARGET" "$BASELINE_ROOT/medivh/packages/custodian-startup-kit"

printf 'Karazhan install %s results:\n' "$INSTALL_VERSION"
while IFS='|' read -r label status target detail; do
  printf '  %-26s %-18s %s (%s)\n' "$label" "$status" "$target" "$detail"
done < "$STATUS_FILE"
printf '  %-26s %-18s %s\n' "Medivh user data" "preserved" "$PROFILE_DIR/memories, $PROFILE_DIR/sessions, and non-managed Skills"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to PATH to run: medivh\n' "$BIN_DIR" ;;
esac
