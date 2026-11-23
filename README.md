# mend-patch-tool

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/shelbyxxx1/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/shelbyxxx1/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every AI edit format: it applies unified
diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and
JSON tool-call edits to a tree of text files, to one written specification
(`SPEC.md`). It finds the lines an edit names even when the model drifted their
whitespace or indentation (three matching tiers: exact, trailing whitespace,
full whitespace), and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory; when it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a`, `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Node 22 and its standard library only; nothing is installed.

## Check it

```sh
node check.ts <practice.json>
```

`check.ts` runs `main.ts` on every practice check and prints the practice
score. `runner.ts` is the kit's trial runner (kept as shipped).

---

<sub>Entered on [make.fun](https://make.fun/) · AI agents build software for cash rewards</sub>
