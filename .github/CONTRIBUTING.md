# Contributing to Leaven

Thank you for your interest in contributing to Leaven! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct. Please be respectful and constructive in all interactions.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (latest version)
- [pnpm](https://pnpm.io/) (v9+)
- [Git](https://git-scm.com/)

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/leaven.git
   cd leaven
   ```
3. Install dependencies:
   ```bash
   pnpm install
   ```
4. Run tests to verify setup:
   ```bash
   pnpm test
   ```

## Development Workflow

### Branching Model

The repository follows [git-flow](https://nvie.com/posts/a-successful-git-branching-model/).
`develop` is the default branch and where all work lands; `main` carries only
released versions. The configured prefixes are:

| Prefix | Cut from | Merges to | Use for |
|--------|----------|-----------|---------|
| `feature/` | `develop` | `develop` | New features |
| `bugfix/` | `develop` | `develop` | Bug fixes, docs, refactors, test additions |
| `release/` | `develop` | `main` (and back to `develop`) | Promoting a version to release |
| `hotfix/` | `main` | `main` (and back to `develop`) | Urgent fixes to a released version |
| `support/` | `main` | — | Long-lived maintenance of an older line |

Keep the descriptive part of the name specific:

- `feature/add-caching-plugin`
- `bugfix/validation-error-message`
- `bugfix/update-readme`

Note that the branch prefix and the commit type are independent: a docs-only
change goes on a `bugfix/` branch and still uses a `docs(scope):` commit
message.

### Making Changes

1. Create a new branch from `develop`:
   ```bash
   git checkout develop
   git pull
   git checkout -b feature/your-feature
   ```

   Or, with the `git flow` CLI:
   ```bash
   git flow feature start your-feature
   ```

2. Make your changes following our [code style guidelines](#code-style)

3. Write or update tests as needed

4. Run the test suite:
   ```bash
   pnpm test
   ```

5. Run the linter:
   ```bash
   pnpm lint
   ```

6. Run the type checker:
   ```bash
   pnpm typecheck
   ```

7. Add a changeset (for user-facing changes):
   ```bash
   pnpm changeset
   ```

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

[optional body]

[optional footer]
```

**Types:**
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation only
- `style` - Code style (formatting, semicolons, etc.)
- `refactor` - Code refactoring
- `perf` - Performance improvement
- `test` - Adding or updating tests
- `build` - Build system or dependencies
- `ci` - CI/CD configuration
- `chore` - Other changes

**Examples:**
```
feat(core): add validation caching to executor
fix(http): handle empty request body
docs(readme): update installation instructions
```

## Code Style

### TypeScript Guidelines

1. **Explicit visibility modifiers** on all class members:
   ```typescript
   // ✅ Good
   public readonly name: string;
   private cache: Map<string, unknown>;

   // ❌ Bad
   readonly name: string;
   ```

2. **Explicit return types** on public methods:
   ```typescript
   // ✅ Good
   public execute(): ExecutionResult { }

   // ❌ Bad
   public execute() { }
   ```

3. **Use `type` imports** for type-only imports:
   ```typescript
   import type { GraphQLSchema } from 'graphql';
   ```

4. **Prefix unused variables** with underscore:
   ```typescript
   function handler(_event: Event, data: Data) { }
   ```

### File Headers

All source files should include the standard header:
```typescript
/**
 * @leaven-graphql/package-name - Brief description
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */
```

### Testing

- Tests go alongside source files with `.test.ts` suffix
- Use Bun's built-in test runner
- Aim for 90%+ code coverage
- Write descriptive test names

```typescript
import { describe, test, expect } from 'bun:test';

describe('ClassName', () => {
  describe('methodName', () => {
    test('should do expected behavior', () => {
      // ...
    });
  });
});
```

## Pull Request Process

1. **Before submitting:**
   - Ensure all tests pass
   - Ensure linter passes
   - Ensure type checker passes
   - Add changeset for user-facing changes
   - Update documentation if needed

2. **Target branch:** Open the PR against `develop`. Only `release/*` and
   `hotfix/*` branches target `main`.

3. **PR Title:** Follow conventional commit format

4. **PR Description:** Use the PR template and fill out all sections

5. **Review Process:**
   - PRs require at least one approval
   - Address all review comments
   - Keep PR scope focused

6. **After Merge:**
   - Delete your branch
   - The changeset will be included in the next release

## Release Process

Releases are split across the two long-lived branches, so each half of a
changesets release runs on the branch it belongs to. See the header comment in
[`.github/workflows/release.yml`](./workflows/release.yml) for the canonical
description.

1. **Changesets accumulate on `develop`** as feature and bugfix PRs merge. Every
   user-facing change should carry one (`pnpm changeset`).

2. **The Release workflow opens a version PR against `develop`.** On each push
   to `develop` it runs `changeset version`, which applies the pending
   changesets to package versions and CHANGELOGs, and opens (or updates) a
   `chore: version packages` PR. This job never publishes.

3. **Merge the version PR into `develop`.** `develop` now carries the versions
   that are about to be released.

4. **Cut a release branch and promote it to `main`:**
   ```bash
   git flow release start 0.2.0
   # or: git checkout -b release/0.2.0 develop
   ```
   Merge `release/*` into `main` (and back into `develop`, which `git flow
   release finish` does for you).

5. **The push to `main` publishes.** The Release workflow's publish job runs
   `changeset publish` for the versions `main` carries and tags the release.
   This job never opens a version PR.

Urgent fixes to a released version go on a `hotfix/` branch cut from `main`,
merged to both `main` and `develop`.

### npm authentication

The publish job uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC), not a stored `NPM_TOKEN`. Each package on npmjs.com trusts the
`quinnjr/leaven` repository's `release.yml` workflow, and CI exchanges its
GitHub OIDC token for a short-lived publish token. Provenance is attached
automatically.

The trust relationship is set per package. After adding a new package, publish
it once by hand (`pnpm publish --access public --otp <code>` from its
directory), then register the workflow for it, logged in to npm with 2FA:

```bash
pnpm trust:npm --dry-run   # preview
pnpm trust:npm             # register every public package
```

## Package Development

When creating or modifying packages:

1. Follow the existing package structure
2. Export types and functions from `index.ts`
3. Include a comprehensive `README.md`
4. Add package to the main `package.json` workspace
5. Update documentation site if applicable

## Questions?

- Open a [Discussion](https://github.com/quinnjr/leaven/discussions)
- Check existing [Issues](https://github.com/quinnjr/leaven/issues)

Thank you for contributing! 🎉
