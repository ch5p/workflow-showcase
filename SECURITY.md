# Security Policy

## Supported version

Security fixes currently target the latest 0.1.x source beta. No executable distribution is provided yet.

## Reporting a vulnerability

Do not post vulnerability details, user paths, or video/Job files in a public Issue.

If you see a `Report a vulnerability` button on the repository's Security tab, please file a private vulnerability report.

https://github.com/ch5p/workflow-showcase/security/advisories/new

If the button is unavailable, open only an Issue titled `Security contact request` with no details. Do not put reproduction information or sensitive files in public comments.

Include only reproduction steps, impact, the version used, and the smallest possible fixture. Real project data and credentials must be removed.

## Scope notes

This app copies local files into `current-job` and runs FFmpeg. Path boundary escapes, arbitrary file read/delete, IPC validation bypass, and orphaned Export processes are treated as security issues.

Do not place symlinks or junctions in `current-job` or its `source`, `references`, `output`, and `logs`. When using a stored relative path, the app checks both the lexical boundary and the real resolved path, and aborts if a link is found.
