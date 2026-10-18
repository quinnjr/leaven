#!/usr/bin/env bash
# Registers this repo's release workflow as the npm trusted publisher (OIDC)
# for every public workspace package, so CI can publish without an NPM_TOKEN.
#
# Run by a maintainer with npm 2FA who is already logged in to npm (the script
# never logs in itself):
#   pnpm trust:npm --dry-run   # preview
#   pnpm trust:npm
#
# Packages that already trust this repo's release workflow are skipped, so the
# script is safe to re-run after adding a package.
#
# A package must already exist on the registry before a trusted publisher can
# be attached to it, so a brand-new package needs one manual first publish;
# packages not on the registry yet are skipped with a notice.
set -euo pipefail

REPO="quinnjr/leaven"
WORKFLOW="release.yml"

root="$(cd "$(dirname "$0")/.." && pwd)"
packages=$(cd "$root" && node -e '
  const fs = require("node:fs");
  for (const dir of fs.readdirSync("packages")) {
    const file = `packages/${dir}/package.json`;
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!pkg.private) console.log(pkg.name);
  }')

# Run npm outside pnpm's configuration: `pnpm run` exports its settings as
# npm_config_* variables (including a globalconfig pointing at pnpm's config),
# and the repo .npmrc holds pnpm-only keys. npm warns about every one of them.
# The npm login in ~/.npmrc is still read.
while IFS= read -r var; do unset "$var"; done < <(env | grep -io '^npm_config_[^=]*' || true)
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
npm11() { (cd "$workdir" && pnpm --silent dlx npm@11 "$@"); }

if ! npm11 whoami >/dev/null 2>&1; then
  echo "Not logged in to npm. Log in first (npm login), then re-run." >&2
  exit 1
fi

# Exit 0 when the package already trusts $REPO's $WORKFLOW, 1 when it does not,
# 2 when the check itself failed (npm sometimes demands a one-time password
# just to list). `npm trust list --json` prints one object for a single
# relationship, an array for several, and `{ "error": ... }` on failure.
trust_status() {
  npm11 trust list "$1" --json 2>/dev/null | REPO="$REPO" WORKFLOW="$WORKFLOW" node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(input || "[]"); } catch { process.exit(2); }
      if (parsed && !Array.isArray(parsed) && parsed.error) process.exit(2);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const match = entries.some((entry) =>
        entry && entry.type === "github" &&
        entry.repository === process.env.REPO &&
        entry.file === process.env.WORKFLOW);
      process.exit(match ? 0 : 1);
    });'
}

for pkg in $packages; do
  echo "==> $pkg"
  if ! npm11 view "$pkg" name >/dev/null 2>&1; then
    echo "    skipped: not on the registry yet (publish it manually once first)"
    continue
  fi
  status=0
  trust_status "$pkg" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "    skipped: already trusts $REPO ($WORKFLOW)"
    continue
  fi
  if [ "$status" -eq 2 ]; then
    echo "    could not check existing trust (npm wanted a one-time password); trying anyway"
  fi
  npm11 trust github "$pkg" --file "$WORKFLOW" --repo "$REPO" --allow-publish --yes "$@"
  # The registry rate-limits trust changes; npm recommends spacing calls.
  sleep 2
done
