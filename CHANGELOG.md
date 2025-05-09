# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.0] - 2025-04-26

### Changed

- Bring codebase up to date with latest Node.js source (~v22.15.0)
- Fix chunked encoding support
- Add FixedLengthStream for responses with a content-length header

## [2.0.0] - 2025-04-23

### Changed

- Initial release forked from [@fastly/http-compute-js](https://github.com/fastly/http-compute-js)
- Removed third-party dependencies and moved imports to `node:*` style
- Changed all `process.nextTick` usages to `setTimeout`
- Implemented the latest Node.js http interfaces

[unreleased]: https://github.com/mhart/fetch-to-node/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/mhart/fetch-to-node/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/mhart/fetch-to-node/releases/tag/v2.0.0
