#!/usr/bin/env bash
set -euo pipefail

APP="sigillo"
REPO="remorses/sigillo"
INSTALL_DIR="$HOME/.sigillo/bin"

say() {
  printf '%s\n' "$1"
}

fail() {
  say "error: $1" >&2
  exit 1
}

raw_os=$(uname -s)
case "$raw_os" in
  Darwin*) platform_os="darwin" ;;
  Linux*) platform_os="linux" ;;
  MINGW*|MSYS*|CYGWIN*) platform_os="win32" ;;
  *) fail "unsupported operating system: $raw_os" ;;
esac

raw_arch=$(uname -m)
case "$raw_arch" in
  arm64|aarch64) platform_arch="arm64" ;;
  x86_64|amd64) platform_arch="x64" ;;
  *) fail "unsupported architecture: $raw_arch" ;;
esac

target="$platform_os-$platform_arch"
case "$target" in
  darwin-arm64|darwin-x64|linux-arm64|linux-x64|win32-arm64|win32-x64) ;;
  *) fail "unsupported platform: $target" ;;
esac

archive_ext=".tar.gz"
binary_name="$APP"
if [ "$platform_os" = "win32" ]; then
  archive_ext=".zip"
  binary_name="$APP.exe"
fi

release_api_url="https://api.github.com/repos/$REPO/releases/latest"
release_json=$(curl -fsSL "$release_api_url")
tag_name=$(printf '%s' "$release_json" \
  | grep -Eo '"tag_name":[[:space:]]*"[^"]+"' \
  | sed -E 's/^"tag_name":[[:space:]]*"//; s/"$//')

if [ -z "$tag_name" ]; then
  fail "could not determine the latest release tag"
fi

asset_url="https://github.com/$REPO/releases/download/$tag_name/sigillo-$tag_name-$target$archive_ext"

say "Using release $tag_name"

mkdir -p "$INSTALL_DIR"
tmp_dir=$(mktemp -d)
trap 'rm -r "$tmp_dir"' EXIT
archive_path="$tmp_dir/$APP$archive_ext"

say "Downloading $asset_url"
curl -fL --progress-bar -o "$archive_path" "$asset_url"

if [ "$platform_os" = "win32" ]; then
  command -v unzip >/dev/null 2>&1 || fail "unzip is required to install $APP"
  unzip -oq "$archive_path" -d "$tmp_dir"
else
  command -v tar >/dev/null 2>&1 || fail "tar is required to install $APP"
  tar -xzf "$archive_path" -C "$tmp_dir"
fi

mv "$tmp_dir/$binary_name" "$INSTALL_DIR/$binary_name"
if [ "$platform_os" != "win32" ]; then
  chmod 755 "$INSTALL_DIR/$binary_name"
fi

shell_name=$(basename "${SHELL:-}")
path_line='export PATH="$HOME/.sigillo/bin:$PATH"'
config_file=''
case "$shell_name" in
  zsh) config_file="$HOME/.zshrc" ;;
  bash) config_file="$HOME/.bashrc" ;;
  fish) config_file="$HOME/.config/fish/config.fish" ;;
esac

if [ -n "$config_file" ]; then
  mkdir -p "$(dirname "$config_file")"
  touch "$config_file"
  if ! grep -Fqx "$path_line" "$config_file" 2>/dev/null; then
    printf '\n# sigillo\n%s\n' "$path_line" >> "$config_file"
    say "Added $INSTALL_DIR to PATH in $config_file"
  fi
else
  say "Add this to your shell config: $path_line"
fi

say ""
say "Installed $APP to $INSTALL_DIR/$binary_name"
say "Run: $INSTALL_DIR/$binary_name --help"
