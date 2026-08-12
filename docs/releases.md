# Release guide

Provider Pulse releases are source releases identified by annotated Git tags.
Build output, local configuration, credential homes, API keys, logs, and
scheduler state are never release artifacts.

## Versioning policy

Use [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- patch for compatible fixes and documentation improvements;
- minor for compatible features;
- major for incompatible configuration, API, or operational changes.

Before 1.0, a minor release may contain an incompatible change, but the
changelog and release notes must include an explicit migration section.

## Prepare a release

1. Start from a clean, current `main` branch using the supported Node.js
   version from `package.json`.
2. Choose the version and update both package files without creating a tag:

   ```sh
   npm version X.Y.Z --no-git-tag-version
   ```

3. Move the relevant entries from `Unreleased` in `CHANGELOG.md` into a dated
   `X.Y.Z` section. Document configuration changes, provider CLI compatibility,
   migrations, and known limitations.
4. Review the complete diff. Confirm that it contains no real emails, account
   labels, absolute local home paths, tokens, API keys, logs, state, or generated
   `dist/` files.
5. Reinstall and run the complete non-provider verification suite. These tests
   use fakes and do not consume provider capacity:

   ```sh
   env -u NODE_ENV npm ci --ignore-scripts
   env -u NODE_ENV npm run typecheck
   env -u NODE_ENV npm test
   env -u NODE_ENV npm run build
   ```

6. Inspect `git status --short` and the generated `dist/` locally. Do not add
   `dist/` to the commit.
7. Commit the release metadata:

   ```sh
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "Release vX.Y.Z"
   ```

## Tag and publish

Create the release only from the verified release commit:

```sh
git tag -a vX.Y.Z -m "Provider Pulse vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

Prepare concise release notes with a summary, highlights, upgrade or migration
instructions, known limitations, and a link to the changelog. Save them outside
the repository working tree, review them, and publish:

```sh
gh release create vX.Y.Z \
  --repo kcosr/provider-pulse \
  --title "Provider Pulse vX.Y.Z" \
  --notes-file /path/to/release-notes.md
```

Before publishing, confirm that the tag resolves to the release commit and that
the GitHub source archives contain only tracked project files. Do not attach a
locally built archive unless a future release process defines and verifies a
portable artifact format.

## Upgrade an installation

Back up the operator configuration, then check out the desired release and
rebuild it:

```sh
install -m 0600 "$HOME/.config/provider-pulse/config.json" \
  "$HOME/.config/provider-pulse/config.json.backup"
git fetch --tags origin
git checkout vX.Y.Z
env -u NODE_ENV npm ci --ignore-scripts
env -u NODE_ENV npm run build
systemctl --user restart provider-pulse.service
systemctl --user status provider-pulse.service
```

Read every intervening changelog entry before restarting. Apply documented
configuration migrations first; the strict configuration parser intentionally
fails closed on obsolete or unknown fields.

Verify the dashboard and `GET /api/status` after restart. Status begins as
unknown after every process restart and is repopulated by configured startup
checks or manual checks.

## Roll back

Stop the service, check out the previously working tag, restore the matching
configuration if its schema changed, reinstall, rebuild, and restart:

```sh
systemctl --user stop provider-pulse.service
git checkout vPREVIOUS
env -u NODE_ENV npm ci --ignore-scripts
env -u NODE_ENV npm run build
systemctl --user start provider-pulse.service
```

Do not copy or roll back OAuth credential files as part of an application
rollback. Provider-owned refresh-token chains may have advanced since the prior
release. The scheduler cursor, usage baseline, and diagnostic log may remain in
place unless the release notes explicitly state otherwise.

## Hotfixes

Create hotfixes from the affected release tag, apply the smallest safe change,
increment the patch version, and follow the same verification and publication
steps. Merge the hotfix back into `main`; do not move or replace an existing
published tag.
