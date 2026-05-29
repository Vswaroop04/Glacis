# Glacis

AI webhook ingestion service — normalizes logistics events (shipment tracking, invoices, marine advisories) from heterogeneous providers into a canonical schema using LLMs.

## LLM Normalization Benchmark

Last run: **2026-05-29**

### Benchmark A — Accuracy on 6 sample payloads (all models)

| Model | type% | state% | parse% | p50 | p95 | avg | stddev | in_tok | out_tok |
|---|---|---|---|---|---|---|---|---|---|
| Haiku 4.5 | 100% | 100% | 100% | 2254ms | 3494ms | 2303ms | 581ms | 14218 | 1368 |
| Sonnet 4.6 | 100% | 100% | 100% | 7460ms | 7574ms | 6798ms | 798ms | 3196 | 2519 |
| GPT-4o mini | 100% | 100% | 100% | 2855ms | 3801ms | 2744ms | 821ms | 8949 | 479 |
| GPT-4o | 100% | 100% | 100% | 1520ms | 1608ms | 1303ms | 260ms | 8949 | 478 |
| GPT-4.1 nano | 100% | 83% | 100% | 1161ms | 1520ms | 1191ms | 195ms | 8949 | 534 |
| GPT-4.1 | 100% | 100% | 100% | 1891ms | 2501ms | 1822ms | 358ms | 8949 | 585 |

GPT-4.1 nano missed `one-delivered` → returned `OUT_FOR_DELIVERY` instead of `DELIVERED`.

---

### Benchmark B — Reliability (5 runs on hard payloads)

**Hard payloads tested:**
- `gfp-invoice-paid`: European decimal format (`EUR 24.350,75` → 2435075 cents)
- `one-delivered`: Ambiguous milestone text requiring semantic mapping

#### gfp-invoice-paid

| Model | parse% | type% | state% | p50 | p95 | max | stddev |
|---|---|---|---|---|---|---|---|
| Haiku 4.5 | 100% | 100% | 100% | 2005ms | 2141ms | 2141ms | 74ms |
| Sonnet 4.6 | 100% | 100% | 100% | 7526ms | 7906ms | 7906ms | 341ms |
| GPT-4o mini | 100% | 100% | 100% | 2497ms | 4203ms | 4203ms | 826ms |
| GPT-4o | 100% | 100% | 100% | 1451ms | 2335ms | 2335ms | 426ms |
| GPT-4.1 nano | 100% | 100% | 100% | 1294ms | 1387ms | 1387ms | 104ms |
| GPT-4.1 | 100% | 100% | 100% | 2516ms | 6103ms | 6103ms | 1685ms |

#### one-delivered

| Model | parse% | type% | state% | p50 | p95 | max | stddev |
|---|---|---|---|---|---|---|---|
| Haiku 4.5 | 80% | 80% | 80% | 2047ms | 5178ms | 5178ms | 1276ms |
| Sonnet 4.6 | 100% | 100% | 100% | 7802ms | 11003ms | 11003ms | 1394ms |
| GPT-4o mini | 100% | 100% | 100% | 2306ms | 2980ms | 2980ms | 532ms |
| GPT-4o | 100% | 100% | 100% | 1166ms | 1339ms | 1339ms | 115ms |
| GPT-4.1 nano | 100% | 100% | 20% | 1377ms | 1589ms | 1589ms | 168ms |
| GPT-4.1 | 100% | 100% | 100% | 1981ms | 2363ms | 2363ms | 195ms |

---

### Benchmark C — Adversarial payloads (all models)

Tests: missing BL, European decimals, non-standard dates, deeply nested schema

| Model | type% | state% | p50 | p95 | avg |
|---|---|---|---|---|---|
| Haiku 4.5 | 88% | 88% | 2084ms | 6806ms | 2618ms |
| Sonnet 4.6 | 100% | 100% | 6780ms | 7795ms | 6500ms |
| GPT-4o mini | 100% | 100% | 2124ms | 2919ms | 2183ms |
| GPT-4o | 88% | 88% | 1073ms | 2097ms | 1191ms |
| GPT-4.1 nano | 75% | 75% | 1178ms | 2620ms | 1446ms |
| GPT-4.1 | 75% | 75% | 1370ms | 2074ms | 1442ms |

---

### Benchmark D — Concurrency throughput (6 parallel calls)

| Model | wall_ms | success/total | norm/sec | avg_ms/req |
|---|---|---|---|---|
| Haiku 4.5 | 2878ms | 6/6 | 2.08 | 480ms |
| Sonnet 4.6 | 9359ms | 6/6 | 0.64 | 1560ms |
| GPT-4o mini | 9107ms | 6/6 | 0.66 | 1518ms |
| GPT-4o | 1812ms | 6/6 | 3.31 | 302ms |
| GPT-4.1 nano | 1409ms | 6/6 | 4.26 | 235ms |
| GPT-4.1 | 2288ms | 6/6 | 2.62 | 381ms |

---

### Benchmark E — Cost analysis

Per-call and per-1k cost weighted by accuracy (Benchmark A payloads).

| Model | type% | avg_ms | per_call | per_1k | per_1M | $/accuracy |
|---|---|---|---|---|---|---|
| Haiku 4.5 | 100% | 2303ms | $0.00281 | $2.8077 | $2807.73 | $2.8077/1k |
| Sonnet 4.6 | 100% | 6798ms | $0.00790 | $7.8955 | $7895.50 | $7.8955/1k |
| GPT-4o mini | 100% | 2744ms | $0.00027 | $0.2716 | $271.63 | $0.2716/1k |
| GPT-4o | 100% | 1303ms | $0.00453 | $4.5254 | $4525.42 | $4.5254/1k |
| GPT-4.1 nano | 100% | 1191ms | $0.00018 | $0.1847 | $184.75 | $0.1847/1k |
| GPT-4.1 | 100% | 1822ms | $0.00376 | $3.7630 | $3763.00 | $3.7630/1k |

Pricing per MTok: Haiku $0.80/$4, Sonnet $3/$15, GPT-4o-mini $0.15/$0.60, GPT-4o $2.50/$10, GPT-4.1-nano $0.10/$0.40, GPT-4.1 $2/$8

`$/accuracy` = cost per 1k normalizations adjusted for accuracy (lower is better).

---

### Key takeaways

- **Best accuracy + lowest cost**: GPT-4o mini — 100% on clean payloads, $0.27/1k
- **Cheapest overall**: GPT-4.1 nano at $0.18/1k, but 75% on adversarial payloads and unreliable on `one-delivered`
- **Fastest throughput**: GPT-4.1 nano (4.26 norm/sec), GPT-4o (3.31 norm/sec)
- **Most reliable on hard/adversarial payloads**: Sonnet 4.6 and GPT-4o mini both hit 100% on adversarial; GPT-4o drops to 88%
- **Haiku 4.5**: reliable on clean data but fails ~20% on the ambiguous `one-delivered` case
- **Sonnet 4.6**: highest accuracy ceiling but slowest (~7s avg) and most expensive at $7.90/1k
