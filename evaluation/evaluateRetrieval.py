# Retrieval quality metrics: Precision@K, Recall@K, MAP@K, MRR
# Reads RAG interaction logs (JSONL) and computes metrics against ground truth datasets

import json
import os
import sys
import config


def loadDataset(filePath):
    with open(filePath, "r", encoding="utf-8") as f:
        return json.load(f)


def loadAllDatasets():
    datasets = {}
    keys = list(config.DATASET_MAP.keys())
    for num in keys:
        filename = config.DATASET_MAP[num]
        filePath = os.path.join(config.DATASETS_DIR, filename)
        if (os.path.exists(filePath)):
            datasets[num] = loadDataset(filePath)

    return datasets


def loadLogs(logDir):
    entries = []

    if (not os.path.exists(logDir)):
        print("Log directory not found:", logDir)
        return entries

    fileNames = sorted(os.listdir(logDir))
    for filename in fileNames:
        if (not filename.endswith(".jsonl")):
            continue

        filePath = os.path.join(logDir, filename)
        f = open(filePath, "r", encoding="utf-8")
        lines = f.readlines()
        f.close()

        for line in lines:
            line = line.strip()
            if (len(line) == 0):
                continue
            try:
                entry = json.loads(line)
                entries.append(entry)
            except json.JSONDecodeError:
                continue

    return entries


def normalize(text):
    return text.strip().lower()


def findRelevantDocs(query, dataset):
    queryNorm = normalize(query)
    relevant = []

    for i in range(len(dataset)):
        studentNorm = normalize(dataset[i]["student"])
        if (queryNorm == studentNorm):
            relevant.append(i)
        elif (queryNorm in studentNorm or studentNorm in queryNorm):
            relevant.append(i)

    return relevant


def precisionAtK(retrievedIndices, relevantIndices, k):
    if (k == 0):
        return 0.0

    topK = retrievedIndices[:k]
    hits = 0
    for idx in topK:
        if (idx in relevantIndices):
            hits = hits + 1

    return hits / k


def recallAtK(retrievedIndices, relevantIndices, k):
    if (len(relevantIndices) == 0):
        return 0.0

    topK = retrievedIndices[:k]
    hits = 0
    for idx in topK:
        if (idx in relevantIndices):
            hits = hits + 1

    return hits / len(relevantIndices)


def averagePrecision(retrievedIndices, relevantIndices):
    if (len(relevantIndices) == 0):
        return 0.0

    score = 0.0
    hits = 0

    for rank in range(len(retrievedIndices)):
        if (retrievedIndices[rank] in relevantIndices):
            hits = hits + 1
            score = score + (hits / (rank + 1))

    return score / len(relevantIndices)


def reciprocalRank(retrievedIndices, relevantIndices):
    for rank in range(len(retrievedIndices)):
        if (retrievedIndices[rank] in relevantIndices):
            return 1.0 / (rank + 1)

    return 0.0


def evaluate(logDir=None, k=None):
    if (logDir is None):
        logDir = config.LOG_DIR
    if (k is None):
        k = config.DEFAULT_K

    print("Loading datasets...")
    datasets = loadAllDatasets()
    print("Loaded datasets for exercises:", list(datasets.keys()))

    print("Loading logs from:", logDir)
    entries = loadLogs(logDir)
    print("Loaded", len(entries), "log entries")

    if (len(entries) == 0):
        print("No log entries found. Run some interactions first.")
        return None

    # Filter entries that have retrieved docs
    evaluated = []
    for entry in entries:
        retrieved = entry.get("retrievedDocs", [])
        exerciseNum = entry.get("exerciseNum")
        query = entry.get("query", "")

        if (exerciseNum is None or exerciseNum not in datasets):
            continue
        if (len(retrieved) == 0):
            continue
        if (len(query) == 0):
            continue

        dataset = datasets[exerciseNum]
        relevant = findRelevantDocs(query, dataset)

        # Extract indices from retrieved docs (match by student text)
        retrievedIndices = []
        for doc in retrieved:
            studentText = ""
            if (isinstance(doc, dict)):
                studentText = doc.get("student", doc.get("document", ""))
            elif (isinstance(doc, str)):
                studentText = doc

            # Find matching index in dataset
            for j in range(len(dataset)):
                if (normalize(dataset[j]["student"]) == normalize(studentText)):
                    retrievedIndices.append(j)
                    break

        if (len(retrievedIndices) == 0):
            continue

        pAtK = precisionAtK(retrievedIndices, relevant, k)
        rAtK = recallAtK(retrievedIndices, relevant, k)
        ap = averagePrecision(retrievedIndices, relevant)
        rr = reciprocalRank(retrievedIndices, relevant)

        evaluated.append({
            "query": query,
            "exerciseNum": exerciseNum,
            "classification": entry.get("classification", ""),
            "precisionAtK": pAtK,
            "recallAtK": rAtK,
            "averagePrecision": ap,
            "reciprocalRank": rr,
            "numRetrieved": len(retrievedIndices),
            "numRelevant": len(relevant),
        })

    if (len(evaluated) == 0):
        print("No evaluable entries found (no retrieved docs matched datasets).")
        return None

    # Compute aggregate metrics
    totalP = 0.0
    totalR = 0.0
    totalAP = 0.0
    totalRR = 0.0

    for e in evaluated:
        totalP = totalP + e["precisionAtK"]
        totalR = totalR + e["recallAtK"]
        totalAP = totalAP + e["averagePrecision"]
        totalRR = totalRR + e["reciprocalRank"]

    n = len(evaluated)
    metrics = {
        "numQueries": n,
        "k": k,
        "meanPrecisionAtK": round(totalP / n, 4),
        "meanRecallAtK": round(totalR / n, 4),
        "mapAtK": round(totalAP / n, 4),
        "mrr": round(totalRR / n, 4),
        "perQuery": evaluated,
    }

    # Save results
    os.makedirs(config.RESULTS_DIR, exist_ok=True)
    outputPath = os.path.join(config.RESULTS_DIR, "retrievalMetrics.json")
    f = open(outputPath, "w", encoding="utf-8")
    json.dump(metrics, f, indent=2, ensure_ascii=False)
    f.close()

    print("\n=== Retrieval Metrics (K=" + str(k) + ") ===")
    print("Queries evaluated:", n)
    print("Mean Precision@" + str(k) + ":", metrics["meanPrecisionAtK"])
    print("Mean Recall@" + str(k) + ":", metrics["meanRecallAtK"])
    print("MAP@" + str(k) + ":", metrics["mapAtK"])
    print("MRR:", metrics["mrr"])
    print("\nResults saved to:", outputPath)

    return metrics


if (__name__ == "__main__"):
    k = config.DEFAULT_K
    if (len(sys.argv) > 1):
        k = int(sys.argv[1])

    evaluate(k=k)
