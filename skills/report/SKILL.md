---
name: report
description: "Generate the implemented migration report set: gate JSON, Markdown review queue and summary, redirect and anchor JSON, and platform-gaps.json for engineering follow-up."
---
# Report

Run `dai-migrate report` after verification. It summarizes the single machine-readable gate dataset and decision log. Report generation is automatic and is not a separate human gate; final cutover approval remains gate 4/4.

Outputs currently implemented: `report/gates.json`, `report/review-queue.md`, `report/summary.md`, exact/wildcard redirect JSON, anchor JSON, and `report/platform-gaps.json` (aggregated T4/T6/T7 decisions and anchor-shim count).

Customer HTML/PDF, engineer-notes enforcement, CSV annexes, performance comparisons and cutover-plan generation are future work. Do not claim those artefacts exist.

Never ship raw markdown or model output to a customer.

## Provenance and per-route results
`report/summary.md` records which migrator build produced the output (commit, whether the checkout was dirty, and the hash of what differed), the fidelity mode and the navigation source. `verify --preview` writes `report/preview-routes.json`: one row per deployed route with its residual rendered text and any link, image, heading-outline or sidebar problem. `report/unlisted-pages.json` lists pages the source publishes without a sidebar placement.
