#!/bin/sh
# RingZero uninstaller (macOS / Linux) — removes what install.sh installed:
#   - the ~/.local/bin/ringzero symlink
#   - the app directory (~/.local/share/ringzero, or $XDG_DATA_HOME/ringzero)
#   - the PATH line the installer added to your shell rc files
#
# Your data (~/.ringzero — sessions, config, skills) is kept. Remove it
# separately with: rm -rf ~/.ringzero
#
# Usage:
#   curl -fsSL https://ringzero.abby.md/uninstall.sh | sh
set -eu

bin_dir="$HOME/.local/bin"
bin_path="$bin_dir/ringzero"
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/ringzero"

if [ -e "$bin_path" ] || [ -L "$bin_path" ]; then
  echo "Removing $bin_path ..."
  rm -f "$bin_path"
fi

if [ -d "$install_dir" ]; then
  echo "Removing $install_dir ..."
  rm -rf "$install_dir"
fi

# Remove the PATH lines the installer appended to rc files.
# The installer wrote exactly:
#   # added by RingZero installer
#   export PATH="$HOME/.local/bin:$PATH"
for rc in "$HOME/.zshrc" "$HOME/.zsh_profile" "$HOME/.bashrc" "$HOME/.profile" "$HOME/.zprofile"; do
  [ -f "$rc" ] || continue
  if grep -q 'added by RingZero installer' "$rc" 2>/dev/null; then
    echo "Cleaning PATH entry from $rc ..."
    # Delete the marker comment and the following export line.
    sed -i '/# added by RingZero installer/d; /^export PATH="\$HOME\/\.local\/bin:\$PATH"$/d' "$rc"
  fi
done

echo ''
echo 'RingZero uninstalled.'
echo 'Your data (~/.ringzero) was kept. Remove it with: rm -rf ~/.ringzero'
