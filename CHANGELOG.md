# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-11-05

First public release.

### Added

- Deleting a registered workspace's real folder, and a Session's event log together with its
  subagent Sessions, behind plan → review → confirm.
- A recoverable trash by default, with restore and an explicit purge; every entry carries an
  ownership marker, so a `trashRoot` that points at an unrelated directory is never listed, restored,
  or deleted.
- A deferral queue for Sessions open in the current Host, applied at the next start through the same
  plan → admission → execute pipeline.
- Storage overview, rule-based Session picking, an audit log, and the read-only `cleanup_inventory`
  tool. Deletion stays a user action: the agent has no delete entry point.
- A cross-process Session write-handle probe on the immediate and the deferred path, so a log owned
  by another Host process is refused (`SESSION_LIVE`) instead of being corrupted.
- Windows support: `dsh.bundle.platforms` names `win32`, path depth is counted below the drive or UNC
  root, comparison is case-insensitive there, and the system directories come from the environment.
- Chinese as the default long-form document (`docs/DETAIL.md`), with the English edition in
  `docs/DETAIL.en.md`.

### Changed

- `execute`, trash restore, and trash purge are serialized by one mutation lock; a cancelled request
  answers `CANCELLED`.
- One plan deletes at most 1,000 Session logs, and requeue at the queue limit answers
  `DEFERRED_FULL` instead of silently dropping the oldest entry.
- The published package contains only runtime files and user documentation: no tests or build/contract
  scripts.

### Fixed

- A blocked permanent workspace deletion keeps its typed folder name, so the queued run can validate
  it instead of refusing forever.
- A Session directory that disappears after admission is reported as deleted with 0 bytes rather than
  with the bytes planned earlier.
- A zero-valued budget setting clamps to at least 1 instead of making new plans expire instantly.
- A throw from the liveness probe fails closed (`SESSION_LIVE`) instead of treating the Session as
  deletable.
- A trash entry whose payload is a symlink or a regular file is refused by restore, matching what the
  trash list reports.
