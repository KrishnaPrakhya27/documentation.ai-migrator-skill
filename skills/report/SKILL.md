---
name: report
description: "Generate the implemented migration report set: gate JSON, Markdown review queue and summary, redirect and anchor JSON, platform-gaps.json for engineering follow-up, and the customer-facing HTML/PDF report of what was migrated and what was not."
---
# Report

Run `dai-migrate report` after verification. It summarizes the single machine-readable gate dataset and decision log. Report generation is automatic and is not a separate human gate; final cutover approval remains gate 4/4.

Outputs currently implemented: `report/gates.json`, `report/review-queue.md`, `report/summary.md`, exact/wildcard redirect JSON, anchor JSON, `report/platform-gaps.json` (aggregated T4/T6/T7 decisions and anchor-shim count), and the customer report as `report/customer-report.{html,pdf,json}`.

Engineer-notes enforcement, CSV annexes, performance comparisons and cutover-plan generation are future work. Do not claim those artefacts exist.

Never ship raw markdown or model output to a customer. The customer report below is the artefact to send; every other file in `report/` is written for the team.

## The customer report

`report/customer-report.pdf` is the only artefact written for the customer, and it answers two questions: what arrived, and what did not.

The second is the point. A migration that omits pages and reports only its successes is worse than one that names them, because the customer finds out from a reader. So the report itemises, each with the reason the run recorded at the time:

- every page the plan did not migrate, grouped by reason (unpublished, not placed by the table of contents, out of scope);
- every page held back at conversion (an unresolved snippet, or content exact mode refused to approximate);
- every page migrated but absent from the sidebar, because the source publishes it without placing it;
- every block of content removed from inside a page, attributed to the rule or person that decided it;
- every link still pointing at the old site, because its target is outside the agreed scope;
- every check that failed or did not run — a permissive run states that it proves nothing about fidelity rather than showing those checks as passed.

A help-centre hub the migration wrote (`nav --help-center`) is listed as a page the migration wrote, with its approver: it holds no words of ours. Items needing a customer decision are marked. A list longer than 25 entries states how many it is not showing and points at `customer-report.json`, which holds the full set; nothing is truncated silently.

Gate ids never appear. Each is rendered in the customer's terms (`code-blocks-exact` → "Code samples are character-for-character identical") by `report/gate-language.ts`; a gate with no entry there falls back to its raw id, so add one when adding a gate.

The PDF is printed from the HTML by the same headless Chrome verification already uses — no extra dependency, no network, scripts disabled. If Chrome is absent the stage still writes the HTML and JSON and says how to finish the job; it never fails the report over a missing browser. `--no-pdf` writes the HTML only.

## Provenance and per-route results
`report/summary.md` records which migrator build produced the output (commit, whether the checkout was dirty, and the hash of what differed), the fidelity mode and the navigation source. `verify --preview` writes `report/preview-routes.json`: one row per deployed route with its residual rendered text and any link, image, heading-outline or sidebar problem. `report/unlisted-pages.json` lists pages the source publishes without a sidebar placement.
