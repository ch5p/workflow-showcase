# Contributing

Thanks for contributing. This beta favors small changes and reproducible validation.

## Local setup

- Windows 10 or 11
- Node.js 22.12 or later
- FFmpeg for Export checks

Install and basic checks:

    npm.cmd ci
    npm.cmd run check
    npm.cmd run smoke

When changing Export:

    npm.cmd run smoke:export

All smoke runs must execute against a temporary Job. Do not change the tests to read or write the real `current-job`.

To use the repository's own pre-commit check instead of a machine-wide hook, run this once in the clone:

    git config --local core.hooksPath scripts/git-hooks

The hook runs the same `scripts/check.cjs` contract used by CI, including the English/no-BOM and Korean/BOM documentation rules.

## Pull request scope

Keep one purpose per PR. Include the following in the PR description:

- Summary
- Stable contracts touched
- Validation
- Risk
- Screenshot or output comparison

If you modify the parser, SHOT identity, reference mapping, Job path, IPC, or Export fallback, add fixtures and regression checks first.

## Fixtures and privacy

Do not commit real working XML, video, references, or user paths.

New fixtures must satisfy:

- synthetic data, or data with clear redistribution rights
- local absolute paths and personal UUIDs removed
- documented expected fps, duration, track, in/out, and enabled results
- a parser-result comparison between the original and the cleaned version
- no third-party music, voice, or images

## Layout contributions

Do not add a runtime preset system to the official app first. Start 16:9, 9:16, 1:1, and 4:5 experiments as a fork or a community-layout proposal, and attach screenshots and Export validation.
