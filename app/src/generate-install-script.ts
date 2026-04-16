// Generate the public curl installer script for the Sigillo CLI.

import fs from 'node:fs/promises'
import path from 'node:path'
import { Font } from '@ascii-kit/font'

const outputPath = path.join(import.meta.dirname, '..', 'public', 'install.sh')
const docsUrl = 'https://github.com/remorses/sigillo'
const installDirName = '.sigillo'

async function getLogoLines(): Promise<string[]> {
  const fontFileUrl = await import.meta.resolve('@ascii-kit/fonts-flf/dist/thick.flf')
  const fontData = await fs.readFile(new URL(fontFileUrl), 'utf8')
  const font = new Font(fontData)
  const logo = await font.text('sigillo')
  return logo.split('\n')
}

/*
IMPORTANT! all bash runtime variables like ${something} should be written as \${something} in this file!

because code is inside a js template literal where ${something} is replaced in the js code and not by bash in the script itself

try to use $something instead which does not have this problem

think very hard on the usage of \ escape sequences. we are in js template literal
*/
async function createInstallScript(): Promise<string> {
  const logoLines = await getLogoLines()
  const logoEchoScript = logoLines.map((line) => {
    return `echo -e "${line.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`')}"`
  }).join('\n')

  return String.raw`#!/usr/bin/env bash
set -euo pipefail

APP="sigillo"
REPO="remorses/sigillo"

MUTED='\033[0;2m'
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
ORANGE='\033[38;2;255;192;0m'
BOLD='\033[1m'
NC='\033[0m' # No Color

raw_os=$(uname -s)
os=$(echo "$raw_os" | tr '[:upper:]' '[:lower:]')
case "$raw_os" in
  Darwin*) os="darwin" ;;
  Linux*) os="linux" ;;
  MINGW*|MSYS*|CYGWIN*) os="win32" ;;
esac

arch=$(uname -m)
if [[ "$arch" == "aarch64" ]]; then
  arch="arm64"
fi
if [[ "$arch" == "x86_64" ]] || [[ "$arch" == "amd64" ]]; then
  arch="x64"
fi

combo="$os-$arch"
case "$combo" in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64|win32-arm64)
    ;;
  *)
    echo -e "${'${RED}'}Unsupported OS/Arch: $os/$arch${'${NC}'}"
    exit 1
    ;;
esac

archive_ext=".zip"
if [ "$os" != "win32" ]; then
  archive_ext=".tar.gz"
fi

binary_name="$APP"
if [ "$os" = "win32" ]; then
  binary_name="$APP.exe"
fi

if [ "$os" = "linux" ]; then
  if ! command -v tar >/dev/null 2>&1; then
    echo -e "${'${RED}'}Error: 'tar' is required but not installed.${'${NC}'}"
    exit 1
  fi
else
  if ! command -v unzip >/dev/null 2>&1; then
    echo -e "${'${RED}'}Error: 'unzip' is required but not installed.${'${NC}'}"
    exit 1
  fi
fi

INSTALL_DIR=$HOME/${installDirName}/bin
mkdir -p "$INSTALL_DIR"

release_api_url="https://api.github.com/repos/$REPO/releases/latest"
release_json=$(curl -fsSL "$release_api_url")
tag_name=$(printf '%s' "$release_json" | grep -Eo '"tag_name":[[:space:]]*"[^"]+"' | sed -E 's/^"tag_name":[[:space:]]*"//; s/"$//')

if [ -z "$tag_name" ]; then
  echo -e "${'${RED}'}Could not determine latest release tag.${'${NC}'}"
  exit 1
fi

filename="sigillo-$tag_name-$combo$archive_ext"
url="https://github.com/$REPO/releases/download/$tag_name/$filename"

print_message() {
  local level=$1
  local message=$2
  local color=""

  case $level in
    info) color="$NC" ;;
    warning) color="$NC" ;;
    error) color="$RED" ;;
  esac

  echo -e "${'${color}'}${'${message}'}${'${NC}'}"
}

unbuffered_sed() {
  if echo | sed -u -e "" >/dev/null 2>&1; then
    sed -nu "$@"
  elif echo | sed -l -e "" >/dev/null 2>&1; then
    sed -nl "$@"
  else
    local pad="$(printf "\n%512s" "")"
    sed -ne "s/$/\\${'${pad}'}" "$@"
  fi
}

print_progress() {
  local bytes="$1"
  local length="$2"
  [ "$length" -gt 0 ] || return 0

  local width=50
  local percent=$(( bytes * 100 / length ))
  [ "$percent" -gt 100 ] && percent=100
  local on=$(( percent * width / 100 ))
  local off=$(( width - on ))

  local filled=$(printf "%*s" "$on" "")
  filled=${'${filled// /■}'}
  local empty=$(printf "%*s" "$off" "")
  empty=${'${empty// /･}'}

  printf "\r${'${ORANGE}'}%s%s %3d%%${'${NC}'}" "$filled" "$empty" "$percent" >&4
}

download_with_progress() {
  local download_url="$1"
  local output="$2"

  if [ -t 2 ]; then
    exec 4>&2
  else
    exec 4>/dev/null
  fi

  local tmp_dir=${'${TMPDIR:-/tmp}'}
  local basename="${'${tmp_dir}'}${'/'}${'${APP}'}_install_$$"
  local tracefile="${'${basename}'}.trace"

  rm -f "$tracefile"
  mkfifo "$tracefile"

  printf "\033[?25l" >&4
  trap "trap - RETURN; rm -f \"$tracefile\"; printf '\033[?25h' >&4; exec 4>&-" RETURN

  (
    curl --trace-ascii "$tracefile" -s -L -o "$output" "$download_url"
  ) &
  local curl_pid=$!

  unbuffered_sed \
    -e 'y/ACDEGHLNORTV/acdeghlnortv/' \
    -e '/^0000: content-length:/p' \
    -e '/^<= recv data/p' \
    "$tracefile" | \
  {
    local length=0
    local bytes=0

    while IFS=" " read -r -a line; do
      [ "${'${#line[@]}'}" -lt 2 ] && continue
      local tag="${'${line[0]}'} ${'${line[1]}'}"

      if [ "$tag" = "0000: content-length:" ]; then
        length="${'${line[2]}'}"
        length=$(echo "$length" | tr -d '\r')
        bytes=0
      elif [ "$tag" = "<= recv" ]; then
        local size="${'${line[3]}'}"
        bytes=$(( bytes + size ))
        if [ "$length" -gt 0 ]; then
          print_progress "$bytes" "$length"
        fi
      fi
    done
  }

  wait $curl_pid
  local ret=$?
  echo "" >&4
  return $ret
}

download_and_install() {
  print_message info "\n${'${MUTED}'}Installing ${'${NC}'}sigillo"
  local tmp_install_dir="sigillotmp_$$"
  mkdir -p "$tmp_install_dir" && cd "$tmp_install_dir"

  trap "cd .. 2>/dev/null; rm -rf \"$tmp_install_dir\"" EXIT

  if [[ "$os" == "win32" ]] || ! download_with_progress "$url" "$filename"; then
    curl -# -L -o "$filename" "$url"
  fi

  if [ "$os" = "win32" ]; then
    unzip -o -q "$filename"
  else
    tar -xzf "$filename"
  fi

  if ! mkdir -p "$INSTALL_DIR"; then
    print_message error "Failed to create install directory: $INSTALL_DIR"
    exit 1
  fi

  mv "$binary_name" "$INSTALL_DIR/$binary_name"
  if [ "$os" != "win32" ]; then
    chmod 755 "$INSTALL_DIR/$binary_name"
  fi
}

download_and_install

add_to_path() {
  local config_file=$1
  local command=$2

  if grep -Fxq "$command" "$config_file"; then
    print_message info "Command already exists in $config_file, skipping write."
  elif [[ -w $config_file ]]; then
    echo -e "\n# sigillo" >> "$config_file"
    echo "$command" >> "$config_file"
    print_message info "${'${MUTED}'}Successfully added ${'${NC}'}sigillo ${'${MUTED}'}to \$PATH in ${'${NC}'}$config_file"
  else
    print_message warning "Manually add the directory to $config_file (or similar):"
    print_message info "  $command"
  fi
}

XDG_CONFIG_HOME=${'${XDG_CONFIG_HOME:-$HOME/.config}'}

current_shell=$(basename "$SHELL")
case $current_shell in
  fish)
    config_files="$HOME/.config/fish/config.fish"
    ;;
  zsh)
    config_files="$HOME/.zshrc $HOME/.zshenv $XDG_CONFIG_HOME/zsh/.zshrc $XDG_CONFIG_HOME/zsh/.zshenv"
    ;;
  bash)
    config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
    ;;
  ash)
    config_files="$HOME/.ashrc $HOME/.profile /etc/profile"
    ;;
  sh)
    config_files="$HOME/.ashrc $HOME/.profile /etc/profile"
    ;;
  *)
    config_files="$HOME/.bashrc $HOME/.bash_profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
    ;;
esac

config_file=""
for file in $config_files; do
  if [[ -f $file ]]; then
    config_file=$file
    break
  fi
done

if [[ -z $config_file ]]; then
  config_file=$(echo "$config_files" | awk '{print $1}')
  mkdir -p "$(dirname "$config_file")"
  touch "$config_file"
fi

if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  case $current_shell in
    fish)
      add_to_path "$config_file" "fish_add_path $INSTALL_DIR"
      ;;
    zsh|bash|ash|sh)
      add_to_path "$config_file" "export PATH=$INSTALL_DIR:\$PATH"
      ;;
    *)
      export PATH=$INSTALL_DIR:$PATH
      print_message warning "Manually add the directory to $config_file (or similar):"
      print_message info "  export PATH=$INSTALL_DIR:\$PATH"
      ;;
  esac
fi

if [ -n "${'${GITHUB_ACTIONS-}'}" ] && [ "${'${GITHUB_ACTIONS}'}" == "true" ]; then
  echo "$INSTALL_DIR" >> $GITHUB_PATH
  print_message info "Added $INSTALL_DIR to \$GITHUB_PATH"
fi

echo -e ""
${logoEchoScript}
echo -e ""
echo -e "cd <project>  ${'${MUTED}'}# Open directory${'${NC}'}"
echo -e "sigillo      ${'${MUTED}'}# Run command${'${NC}'}"
echo -e ""
echo -e "${'${MUTED}'}For more information visit ${'${NC}'}${docsUrl}"
echo -e ""
`
}

await fs.writeFile(outputPath, await createInstallScript(), 'utf8')
await fs.chmod(outputPath, 0o755)
