# Supplier invoice document reading

The local PDF/text and scan reader prepares proposed bill lines for explicit
review. It never chooses a product namespace, maps a QuickBooks Item.Id, changes
approved supplier prices, receives inventory or posts a bill by reading a file.
The owner selects supplier/manufacturer/internal code interpretation separately.

Common item-code, product-description and each-price headers are accepted, including
explicit USD header labels. Unknown currency labels remain unsupported. A short
header label does not truncate a longer SKU or product description: the next
column's left edge bounds the preceding cell, while overlapping fields still
require manual correction.

A nearby description-only line can continue a previously complete item, at most
four continuation lines. Every word must remain in an explicit description
column. Missing financial/code cells, numbers alone, currency annotations,
uncertain OCR, distant text and text after totals fail closed. The review shows
the original page and source row range. Printed line extensions must reconcile
to integer cents; leading-zero codes remain text.

The reader does not infer invoice-wide tax, freight, discounts, balances or
unknown footer charges. Unrecognized rows are refused rather than silently
discarded. The original bill total must still be entered and checked against
reviewed rows and the original document. CSV or manual entry remains available
when the document layout cannot be safely interpreted.

Regression evidence includes an internally authored one-page Microsoft Word PDF
with15 public manufacturer IDs, fictional quantities/prices, a wrapped product
description and USD430.10 in printed item extensions. Actual PDF.js text geometry
and the application parser are exercised. That evidence establishes text-PDF
extraction, not OCR accuracy, normal browser upload acceptance, provider mapping
or a live accounting transaction.
