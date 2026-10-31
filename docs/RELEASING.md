# Releasing dynalitics

Publishing and `git commit` are done by a human maintainer, never by an agent. This page describes the pipeline in `.github/workflows/` and the one-time setup it needs. The pipeline is **designed** so that no npm token is stored anywhere (publishing uses npm trusted publishing over OIDC and asks for a provenance statement), but **it has never run on GitHub, no package has been published, and the trusted publisher is not configured yet**. Until the first real release you cannot claim that provenance works.

## What the pipeline does

| Workflow      | Trigger                                                      | Does                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`      | every push to `main`, every PR; also called by `release.yml` | job `verify`: `npm ci`, lint, typecheck, format check, build, **unit tests with the coverage thresholds** (`npm run test:coverage`), protocol-types sync, `npm audit --audit-level=high`. Jobs `integration (postgres)` and `integration (mysql)`: the integration tests against a real database each, started with `docker run`. Job `package-contents`: `scripts/check-release.mjs --ci` (what would be published)   |
| `release.yml` | push to `main` that changes a package, or manual (dry run)   | job `version` computes the next version; job `ci` calls `ci.yml`, job `mssql` calls `mssql.yml`, both for the same commit; job `release-checks` runs the strict package check for that version; job `publish`, behind the `npm-publish` environment, publishes five packages with provenance and tags the commit; job `publish-mssql` publishes `dynalitics-mssql` only if `mssql` is green (see "Publishing on push") |
| `mssql.yml`   | every push to `main`, every PR; also called by `release.yml` | job `integration (mssql)`: the integration tests against SQL Server 2022. **Not** part of the release gate for the other packages; it decides only whether `dynalitics-mssql` is published                                                                                                                                                                                                                             |

### The release gate

`publish` has `needs: [ci, release-checks, version]`. Because `ci` is the whole of `ci.yml` called as a reusable workflow on the same commit, **a release cannot be published unless the unit job, the PostgreSQL and MySQL integration jobs and the package-contents job are all green for that exact commit.** If one of them fails, is cancelled or is skipped, GitHub skips `publish`. SQL Server is gated separately: `publish-mssql` needs `mssql` and `publish`, so a red SQL Server job holds back only `dynalitics-mssql` (decided by the maintainer on 2026-11-01, when the first real SQL Server run found a bug).

This is pinned by `scripts/release-workflow.test.ts` (it fails if `publish` stops needing `ci`, a publish job gets a job-level `if:` override, `dynalitics-mssql` stops depending on the SQL Server job, the version is not applied before a build, the SHA pins go or an npm token appears), and the workflows are checked with actionlint when they change. Neither has replaced running the workflow for real: the first push to `main` after the trusted publishers are set up is the first real test.

A manual run of `release.yml` (Actions tab, "Run workflow") defaults to **dry run**. A real publish needs `main` (a push, or a manual run on `main` with the dry-run input turned off); a run on any other branch can never publish, whatever the input says. A run also runs the full `ci.yml` and `mssql.yml`, so it takes as long as a normal CI run (the SQL Server job is the slowest).

`scripts/check-release.mjs` runs `npm pack --dry-run --json` for each package and fails if: a package is still `private`, the version is not semver or differs from the tag, the license is not MIT, `engines.node` does not require Node 22+, `repository`/`homepage`/`bugs` still contain the `OWNER` placeholder, there are runtime `dependencies` other than an adapter's one exactly pinned driver, an adapter's `dynalitics` peer is not the same version, or there are install-time scripts, any file referenced by `exports`/`bin`/`main`/`types` is missing (build first), the package `LICENSE` differs from the root one, or the tarball contains anything outside `dist/`, `package.json`, `README.md`, `LICENSE` (no `src/`, `test/`, source maps, `.env`, keys).

All six packages are released in lockstep: the same version number, one tag. The adapters' `peerDependencies.dynalitics` must equal that version too (`npm version` does not change peer ranges; the release check catches it).

## One-time setup (needs the repository owner)

1. **Create the GitHub repository** and replace `OWNER` in every `packages/*/package.json` (`repository.url`, `homepage`, `bugs.url`) and in the package READMEs. _Done 2026-10-31: `https://github.com/lucsoftsl/dynalitics`, branch `main`. Package READMEs link to each other through npmjs.com and to repository docs through absolute GitHub URLs, so they work on npm._ npm provenance requires `repository.url` to match the repository that runs the workflow; until then the strict release check fails on purpose.
2. **Fill in the security contact** in `SECURITY.md` (_done 2026-11-01_) and enable GitHub private vulnerability reporting (Settings, Code security).
3. **GitHub environment:** Settings, Environments, create `npm-publish`, restricted to the `main` branch. Optionally add yourself as a required reviewer so every release waits for your click; without one, every qualifying push to `main` publishes.
4. **npm trusted publisher**, for each package once it exists on npm: npmjs.com, the package, Settings, "Trusted Publisher", GitHub Actions, then enter: owner and repository, workflow filename `release.yml`, environment `npm-publish`. Trusted publishing needs npm 11.5.1 or newer (the workflow installs a pinned one).
   - If npm does not let you configure a trusted publisher before a package exists, do the very first publish of each package yourself from your machine with 2FA (`npm publish --access public`), then configure the trusted publisher and use the workflow from then on. The first version published that way has no provenance.
5. Set npm account 2FA to "authorization and writes" and consider "Require two-factor authentication or a granular access token with bypass 2FA enabled" plus disallowing tokens once trusted publishing works.
6. **Branch protection on `main`:** require these four status checks, by name: `verify`, `integration (postgres)`, `integration (mysql)` and `package-contents` (add `integration (mssql)` once SQL Server is green and should block merges). The `CI` workflow name alone is not enough: the check names are the job names. Only the repository settings can enforce this.
7. **Who can release:** a push to `main` is what starts a release, so branch protection (step 6) and the optional `npm-publish` reviewer (step 3) are the locks. Tags are created by the workflow; restrict manual `v*` tag creation (Settings, Rules) so tags keep meaning "published".

## The first release, 0.1.0 (from a maintainer's machine)

npm cannot attach a trusted publisher to a package that does not exist yet, and the workflows have never published, so the first version is published by hand (one-time setup step 4, last bullet). It has **no provenance**. From a clean, committed and pushed `main`:

```sh
npm ci && npm run build && npm run lint && npm run typecheck && npm test
node scripts/check-release.mjs --tag v0.1.0
npm login                                   # the account that will own the packages; 2FA on
for w in dynalitics dynalitics-postgres dynalitics-mysql dynalitics-consent dynalitics-dashboard; do
  npm publish -w "$w" --access public --provenance=false --dry-run
done                                        # read the file lists, then run the loop again without --dry-run
git tag v0.1.0 && git push origin v0.1.0
```

`dynalitics-mssql` is left out on purpose until the SQL Server workflow is green (it is "TBD" in the READMEs). `--provenance=false` is required: `publishConfig.provenance` is `true` for the CI path, and npm refuses to create provenance outside a supported CI. `dynalitics` goes first because the adapters peer on it. Afterwards, set up the trusted publisher for each package (step 4), including `dynalitics-mssql` once it exists, so later releases go through `release.yml`.

## npm staged publishing (observed 2026-11-01)

npm put the first manual publish of every package into **staging**: each package got a public `0.0.0-stage` placeholder (and `latest` pointed at it) until a maintainer approved the real version on npmjs.com (package, "Staged Packages" tab, Approve, 2FA). `scripts/release-version.mjs` therefore ignores prerelease versions such as `0.0.0-stage` when it computes the next version. npm documents that trusted-publishing (OIDC) credentials cannot approve a staged version, so if staging stays on for a package, every automatic release waits for that approval before it is installable. Leave the placeholders alone; they are not `latest` once a real version is approved.

## Publishing on push (every later release)

Every push to `main` that changes something under `packages/` (tests excluded) or `package-lock.json` starts `release.yml`:

1. `version` asks npm for the latest `dynalitics` and takes the next patch (`0.1.0` → `0.1.1`). If the version in the repository is **ahead** of npm, the repository wins: to release `0.2.0` or `1.0.0`, change the version in the repository (all packages, the adapters' `dynalitics` peer and `packages/dynalitics/src/version.ts`, or run `node scripts/release-version.mjs apply 0.2.0`) and push. The workflow never commits; `package.json` in the repository keeps the base version and npm holds the truth.
2. `ci` (ci.yml: unit, PostgreSQL, MySQL, package contents) and `release-checks` (strict package check for that version) must both be green.
3. `publish` publishes `dynalitics`, `dynalitics-postgres`, `dynalitics-mysql`, `dynalitics-consent`, `dynalitics-dashboard` with that version and provenance, then creates the tag `vX.Y.Z` on the commit.
4. `publish-mssql` publishes `dynalitics-mssql` with the same version **only if** the SQL Server workflow (`mssql.yml`, called for the same commit) is green and `publish` succeeded. Otherwise it is skipped: SQL Server stays "TBD" and the other packages are released anyway.

The `npm-publish` environment can require your approval before each publish. Remove the required reviewer if releases should go out without a click. A manual run (Actions, Release, "Run workflow") is a dry run unless you start it on `main` with `dry_run` turned off.

Changes outside `packages/` (docs, scripts, workflows) do not start a release. To release anyway, run the workflow by hand: Actions, Release, Run workflow, branch `main`, `dry_run` unticked.

If a run fails half way (for example after `dynalitics` was published but before the dashboard), the next run computes the next patch and publishes everything again at that version; the half-released version stays on npm. Deprecate it: `npm deprecate dynalitics@X.Y.Z "incomplete release, use X.Y.Z+1"`.

## If something goes wrong

- **Never** `npm unpublish` a version that others may have installed. Publish a fixed patch version and run `npm deprecate dynalitics@X.Y.Z "reason, use X.Y.Z+1"`.
- If a credential or secret may have leaked, rotate it first and follow the process in `SECURITY.md`.
- Pinned actions (`actions/checkout`, `actions/setup-node`) are referenced by commit SHA. Update them deliberately and re-verify the SHA against the upstream release tag. There is no `dependabot.yml` in this repository, so nothing does this for you.

## Not covered yet

- **The workflows have never run on GitHub.** Everything above is checked by reading, by actionlint and by tests of the workflow text, not by a run.
- SQL Server runs only on GitHub Actions (the image does not run under emulation on arm64 Macs); its first run found a time-formatting bug, fixed since but not yet confirmed there.
- The dashboard end-to-end run (`npm run e2e -w dynalitics-dashboard`) needs Docker and Playwright and is not part of CI.
- Changelog automation and GitHub Release notes are manual.
