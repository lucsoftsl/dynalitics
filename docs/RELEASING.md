# Releasing dynalitics

Publishing and `git commit` are done by a human maintainer, never by an agent. This page describes the pipeline in `.github/workflows/` and the one-time setup it needs. The pipeline is **designed** so that no npm token is stored anywhere (publishing uses npm trusted publishing over OIDC and asks for a provenance statement), but **it has never run on GitHub, no package has been published, and the trusted publisher is not configured yet**. Until the first real release you cannot claim that provenance works.

## What the pipeline does

| Workflow      | Trigger                                                      | Does                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`      | every push to `main`, every PR; also called by `release.yml` | job `verify`: `npm ci`, lint, typecheck, format check, build, **unit tests with the coverage thresholds** (`npm run test:coverage`), protocol-types sync, `npm audit --audit-level=high`. Jobs `integration (postgres)`, `integration (mysql)`, `integration (mssql)`: the integration tests against a real database each, started with `docker run`. Job `package-contents`: `scripts/check-release.mjs --ci` (what would be published) |
| `release.yml` | push of a tag `vX.Y.Z`, or manual                            | job `ci` calls `ci.yml` for the same commit; job `release-checks` runs the strict package check (no placeholders, both versions equal the tag); job `publish`, behind the `npm-publish` environment, runs `npm publish --provenance` for `dynalitics-dashboard` and `dynalitics`                                                                                                                                                         |

### The release gate

`publish` has `needs: [ci, release-checks]`. Because `ci` is the whole of `ci.yml` called as a reusable workflow on the tagged commit, **a release cannot be published unless the unit job, the PostgreSQL, MySQL and SQL Server integration jobs and the package-contents job are all green for that exact commit.** If one of them fails, is cancelled or is skipped, GitHub skips `publish`. SQL Server is part of the gate on purpose: it has never run on a real server, so the first green `integration (mssql)` run is also the first evidence that SQL Server works.

This is pinned by `scripts/release-workflow.test.ts` (it fails if `publish` stops needing `ci`, gets an `if:` override, loses the SQL Server leg, loses the SHA pins or gains an npm token), and the workflows are checked with actionlint when they change. Neither has replaced running the workflow for real: the first tag push is the first real test.

A manual run of `release.yml` (Actions tab, "Run workflow") defaults to **dry run**. A real publish needs a tag ref (a tag push, or a manual run started on a tag with the dry-run input turned off); a manual run on a branch can never publish, whatever the input says. A manual run also runs the full `ci.yml`, so it takes as long as a normal CI run (the SQL Server job is the slowest).

`scripts/check-release.mjs` runs `npm pack --dry-run --json` for each package and fails if: a package is still `private`, the version is not semver or differs from the tag, the license is not MIT, `engines.node` does not require Node 22+, `repository`/`homepage`/`bugs` still contain the `OWNER` placeholder, there are runtime `dependencies` or install-time scripts, any file referenced by `exports`/`bin`/`main`/`types` is missing (build first), the package `LICENSE` differs from the root one, or the tarball contains anything outside `dist/`, `package.json`, `README.md`, `LICENSE` (no `src/`, `test/`, source maps, `.env`, keys).

Both packages are released in lockstep: the same version number, one tag.

## One-time setup (needs the repository owner)

1. **Create the GitHub repository** and replace `OWNER` in every `packages/*/package.json` (`repository.url`, `homepage`, `bugs.url`) and in the package READMEs. _Done 2026-10-31: `https://github.com/lucsoftsl/dynalitics`, branch `main`. Package READMEs link to each other through npmjs.com and to repository docs through absolute GitHub URLs, so they work on npm._ npm provenance requires `repository.url` to match the repository that runs the workflow; until then the strict release check fails on purpose.
2. **Fill in the security contact** in `SECURITY.md` (it contains a marked placeholder) and enable GitHub private vulnerability reporting (Settings, Code security).
3. **GitHub environment:** Settings, Environments, create `npm-publish`. Add yourself as a required reviewer so a tag push waits for your approval. Restrict it to tags matching `v*`.
4. **npm trusted publisher**, for each of `dynalitics` and `dynalitics-dashboard`: npmjs.com, the package, Settings, "Trusted Publisher", GitHub Actions, then enter: owner and repository, workflow filename `release.yml`, environment `npm-publish`. Trusted publishing needs npm 11.5.1 or newer (the workflow installs a pinned one).
   - If npm does not let you configure a trusted publisher before a package exists, do the very first publish of each package yourself from your machine with 2FA (`npm publish --access public`), then configure the trusted publisher and use the workflow from then on. The first version published that way has no provenance.
5. Set npm account 2FA to "authorization and writes" and consider "Require two-factor authentication or a granular access token with bypass 2FA enabled" plus disallowing tokens once trusted publishing works.
6. **Branch protection on `main`:** require these five status checks, by name: `verify`, `integration (postgres)`, `integration (mysql)`, `integration (mssql)` and `package-contents`. The `CI` workflow name alone is not enough: the check names are the job names. Only the repository settings can enforce this.
7. **Tag protection:** restrict who can create `v*` tags (Settings, Rules), because a tag push is what starts a release. The `npm-publish` environment reviewer in step 3 is the second lock.

## Cutting a release

1. Make sure `main` is green and `docs/SPEC.md` matches what you are about to ship.
2. Bump both versions to the same number and refresh the lockfile: `npm version X.Y.Z --workspaces --no-git-tag-version`, then `npm install --package-lock-only`.
3. `npm ci && npm run build && npm run lint && npm run typecheck && npm test && node scripts/check-release.mjs --tag vX.Y.Z` locally.
4. Commit, push `main` and **wait for CI on that commit**. On the Actions page confirm that all five checks are green: `verify`, `integration (postgres)`, `integration (mysql)`, `integration (mssql)` (SQL Server included, no exceptions) and `package-contents`. The release workflow runs them again for the tagged commit and will not publish otherwise, but you should not tag a commit you have not seen pass.
5. Tag and push the tag (you, not an agent): `git tag vX.Y.Z`, `git push origin vX.Y.Z`.
6. Approve the `npm-publish` environment when GitHub asks. Check on npmjs.com that both packages show the provenance badge and that `npm pack` of the published version contains what you expect.

## If something goes wrong

- **Never** `npm unpublish` a version that others may have installed. Publish a fixed patch version and run `npm deprecate dynalitics@X.Y.Z "reason, use X.Y.Z+1"`.
- If a credential or secret may have leaked, rotate it first and follow the process in `SECURITY.md`.
- Pinned actions (`actions/checkout`, `actions/setup-node`) are referenced by commit SHA. Update them deliberately and re-verify the SHA against the upstream release tag. There is no `dependabot.yml` in this repository, so nothing does this for you.

## Not covered yet

- **The workflows have never run on GitHub.** Everything above is checked by reading, by actionlint and by tests of the workflow text, not by a run.
- The `integration (mssql)` job is the first and only time SQL Server will run against a real server.
- The dashboard end-to-end run (`npm run e2e -w dynalitics-dashboard`) needs Docker and Playwright and is not part of CI.
- Changelog automation and GitHub Release notes are manual.
