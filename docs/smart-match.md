# Smart Match

Smart Match links an unstructured bank payment purpose to structured Bitrix deal fields. The
production objective is precision first: returning no suggestion is safer than attaching a payment
to the wrong deal.

## Runtime

Set `SMART_MATCH_V2=true` to enable all of the following together:

- the V2 purpose parser;
- Unicode-aware matching and source spans;
- structured project/apartment/floor/area evidence;
- name matching with safe full-name token reordering;
- conflict vetoes, including an explicit apartment mismatch.

The flag defaults to `false`, so numeric parsing keeps legacy behaviour until shadow results
have been reviewed. The shared three-project name/address mapping is active in both modes; see [Bitrix mapping](bitrix-mapping.md#project-mapping).

## Decision ladder

The matcher stops at the strongest successful level:

| Level | Confidence | Use |
| --- | ---: | --- |
| raw exact | 1.000 | Same source text and case |
| normalized | 0.950 | NFKC, case, whitespace, dash/slash and leading-zero variants |
| name token exact | 0.925 | Same complete name tokens in another order |
| anchored regex | 0.800-0.900 | Typed Armenian/Russian/English field anchors |
| fuzzy text | 0.500-0.750 | Bounded Damerau-Levenshtein/OCR tolerance |

Fuzzy matching is structurally disabled for numeric identifiers. Runtime deal evidence also asks
numeric fields to have their semantic anchor, so a bare `55` cannot become apartment 55 merely
because it appears as an amount or reference number.

A deal normally needs multiple independent signals, such as project + apartment or apartment +
payer name. One intentional exception is an explicitly anchored apartment number with no building
or project in the payment purpose: every deal with that exact structured apartment number is
suggested across all buildings. A common project alone is insufficient. If both sides explicitly
contain different apartment numbers or different known projects, the candidate is rejected.

`smartFindBest()` compares candidate identities and requires a confidence margin. Equally strong
different candidates return `null`; leading-zero aliases of the same numeric identifier do not
create false ambiguity.

## Design references

- [Unicode UAX #15](https://www.unicode.org/reports/tr15/) for normalization and canonical
  equivalence. Canonicalization is cluster-aware so decomposed sequences preserve correct spans.
- [Unicode UTS #39](https://www.unicode.org/reports/tr39/) for mixed-script/confusable handling.
  Confusable folding is restricted to the weakest fuzzy text level.
- [Elasticsearch fuzzy-query documentation](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-fuzzy-query)
  for bounded edit distance, adjacent transpositions and limiting expensive expansions.
- [PostgreSQL `pg_trgm`](https://www.postgresql.org/docs/current/pgtrgm.html) for the distinction
  between whole-string and strict word-boundary similarity.
- [Splink comparison guidance](https://moj-analytical-services.github.io/splink/topic_guides/comparisons/choosing_comparators.html)
  and its Fellegi-Sunter model for combining evidence rather than trusting one weak field.
- [Winkler's record-linkage comparator paper](https://www.asasrms.org/Proceedings/papers/1990_056.pdf)
  for name-oriented string comparison and conservative decision rules.

## Validation and rollout

Run:

```bash
npm.cmd test
npm.cmd run lint
npm.cmd run build
node apps/server/src/tools/shadowCompare.js
node apps/server/src/tools/shadowCompare.js --live --limit 200
```

The live shadow command is read-only. Review false positives and CRM structured-field coverage
before enabling the flag in production.
