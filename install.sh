#!/bin/sh
#
# RingZero installer (macOS / Linux) — downloads the portable zip from the
# latest GitHub release, installs it under ~/.local/share/ringzero and puts
# `ringzero` on your PATH via ~/.local/bin (no admin / sudo needed).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/abbychau/ringzero/main/install.sh | sh
#
# What it does:
#   - Detects your OS (macOS/Linux) and CPU (x64/arm64) and downloads the
#     matching ringzero-<platform>-<arch>.zip from GitHub Releases.
#   - Unpacks it into ~/.local/share/ringzero (respects $XDG_DATA_HOME).
#   - Symlinks ~/.local/bin/ringzero -> the installed launcher, and adds
#     ~/.local/bin to your PATH via your shell rc file if it isn't there.
#   - Runs `ringzero --version` so the first-run unpack happens during install.
#
# The script is intentionally small and reviewable:
#   https://github.com/abbychau/ringzero/blob/main/install.sh
#
set -eu

user_agent='ringzero-installer'
repo='abbychau/ringzero'

# --- detect platform / arch ------------------------------------------------
os="$(uname -s)"
cpu="$(uname -m)"
case "$os" in
  Linux) plat='linux' ;;
  Darwin) plat='darwin' ;;
  *)
    echo "Unsupported OS: $os (this installer supports macOS and Linux)" >&2
    exit 1
    ;;
esac
case "$cpu" in
  x86_64 | amd64) arch='x64' ;;
  aarch64 | arm64) arch='arm64' ;;
  *)
    echo "Unsupported architecture: $cpu" >&2
    exit 1
    ;;
esac
# Prefer the single-file bun binary; fall back to the portable zip.
asset_bin="ringzero-$plat-$arch"
asset_zip="ringzero-$plat-$arch.zip"
asset="$asset_bin"

# --- install locations ------------------------------------------------------
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
install_dir="$data_dir/ringzero"
bin_dir="$HOME/.local/bin"
bin_path="$bin_dir/ringzero"

# --- fetch the latest release asset URL ------------------------------------
echo 'Fetching the latest RingZero release...'
release_json="$(curl -fsSL -A "$user_agent" \
  "https://api.github.com/repos/$repo/releases/latest")"
asset_url="$(printf '%s' "$release_json" | grep -o "https://[^\"]*$asset" | head -n 1)"
if [ -z "$asset_url" ] && [ "$asset" != "$asset_zip" ]; then
  asset="$asset_zip"
  asset_url="$(printf '%s' "$release_json" | grep -o "https://[^\"]*$asset" | head -n 1)"
fi
if [ -z "$asset_url" ]; then
  echo "Could not find $asset in the latest release." >&2
  exit 1
fi
version="$(printf '%s' "$release_json" | grep -o '"tag_name": *"[^"]*"' | head -n 1 | sed 's/.*"v\?//; s/"$//')"

# --- download & unpack ------------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading RingZero v${version} ($asset)..."
curl -fsSL -A "$user_agent" -o "$tmp/$asset" "$asset_url"
echo "Installing to $install_dir..."
mkdir -p "$install_dir" "$bin_dir"
rm -rf "$install_dir"
mkdir -p "$install_dir"
if [ "$asset" = "$asset_zip" ]; then
  # Portable zip: extract (the zip contains a ringzero/ folder).
  mkdir -p "$tmp/unz"
  unzip -q -o "$tmp/$asset" -d "$tmp/unz"
  mv "$tmp/unz/ringzero" "$install_dir/app"
  ln -sf "$install_dir/app/ringzero" "$bin_path"
else
  # Single-file bun binary.
  install -m 755 "$tmp/$asset" "$install_dir/ringzero"
  ln -sf "$install_dir/ringzero" "$bin_path"
fi

# --- PATH -------------------------------------------------------------------
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    if command -v zsh >/dev/null 2>&1 && [ -n "${ZSH_VERSION:-}" ]; then
      rc="$HOME/.zshrc"
    elif [ "$plat" = 'darwin' ] && [ -f "$HOME/.zprofile" ]; then
      rc="$HOME/.zprofile"
    elif [ -f "$HOME/.bashrc" ]; then
      rc="$HOME/.bashrc"
    else
      rc="$HOME/.profile"
    fi
    if ! grep -qs "$bin_dir" "$rc" 2>/dev/null; then
      printf '\n# added by RingZero installer\nexport PATH="%s:$PATH"\n' "$bin_dir" >>"$rc"
    fi
    ;;
esac

echo 'Running first-time setup...'
"$bin_path" --version

echo ''
echo "RingZero v${version} installed. Type 'ringzero' to start."
echo '  docs:      https://github.com/abbychau/ringzero'
echo "  uninstall: rm -rf \"$install_dir\" ; rm -f \"$bin_path\" ; remove the ~/.local/bin PATH line from your shell rc"
