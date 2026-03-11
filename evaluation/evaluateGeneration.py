# Generation quality metrics using RAGAS
# Evaluates: faithfulness, answer_relevancy, context_precision, context_recall
# Reads RAG interaction logs (JSONL) and computes RAGAS metrics

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


def findBestGroundTruth(query, dataset):
    queryNorm = query.strip().lower()
    bestMatch = None
    bestOverlap = 0

    for pair in dataset:
        studentNorm = pair["student"].strip().lower()

        # Count word overlap
        queryWords = queryNorm.split()
        studentWords = studentNorm.split()

        overlap = 0
        for qWord in queryWords:
            for sWord in studentWords:
                if (qWord == sWord):
                    overlap = overlap + 1
                    break

        if (overlap > bestOverlap):
            bestOverlap = overlap
            bestMatch = pair

    return bestMatch


def prepareRagasData(entries, datasets):
    questions = []
    answers = []
    contexts = []
    groundTruths = []

    for entry in entries:
        exerciseNum = entry.get("exerciseNum")
        query = entry.get("query", "")
        response = entry.get("response", "")
        augmentation = entry.get("augmentation", "")
        retrievedDocs = entry.get("retrievedDocs", [])

        if (exerciseNum is None or exerciseNum not in datasets):
            continue
        if (len(query) == 0 or len(response) == 0):
            continue

        # Build context from retrieved docs and augmentation
        contextParts = []
        for doc in retrievedDocs:
            if (isinstance(doc, dict)):
                student = doc.get("student", doc.get("document", ""))
                tutor = doc.get("tutor", doc.get("tutor_response", ""))
                if (len(student) > 0):
                    contextParts.append("Student: " + student + " Tutor: " + tutor)
            elif (isinstance(doc, str)):
                contextParts.append(doc)

        if (len(augmentation) > 0):
            contextParts.append(augmentation)

        if (len(contextParts) == 0):
            continue

        # Find ground truth from dataset
        dataset = datasets[exerciseNum]
        gtPair = findBestGroundTruth(query, dataset)

        if (gtPair is None):
            continue

        questions.append(query)
        answers.append(response)
        contexts.append(contextParts)
        groundTruths.append(gtPair["tutor"])

    return questions, answers, contexts, groundTruths


def evaluate(logDir=None):
    if (logDir is None):
        logDir = config.LOG_DIR

    print("Loading datasets...")
    datasets = loadAllDatasets()
    print("Loaded datasets for exercises:", list(datasets.keys()))

    print("Loading logs from:", logDir)
    entries = loadLogs(logDir)
    print("Loaded", len(entries), "log entries")

    if (len(entries) == 0):
        print("No log entries found. Run some interactions first.")
        return None

    # Filter entries with responses
    withResponse = []
    for entry in entries:
        if (len(entry.get("response", "")) > 0):
            withResponse.append(entry)

    print("Entries with responses:", len(withResponse))

    questions, answers, contexts, groundTruths = prepareRagasData(withResponse, datasets)
    print("Prepared", len(questions), "entries for RAGAS evaluation")

    if (len(questions) == 0):
        print("No evaluable entries. Need entries with retrieved docs and matching ground truth.")
        return None

    # Try to run RAGAS evaluation
    try:
        from ragas import evaluate as ragasEvaluate
        from ragas.metrics import faithfulness, answer_relevancy, context_precision, context_recall
        from datasets import Dataset

        # Build RAGAS dataset
        ragasData = {
            "question": questions,
            "answer": answers,
            "contexts": contexts,
            "ground_truth": groundTruths,
        }

        dataset = Dataset.from_dict(ragasData)

        print("\nRunning RAGAS evaluation...")
        result = ragasEvaluate(
            dataset,
            metrics=[faithfulness, answer_relevancy, context_precision, context_recall],
        )

        metrics = {
            "numQueries": len(questions),
            "faithfulness": round(result["faithfulness"], 4),
            "answerRelevancy": round(result["answer_relevancy"], 4),
            "contextPrecision": round(result["context_precision"], 4),
            "contextRecall": round(result["context_recall"], 4),
        }

        # Save results
        os.makedirs(config.RESULTS_DIR, exist_ok=True)
        outputPath = os.path.join(config.RESULTS_DIR, "ragasMetrics.json")
        f = open(outputPath, "w", encoding="utf-8")
        json.dump(metrics, f, indent=2, ensure_ascii=False)
        f.close()

        print("\n=== RAGAS Metrics ===")
        print("Queries evaluated:", metrics["numQueries"])
        print("Faithfulness:", metrics["faithfulness"])
        print("Answer Relevancy:", metrics["answerRelevancy"])
        print("Context Precision:", metrics["contextPrecision"])
        print("Context Recall:", metrics["contextRecall"])
        print("\nResults saved to:", outputPath)

        return metrics

    except ImportError:
        print("\nRAGAS not installed. Install with: pip install -r requirements.txt")
        print("Falling back to basic generation metrics...\n")

        return evaluateBasic(questions, answers, contexts, groundTruths)


def evaluateBasic(questions, answers, contexts, groundTruths):
    totalLength = 0
    totalQuestionWords = 0
    hasQuestionMark = 0
    guardrailSafe = 0

    for answer in answers:
        totalLength = totalLength + len(answer)

        # Count question marks (Socratic indicator)
        if ("?" in answer):
            hasQuestionMark = hasQuestionMark + 1

        # Count question-like words
        lower = answer.lower()
        for word in config.QUESTION_WORDS:
            if (word in lower):
                totalQuestionWords = totalQuestionWords + 1

        # Check no solution leak (basic)
        isSafe = True
        for phrase in config.REVEAL_PHRASES:
            if (phrase in lower):
                isSafe = False
                break
        if (isSafe):
            guardrailSafe = guardrailSafe + 1

    n = len(answers)
    metrics = {
        "numQueries": n,
        "avgResponseLength": round(totalLength / n, 1),
        "socraticRate": round(hasQuestionMark / n, 4),
        "avgQuestionWords": round(totalQuestionWords / n, 2),
        "guardrailSafeRate": round(guardrailSafe / n, 4),
    }

    # Save results
    os.makedirs(config.RESULTS_DIR, exist_ok=True)
    outputPath = os.path.join(config.RESULTS_DIR, "generationMetricsBasic.json")
    f = open(outputPath, "w", encoding="utf-8")
    json.dump(metrics, f, indent=2, ensure_ascii=False)
    f.close()

    print("=== Basic Generation Metrics ===")
    print("Queries evaluated:", n)
    print("Avg response length:", metrics["avgResponseLength"], "chars")
    print("Socratic rate (has ?):", metrics["socraticRate"])
    print("Avg question words:", metrics["avgQuestionWords"])
    print("Guardrail safe rate:", metrics["guardrailSafeRate"])
    print("\nResults saved to:", outputPath)

    return metrics


if (__name__ == "__main__"):
    evaluate()
