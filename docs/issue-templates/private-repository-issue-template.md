---
name: Private repository issue
description: Standard issue template for private BluePrime project repositories
title: 'task: '
labels: triage
assignees: ''
---

<!--
Use this template for private BluePrime repositories that power internal projects,
product development, implementation planning, architecture work, release readiness,
customer-specific delivery, or internal operations.

Private repositories may include internal context, but still avoid unnecessary
secrets. Do not paste raw credentials, production tokens, private keys, or full
connection strings. Link to the approved secret manager or internal runbook instead.
-->

## Summary

<!--
Describe the work, decision, issue, risk, bug, feature, documentation task, or
internal project requirement in one or two clear paragraphs.
-->

## Issue type

<!-- Mark one. -->

- [ ] Product requirement
- [ ] Engineering task
- [ ] Bug / defect
- [ ] Architecture / design decision
- [ ] Documentation task
- [ ] Release readiness
- [ ] Security / compliance review
- [ ] Operational / deployment task
- [ ] Customer / stakeholder request
- [ ] Research / discovery
- [ ] Maintenance / governance
- [ ] Other

## Internal context

<!--
Explain the business, product, technical, customer, or operational background.
Include enough context for an internal reviewer to understand why this matters.
-->

## Goal and desired outcome

<!--
Describe what should be true after this issue is completed.
-->

## Current state

<!--
Describe the current implementation, documentation, process, repo state, customer
state, release state, or known limitation.
-->

## Scope

### In scope

- [ ] Add first in-scope item.
- [ ] Add second in-scope item.
- [ ] Add third in-scope item.

### Out of scope

- [ ] Add first out-of-scope item.
- [ ] Add second out-of-scope item.
- [ ] Add third out-of-scope item.

## Affected system or area

<!-- Mark all that apply. -->

- [ ] Public package / open-source repository
- [ ] Private project repository
- [ ] npm/package publishing
- [ ] Documentation system
- [ ] CI/CD
- [ ] Release workflow
- [ ] Security / secrets / access control
- [ ] Database / TimescaleDB / PostgreSQL
- [ ] TypeORM integration
- [ ] NestJS integration
- [ ] Internal product architecture
- [ ] Customer delivery
- [ ] Other

## Technical details

<!--
Add internal technical details needed by the assignee. Use links to private docs,
runbooks, tickets, designs, logs, or dashboards where appropriate.

Do not paste raw secrets. Use secret references instead.
-->

Relevant files, services, links, or references:

<!-- Add links, file paths, or references here. -->

## Dependencies and blockers

<!--
List upstream/downstream dependencies, approvals, design decisions, access needs,
customer dependencies, or unresolved questions.
-->

- [ ] Add first dependency or blocker.
- [ ] Add second dependency or blocker.
- [ ] Add third dependency or blocker.

## Risk and impact

### Risk if not done

<!--
What breaks, remains unclear, blocks adoption, creates security exposure, or delays
release?
-->

### Impact if done incorrectly

<!-- What could regress, confuse users, expose data, or create operational risk? -->

## Priority and urgency

<!-- Mark one. -->

- [ ] P0 - blocks release, security, production, or urgent customer need
- [ ] P1 - should be completed before public promotion or major internal milestone
- [ ] P2 - important but not blocking immediate release
- [ ] P3 - useful improvement / cleanup

Target date or milestone, if any:

## Proposed work

<!--
List concrete tasks. These should be specific enough for an assignee to start.
-->

- [ ] Add first task.
- [ ] Add second task.
- [ ] Add third task.

## Acceptance criteria

<!--
The issue is done only when these are true.
-->

- [ ] The requested work is implemented or documented.
- [ ] The result matches the stated goal and scope.
- [ ] Relevant tests, docs, examples, release notes, or runbooks are updated.
- [ ] Security/privacy implications have been reviewed.
- [ ] Any public-facing wording is accurate and approved for public visibility.
- [ ] Follow-up issues are created for work intentionally left out of scope.

## Validation plan

<!--
How should reviewers verify the work? Examples include running tests, inspecting docs,
checking package metadata, reviewing screenshots, executing a runbook, or validating with a stakeholder.
-->

- [ ] Add first validation step.
- [ ] Add second validation step.
- [ ] Add third validation step.

## Security, privacy, and access check

<!-- Required for private repositories. -->

- [ ] No raw secrets, tokens, private keys, or full connection strings are pasted into this issue.
- [ ] Sensitive details are necessary for the work and appropriate for this private repository.
- [ ] Public wording will be reviewed before release if this issue affects public docs or package claims.
- [ ] The correct private security process is being followed if this is a vulnerability or incident.

## Stakeholders and reviewers

<!--
List internal people, teams, or roles that should be aware of or review this work.
-->

- Owner:
- Reviewer(s):
- Product/stakeholder contact:
- Security/compliance reviewer, if needed:

## Additional context

<!-- Add screenshots, notes, diagrams, links, or background that help complete the work. -->
