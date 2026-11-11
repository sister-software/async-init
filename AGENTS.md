# Repository Guidelines

## Project Structure & Module Organization

`index.ts` is the public entry point. `lib/` contains the protocol, service handles, proxies, tokens, registry, and errors. Runtime tests live in `test/*.test.ts`; type assertions live in `test/*.test-d.ts`. The numbered files in `examples/` demonstrate each layer and run directly with Node. TypeScript emits build output to `out/`, which is ignored by Git.

## Build, Test, and Development Commands

Use the repository's Yarn 4 release and a Node version supported by `package.json` (`^24.22.1` or `>=26.12.1`). Run `yarn install` to install dependencies.

- `yarn compile` builds JavaScript and declarations into `out/`.
- `yarn check-types` runs the TypeScript build check.
- `yarn test` compiles and starts Vitest; use `yarn test --run` for a single noninteractive run.
- `yarn test:types` runs the Vitest type assertions.
- `yarn lint` checks Oxlint rules and Oxfmt formatting; `yarn format` applies the formatter.
- `node examples/01-protocol.ts` runs an example directly through Node's TypeScript type stripping.

## Coding Style & Naming Conventions

Use TypeScript ES modules. Follow `.editorconfig`: tabs for code, two-space indentation for YAML, LF line endings, and a final newline. Let Oxfmt control layout and Oxlint enforce rules; avoid manual formatting that conflicts with either tool. Keep public exports in `index.ts` and implementation in `lib/`. Preserve `erasableSyntaxOnly` and `isolatedDeclarations` compatibility: avoid TypeScript features that require runtime transpilation, and give exported declarations the types the compiler requires.

## Testing Guidelines

Add behavior tests beside related cases in `test/<feature>.test.ts`, using Vitest's `describe`, `it`, and `expect`. Put compile-time API checks in `test/*.test-d.ts` with `expectTypeOf` or `@ts-expect-error`. Run `yarn test --run`, `yarn test:types`, and `yarn lint` before proposing a change. No coverage threshold is configured.

## Commit & Pull Request Guidelines

Recent commits use short, imperative subjects with prefixes such as `fix:`, `docs:`, `test:`, and `chore:`; some add a scope, as in `fix(registry): ...`. Follow that pattern and describe the concrete change. In a pull request, explain the behavior changed, link a relevant issue when one exists, and report the checks actually run. Include a focused example or test result for API or lifecycle changes.
