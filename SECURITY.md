# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's
[Private Vulnerability Reporting](https://github.com/BluePrime-Technologies/typeorm-timescaledb/security/advisories/new)
on this repository. Do **not** open a public issue for security problems.

We aim to acknowledge reports within 3 business days.

## Supported versions

This project is pre-1.0; only the latest released version is supported.
Once 1.0 ships, this table will list supported version ranges.

## Identifier-injection note

This library accepts table/column identifiers in some APIs (e.g. cross-store
references). All such identifiers are validated against an allow-list and
quoted; values are always passed as bound parameters. If you find a path where
a dynamic identifier reaches SQL without allow-list validation, treat it as a
security issue and report it privately.
