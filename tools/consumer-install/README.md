# consumer-install tests

## What it is

A private test package (`@statewalker/consumer-install-tests`) that checks the
published packages the way an npm user gets them. For each package listed in
`PACKAGES` in `consumer-install.test.ts`, it packs the package and the workspace
packages it depends on with `pnpm pack`, installs the tarballs with
`npm install` into a scratch directory, and imports every `exports` subpath with
plain Node.

## Layout

```
tools/consumer-install/
├── consumer-install.test.ts   the targets (PACKAGES) and the checks
├── vitest.config.ts           node environment, 15-minute timeouts
└── package.json
```

## How to run it

1. From the repository root: `pnpm install`.
2. `pnpm --filter @statewalker/consumer-install-tests test`

`pnpm pack` runs each package's `prepack` script, which builds it, so a prior
`pnpm build` is not needed. The root `pnpm test` runs this package too.

## Why it is the way it is

- **In-repo tests cannot see packaging bugs.** Inside the workspace every
  package resolves its siblings through workspace links, so a wrong `exports`
  target, a missing `dist/` file or an unresolved `workspace:` or `catalog:`
  specifier never shows up. Only a real install from tarballs does.
- **Siblings are packed from the working tree.** The harness packs the target's
  whole workspace-dependency closure and installs all tarballs in one
  `npm install`. Otherwise npm would fetch the sibling from the registry, and the
  test would check a mix of local and published code (and fail with a 404 when a
  local version is ahead of npm).
- **`npm`, not `pnpm`, installs.** npm cannot install `catalog:` or
  `workspace:` specifiers at all, so a leaked one fails loudly.

For each target the checks are:

- the subpaths listed in `PACKAGES` match the package's `exports` map;
- every `exports` target exists in the tarball, and no condition other than
  `source` points at raw TypeScript;
- the installed package contains `dist/`, and each subpath imports under Node and
  exports at least one name;
- the installed `package.json` has no `workspace:` or `catalog:` ranges in
  `dependencies`, `peerDependencies` or `optionalDependencies`.

## What will surprise you

- **It takes minutes.** Each target runs `pnpm pack` (with a build) for its
  closure plus a real `npm install`. Test and hook timeouts are 900 000 ms.
- **It needs network access** for the npm install of third-party dependencies.
- **Browser-only subpaths are not imported.** A target can list subpaths in
  `browserOnly`; the import probe skips them. `@statewalker/webrun-site-host`
  is listed this way.
- **A new package is not tested until it is added to `PACKAGES`.** Packages not
  listed are still packed when a listed package depends on them.

## Reference

| Command | What it does |
| --- | --- |
| `pnpm --filter @statewalker/consumer-install-tests test` | run all checks (`vitest run`) |
