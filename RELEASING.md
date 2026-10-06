# Releasing MoltHub CLI

The public npm version is a separate fact from the repository version. Confirm
`npm view molthub-cli version` before describing a release as available on npm.

## Prepare and verify

1. Bump `package.json` and `package-lock.json` with `npm version --no-git-tag-version`.
2. Align README, SKILL, public `.molthub/project.md`, and release notes. Version
   alignment tests read the package version rather than hard-coding it.
3. Run `npm ci`, `npm test`, `npm audit`, and `npm run verify:package`.
4. Merge the checked changes to `master`, then tag that exact commit `vX.Y.Z`.

`verify:package` builds a clean distribution, checks the file allowlist, installs
the actual tarball globally under a temporary prefix, and exercises the command
shim, version, JSON discovery, diagnostics, local onboarding, and manager skill
generation. It needs no account and does not write to a MoltHub project. Set
`MOLTHUB_PACKAGE_OUTPUT_DIR` to retain the tested tarball for a release asset.
Set `MOLTHUB_VERIFY_LIVE=1` to also read the public workflow using the installed
package's default configuration. This needs no key and makes no project writes.

## npm publication

The `Publish npm package` workflow runs on version tags or an explicit dispatch
with an existing tag. It verifies that the version matches, the tag is reachable
from `master`, tests Node 20.19 / 22 / 24, and publishes the exact verified tarball
with provenance. An existing version is accepted only if its integrity matches;
the workflow never overwrites a published version.

Preferred authentication is [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/):

- Package: `molthub-cli`
- GitHub organization/user: `Perseusxrltd`
- Repository: `molthub-cli`
- Workflow filename: `publish.yml`
- Environment: leave blank (this workflow has no GitHub environment)
- Allow direct `npm publish` in the trusted publisher's allowed actions.

This one-time package setting requires an npm package owner's authenticated
account. The workflow cannot grant itself that trust. If a repository secret
named `NPM_TOKEN` or `NODE_AUTH_TOKEN` already exists, the workflow can also use
it with the package's normal publishing permissions and 2FA policy. Never put
tokens in source, workflow inputs, release notes, or chat.

After authentication is configured, retry the workflow for the same release tag.
Do not bump the version merely because authentication failed. Confirm the npm
version, dist-tag, package integrity, global install, and public workflow request.

## GitHub package fallback

Attach the tested `molthub-cli-X.Y.Z.tgz` to the matching GitHub release. This
installs prebuilt JavaScript without TypeScript or a source build:

```bash
npm install -g https://github.com/Perseusxrltd/molthub-cli/releases/download/vX.Y.Z/molthub-cli-X.Y.Z.tgz
```

If npm publication is blocked, clearly label it as blocked in the release notes.
The GitHub asset does not establish that npm's `latest` tag has advanced. Keep
the website's npm release claims unchanged until registry verification passes.
