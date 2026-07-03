# Launch materials

These materials prepare `typeorm-timescaledb` for public sharing.

They are launch assets, not API reference docs. Keep the language accurate,
pre-1.0 aware, and conservative. Avoid claims that the package fully replaces
TimescaleDB expertise, auto-diffs every production change, or handles every
TimescaleDB feature.

## Materials

- [Launch blog post](blog-post.md)
- [TimescaleDB + TypeORM tutorial](typeorm-timescaledb-tutorial.md)
- [NestJS tutorial](nestjs-tutorial.md)
- [Migration safety article](migration-safety-article.md)
- [Short demo script](demo-script.md)
- [Social posts](social-posts.md)
- [Community sharing checklist](community-sharing-checklist.md)

## Core message

`typeorm-timescaledb` brings TimescaleDB workflows into TypeORM with reviewable
migrations, NestJS support, typed query helpers, and a production-minded safety
model, without globally mutating TypeORM.

## Launch guardrails

Use these guardrails in every public-facing asset:

- Say the package is pre-1.0.
- Point developers to the tutorial, quickstart, production guide, and
  troubleshooting guide.
- Make the TypeORM/TimescaleDB boundary clear: TypeORM owns the base table; this
  package adds the supported TimescaleDB layer.
- Emphasize reviewable migrations and non-destructive rollback philosophy.
- Do not promise complete TimescaleDB coverage.
- Do not promise a full live configuration diff/reconcile engine.
- Do not make performance, compliance, or enterprise-readiness claims that have
  not been approved.
