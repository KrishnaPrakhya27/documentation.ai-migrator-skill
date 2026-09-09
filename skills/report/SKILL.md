---
name: report
description: "Generate the implemented migration report set: gate JSON, Markdown review queue and summary, redirect and anchor JSON, and platform-gaps.json for engineering follow-up."
---
# Report

Run `dai-migrate report` after verification. It summarizes the single machine-readable gate dataset and decision log.

Outputs currently implemented: `report/gates.json`, `report/review-queue.md`, `report/summary.md`, exact/wildcard redirect JSON, anchor JSON, and `report/platform-gaps.json` (aggregated T4/T6/T7 decisions and anchor-shim count).

Customer HTML/PDF, engineer-notes enforcement, CSV annexes, performance comparisons and cutover-plan generation are future work. Do not claim those artefacts exist.

Never ship raw markdown or model output to a customer.
