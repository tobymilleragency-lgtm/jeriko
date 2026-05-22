#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
jeriko_bin="${JERIKO_BIN:-$HOME/.local/bin/jeriko}"
installed_templates="$HOME/.local/lib/jeriko/templates"

echo "=== Jeriko app-builder audit ==="
date -Is

echo
echo "=== source status ==="
git -C "$repo_root" status --short || true
git -C "$repo_root" log -1 --oneline || true

echo
echo "=== installed binary ==="
if [[ -x "$jeriko_bin" ]]; then
  echo "binary=$jeriko_bin"
  sha256sum "$repo_root/jeriko" "$jeriko_bin" 2>/dev/null || sha256sum "$jeriko_bin" || true
else
  echo "missing executable: $jeriko_bin"
fi

echo
echo "=== installed template drift ==="
if [[ -d "$installed_templates" && -d "$repo_root/templates" ]]; then
  if diff -qr "$repo_root/templates" "$installed_templates" >/tmp/jeriko-template-drift.$$ 2>&1; then
    echo "templates=match"
  else
    echo "templates=DRIFT"
    sed -n '1,80p' /tmp/jeriko-template-drift.$$
  fi
  rm -f /tmp/jeriko-template-drift.$$
else
  echo "templates=missing source or installed template dir"
fi

echo
echo "=== daemon status ==="
systemctl --user is-active jeriko 2>/dev/null || true
systemctl --user show jeriko \
  -p MainPID -p ActiveState -p SubState -p NRestarts \
  -p MemoryCurrent -p MemoryPeak -p MemoryHigh -p MemoryMax -p MemorySwapMax \
  -p TasksCurrent -p TasksMax --no-pager 2>/dev/null || true

echo
echo "=== system resource pressure ==="
free -h || true
df -h / /tmp "$HOME" 2>/dev/null || true
df -ih / /tmp "$HOME" 2>/dev/null || true

echo
echo "=== recent OOM/resource evidence ==="
journalctl -k --since '6 hours ago' --no-pager 2>/dev/null \
  | grep -Ei 'oom|killed process|out of memory|memory cgroup|hung task|blocked for more than|segfault' \
  | tail -80 || true

echo
echo "=== latest Jeriko diagnose ==="
if [[ -x "$jeriko_bin" ]]; then
  tmp="$(mktemp)"
  if "$jeriko_bin" diagnose latest --format json > "$tmp" 2>/tmp/jeriko-diagnose-err.$$; then
    python3 - "$tmp" <<'PY'
import json, sys
p=sys.argv[1]
try:
    d=json.load(open(p)).get('data', {})
except Exception as exc:
    print(f'diagnose_json_parse_error={exc}')
    print(open(p, errors='ignore').read()[:1200])
    raise SystemExit
s=d.get('session') or {}
print('cwd=', d.get('cwd'))
print('session=', s.get('id'), s.get('title'), 'tokens=', s.get('token_count'))
print('likelyStuckReason=', d.get('likelyStuckReason'))
print('changedFiles=', d.get('changedFiles'))
print('diffStat=', d.get('diffStat'))
row=d.get('latestRow') or {}
print('latestRow=', row.get('rowid'), row.get('type'), row.get('tool'))
PY
  else
    echo "diagnose_failed"
    sed -n '1,80p' /tmp/jeriko-diagnose-err.$$ || true
  fi
  rm -f "$tmp" /tmp/jeriko-diagnose-err.$$
fi

echo
echo "=== recent daemon warnings ==="
journalctl --user -u jeriko --since '6 hours ago' --no-pager -p warning..alert 2>/dev/null | tail -120 || true

echo
echo "=== top app-builder-related RSS ==="
ps -eo pid,ppid,comm,rss,pmem,etime,args --sort=-rss \
  | grep -Ei 'jeriko|bun|node|vite|tsx|pnpm|chrome|playwright' \
  | grep -v grep \
  | head -40 || true
