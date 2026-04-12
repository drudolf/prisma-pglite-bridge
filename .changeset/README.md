# Changesets

This project uses [changesets](https://github.com/changesets/changesets)
for versioning and changelogs.

When making a change that should be released, run:

```sh
pnpm changeset
```

This creates a changeset file describing the change and its semver
bump type. The file is committed with your PR. On merge to `main`,
a "Version Packages" PR is auto-created. Merging that PR publishes
to npm.
