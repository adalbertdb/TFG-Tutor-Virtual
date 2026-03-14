# Evaluation System

The evaluation system measures the quality of the RAG pipeline through automated metrics. It reads JSONL interaction logs produced by the backend and computes both retrieval quality metrics (how well the search engine finds relevant documents) and generation quality metrics (how well the tutor's responses follow Socratic pedagogy).

All evaluation scripts are written in Python and located in the `evaluation/` directory.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Configuration](#configuration)
3. [Data Flow](#data-flow)
4. [Retrieval Metrics](#retrieval-metrics)
5. [Generation Metrics](#generation-metrics)
6. [End-to-End Benchmark](#end-to-end-benchmark)
7. [Results Format](#results-format)
8. [How to Run](#how-to-run)
9. [Interpreting Results](#interpreting-results)

---

## Architecture

```
backend/logs/rag/*.jsonl   ─── (interaction logs) ───┐
                                                      ▼
material-complementario/llm/datasets/*.json ──► evaluateRetrieval.py ──► results/retrievalMetrics.json
                                              ► evaluateGeneration.py ──► results/generationMetricsBasic.json
                                              ► runBenchmark.py ──────── results/benchmarkResults.json
                                                      ▲
                                                      │
                              backend server ◄── (live queries) ── runBenchmark.py
```

The evaluation system has two modes:

1. **Offline evaluation** (`evaluateRetrieval.py`, `evaluateGeneration.py`): Reads existing interaction logs and computes metrics. No server required.

2. **Live benchmark** (`runBenchmark.py`): Sends test queries to the running server, collects responses, then runs both evaluation scripts on the collected data.

---

## Configuration

**File:** `evaluation/config.py`

Centralizes all evaluation parameters:

| Parameter | Value | Description |
|---|---|---|
| `LOG_DIR` | `backend/logs/rag` | Where to read JSONL interaction logs |
| `DATASETS_DIR` | `material-complementario/llm/datasets` | Path to ground truth datasets |
| `RESULTS_DIR` | `evaluation/results` | Where to write evaluation output |
| `DATASET_MAP` | `{1: "dataset_exercise_1.json", ...}` | Maps exercise numbers to dataset files (7 exercises, 6 unique files) |
| `DEFAULT_K` | `3` | K value for Precision@K, Recall@K, MAP@K |
| `BASE_URL` | `http://localhost:3000` | Backend server URL for live benchmark |
| `STREAM_ENDPOINT` | `/api/ollama/chat/stream` | Chat endpoint path |
| `TEST_SAMPLES_PER_EXERCISE` | `5` | Number of test queries per exercise in benchmark |
| `QUESTION_WORDS` | `["por qué", "cómo", "qué", ...]` | Spanish question words for Socratic detection |
| `REVEAL_PHRASES` | `["la respuesta es", "las resistencias son", ...]` | Phrases indicating solution leaks |

---

## Data Flow

### Input: JSONL Interaction Logs

Every RAG interaction is logged by the backend as a JSON line in `backend/logs/rag/YYYY-MM-DD.jsonl`. Each entry contains:

```json
{
  "timestamp": "2024-03-14T10:30:00.000Z",
  "exerciseNum": 3,
  "userId": "64a1b2c3d4e5f6a7b8c9d0e1",
  "classification": "wrong_answer",
  "decision": "rag_examples",
  "query": "R5 porque está conectada",
  "retrievedDocs": [
    { "student": "R5", "tutor": "¿Por qué piensas que R5...?", "score": 0.4231 },
    ...
  ],
  "augmentation": "[RESPONSE MODE]\n...",
  "response": "¿Qué observas en el circuito alrededor de R5?",
  "guardrailTriggered": false,
  "correctAnswer": ["R1", "R2", "R4"],
  "timing": { "pipeline": 342, "total": 1523 }
}
```

### Ground Truth: Exercise Datasets

The ground truth for retrieval evaluation comes from the exercise datasets — the same JSON files used for ingestion. Each dataset is an array of student-tutor pairs:

```json
[
  { "student": "R5", "tutor": "¿Por qué piensas que R5 contribuye al divisor de tensión?" },
  { "student": "R1, R2 y R4", "tutor": "¡Correcto! ¿Puedes explicar por qué?" },
  ...
]
```

A retrieved document is considered "relevant" if the query matches the student text from the dataset (exact match or substring containment).

---

## Retrieval Metrics

**File:** `evaluation/evaluateRetrieval.py`

This script evaluates how well the hybrid search engine retrieves relevant documents for each query.

### Metrics Computed

#### Precision@K

The fraction of the top K retrieved documents that are relevant.

```
Precision@K = (relevant documents in top K) / K
```

With `K = 3`, if 2 out of the 3 retrieved documents are relevant, Precision@3 = 0.667.

#### Recall@K

The fraction of all relevant documents that appear in the top K results.

```
Recall@K = (relevant documents in top K) / (total relevant documents)
```

If there are 5 relevant documents in the dataset and 2 appear in the top 3, Recall@3 = 0.4.

#### MAP@K (Mean Average Precision)

Average Precision considers the order of relevant documents — finding a relevant document at rank 1 is better than at rank 3.

```
AP = (1/|relevant|) × Σ (precision at rank_i, for each relevant doc at rank_i)
```

MAP@K is the mean of AP values across all queries.

#### MRR (Mean Reciprocal Rank)

How high the first relevant document appears in the results.

```
RR = 1 / (rank of first relevant document)
```

If the first relevant document is at rank 1, RR = 1.0. If at rank 3, RR = 0.333. MRR is the mean across all queries.

### How Relevance Is Determined

For each logged query, the script finds "relevant" documents in the ground truth dataset using text matching:

1. **Exact match**: The query text exactly equals a student message in the dataset
2. **Substring containment**: The query is a substring of a dataset entry, or vice versa

Then it compares the retrieved document indices (from the log's `retrievedDocs` field) against these relevant indices to compute the metrics.

---

## Generation Metrics

**File:** `evaluation/evaluateGeneration.py`

This script evaluates the quality of the LLM's responses from a pedagogical perspective.

### Two Evaluation Modes

#### RAGAS Mode (when `ragas` library is installed)

Uses the RAGAS framework to compute:

| Metric | Description |
|---|---|
| **Faithfulness** | How much the response is grounded in the provided context (retrieved documents + augmentation). Higher is better — the tutor should not hallucinate facts. |
| **Answer Relevancy** | How relevant the response is to the student's question. Higher is better. |
| **Context Precision** | How much of the provided context is actually useful. Higher means less noise in the retrieval. |
| **Context Recall** | How much of the ground truth information is covered by the provided context. Higher means better retrieval coverage. |

RAGAS requires an LLM to evaluate the responses, so it is slower but more comprehensive.

#### Basic Mode (fallback when RAGAS is not installed)

Computes simpler heuristic metrics:

| Metric | Description |
|---|---|
| **Socratic Rate** | Percentage of responses containing at least one question mark (`?`). A good Socratic tutor should ask questions, not give statements. |
| **Average Question Words** | Average number of question-starting words ("por qué", "cómo", "qué", etc.) per response. Higher suggests more active questioning. |
| **Guardrail Safe Rate** | Percentage of responses that do not contain any reveal phrases ("la respuesta es", "las resistencias son", etc.). Should be very close to 1.0 — the tutor should almost never reveal the answer. |
| **Average Response Length** | Mean character length of responses. Too short might mean the tutor is not engaging enough. Too long might mean it is being verbose instead of asking focused questions. |

### Ground Truth for Generation

The best matching ground truth response is found by word overlap — the dataset student-tutor pair whose student message shares the most words with the query is selected. The ground truth tutor response serves as the reference for what an ideal response looks like.

---

## End-to-End Benchmark

**File:** `evaluation/runBenchmark.py`

The benchmark script automates the entire evaluation process:

1. **Check prerequisites**: Verify the server is running and test user/exercise IDs are configured
2. **Select test samples**: For each exercise, pick `TEST_SAMPLES_PER_EXERCISE` (5) evenly spaced entries from the dataset
3. **Send queries**: POST each student message to the chat endpoint, parse the SSE response
4. **Collect results**: Save query, expected response, actual response, and timing for each test
5. **Run evaluations**: Automatically call `evaluateRetrieval.py` and `evaluateGeneration.py` on the resulting logs

### Required Environment Variables

```bash
export TEST_USER_ID="64a1b2c3d4e5f6a7b8c9d0e1"  # MongoDB ObjectId of a test user
export TEST_EXERCISE_IDS='{"1":"objectid1","3":"objectid3",...}'  # Exercise IDs per number
```

### Output

The benchmark produces three files:
- `results/benchmarkResults.json` — Raw query-response pairs with timing
- `results/retrievalMetrics.json` — Retrieval quality metrics (from evaluateRetrieval)
- `results/generationMetricsBasic.json` — Generation quality metrics (from evaluateGeneration)

---

## Results Format

### retrievalMetrics.json

```json
{
  "numQueries": 42,
  "k": 3,
  "meanPrecisionAtK": 0.7143,
  "meanRecallAtK": 0.5238,
  "mapAtK": 0.6429,
  "mrr": 0.8571,
  "perQuery": [
    {
      "query": "R5 porque está conectada",
      "exerciseNum": 3,
      "classification": "wrong_answer",
      "precisionAtK": 0.6667,
      "recallAtK": 0.5,
      "averagePrecision": 0.75,
      "reciprocalRank": 1.0,
      "numRetrieved": 3,
      "numRelevant": 4
    },
    ...
  ]
}
```

### generationMetricsBasic.json

```json
{
  "numQueries": 42,
  "avgResponseLength": 187.3,
  "socraticRate": 0.9048,
  "avgQuestionWords": 1.57,
  "guardrailSafeRate": 0.9762
}
```

### benchmarkResults.json

```json
[
  {
    "exerciseNum": 3,
    "query": "R5 porque está conectada",
    "expected": "¿Por qué piensas que R5 contribuye?",
    "response": "¿Qué observas en el circuito alrededor de R5?",
    "timeSeconds": 2.34
  },
  ...
]
```

---

## How to Run

### Prerequisites

```bash
cd evaluation
pip install -r requirements.txt
```

The `requirements.txt` includes dependencies for both basic and RAGAS evaluation modes.

### Offline Evaluation (no server needed)

Run these after the system has been used and JSONL logs exist:

```bash
# Retrieval metrics (reads logs, compares against datasets)
python evaluateRetrieval.py

# Generation metrics (reads logs, analyzes responses)
python evaluateGeneration.py

# Custom K value for retrieval
python evaluateRetrieval.py 5
```

### Live Benchmark (server must be running)

```bash
# Set required environment variables
export TEST_USER_ID="your_test_user_objectid"
export TEST_EXERCISE_IDS='{"1":"exercise1_id","3":"exercise3_id",...}'

# Run full benchmark
python runBenchmark.py
```

This sends test queries to the server, then runs both evaluation scripts automatically.

---

## Interpreting Results

### Retrieval Metrics — What Good Looks Like

| Metric | Good | Acceptable | Poor |
|---|---|---|---|
| Mean Precision@3 | > 0.7 | 0.4 - 0.7 | < 0.4 |
| Mean Recall@3 | > 0.5 | 0.3 - 0.5 | < 0.3 |
| MAP@3 | > 0.6 | 0.3 - 0.6 | < 0.3 |
| MRR | > 0.8 | 0.5 - 0.8 | < 0.5 |

**High Precision, Low Recall**: The retrieved documents are relevant, but the system misses many relevant documents. This is acceptable for this use case — we only need 3 good examples, not all possible examples.

**Low Precision, High Recall**: The system retrieves too many irrelevant documents. This could pollute the LLM context with unhelpful examples.

### Generation Metrics — What Good Looks Like

| Metric | Target | Concern |
|---|---|---|
| Socratic Rate | > 0.85 | Below 0.7 means the tutor is making statements instead of asking questions |
| Avg Question Words | > 1.0 | Below 0.5 suggests responses lack genuine questioning |
| Guardrail Safe Rate | > 0.95 | Below 0.9 means the tutor frequently leaks answers |
| Avg Response Length | 100-300 chars | Below 50 is too terse; above 500 is too verbose for a Socratic question |

### When Metrics Are Low

Common causes and fixes:

1. **Low retrieval scores**: The datasets may not contain examples similar enough to real student queries. Solution: add more diverse student-tutor pairs to the dataset files.

2. **Low Socratic rate**: The LLM prompt may not be strict enough about asking questions. Solution: strengthen the `[RESPONSE MODE]` hint in the pipeline or lower `OLLAMA_TEMPERATURE` to make responses more focused.

3. **Low guardrail safe rate**: The guardrail patterns may be too narrow, missing some reveal phrases. Solution: add more patterns to `guardrails.js` or reduce `OLLAMA_NUM_PREDICT` to limit response length.

4. **CRAG triggering too often**: If many queries have low retrieval scores, the `MED_THRESHOLD` may be too high. Solution: lower the threshold (e.g., from 0.4 to 0.3) to be less aggressive about reformulation.
