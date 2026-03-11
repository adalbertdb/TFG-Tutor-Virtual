# Full RAG evaluation benchmark
# Sends test queries to the RAG endpoint, collects responses, then runs metrics

import json
import os
import sys
import time
import requests
import config

# Derived
STREAM_URL = config.BASE_URL + config.STREAM_ENDPOINT

# Exercise IDs loaded from env at runtime
TEST_EXERCISE_IDS = {}


def loadDataset(filePath):
    with open(filePath, "r", encoding="utf-8") as f:
        return json.load(f)


def selectTestSamples(dataset, n):
    if (len(dataset) <= n):
        return dataset

    # Pick evenly spaced samples
    step = len(dataset) // n
    samples = []
    for i in range(n):
        samples.append(dataset[i * step])

    return samples


def sendQuery(userId, exerciseId, message, interaccionId=None):
    payload = {
        "userId": userId,
        "exerciseId": exerciseId,
        "userMessage": message,
    }
    if (interaccionId is not None):
        payload["interaccionId"] = interaccionId

    try:
        response = requests.post(
            STREAM_URL,
            json=payload,
            headers={"Content-Type": "application/json"},
            stream=True,
            timeout=120,
        )

        if (response.status_code != 200):
            print("  Error: HTTP", response.status_code)
            return None

        # Parse SSE stream
        fullResponse = ""
        newInteraccionId = None

        for line in response.iter_lines(decode_unicode=True):
            if (line is None or len(line) == 0):
                continue
            if (line.startswith(":")):
                continue
            if (not line.startswith("data: ")):
                continue

            dataStr = line[6:]  # Remove "data: " prefix

            if (dataStr == "[DONE]"):
                break

            try:
                data = json.loads(dataStr)
                if ("interaccionId" in data):
                    newInteraccionId = data["interaccionId"]
                if ("chunk" in data):
                    fullResponse = fullResponse + data["chunk"]
                if ("error" in data):
                    print("  Server error:", data["error"])
                    return None
            except json.JSONDecodeError:
                continue

        return {
            "response": fullResponse,
            "interaccionId": newInteraccionId,
        }

    except requests.exceptions.RequestException as e:
        print("  Request failed:", str(e))
        return None


def runBenchmark():
    global TEST_EXERCISE_IDS

    print("=== RAG Benchmark ===\n")

    # Check config
    if (len(config.TEST_USER_ID) == 0):
        print("ERROR: Set TEST_USER_ID environment variable (MongoDB ObjectId of a test user)")
        print("  export TEST_USER_ID=64a1b2c3d4e5f6a7b8c9d0e1")
        return

    if (len(TEST_EXERCISE_IDS) == 0):
        # Try loading from env
        idsEnv = os.environ.get("TEST_EXERCISE_IDS", "")
        if (len(idsEnv) > 0):
            try:
                parsed = json.loads(idsEnv)
                keys = list(parsed.keys())
                for key in keys:
                    TEST_EXERCISE_IDS[int(key)] = parsed[key]
                print("Loaded exercise IDs from environment:", TEST_EXERCISE_IDS)
            except (json.JSONDecodeError, ValueError):
                print("Failed to parse TEST_EXERCISE_IDS")
                return
        else:
            print("ERROR: No exercise IDs configured.")
            print("Set TEST_EXERCISE_IDS as a JSON env var: {\"1\": \"objectid1\", \"3\": \"objectid3\", ...}")
            print("  export TEST_EXERCISE_IDS='{\"1\":\"...\",\"3\":\"...\"}'")
            return

    # Check server is running
    try:
        health = requests.get(config.BASE_URL + "/api/health", timeout=5)
        if (health.status_code != 200):
            print("Server health check failed. Is the server running at", config.BASE_URL, "?")
            return
        print("Server is running at", config.BASE_URL)
    except requests.exceptions.RequestException:
        print("Cannot connect to server at", config.BASE_URL)
        print("Start the server first: cd backend && npm start")
        return

    # Run test queries
    allResults = []

    exerciseNums = list(config.DATASET_MAP.keys())
    for exerciseNum in exerciseNums:
        # Skip canonical duplicates (exercise 2 uses same dataset as 1)
        if (exerciseNum == 2):
            continue

        datasetFile = config.DATASET_MAP[exerciseNum]

        if (exerciseNum not in TEST_EXERCISE_IDS):
            print("\nSkipping exercise", exerciseNum, "(no exercise ID configured)")
            continue

        exerciseId = TEST_EXERCISE_IDS[exerciseNum]
        filePath = os.path.join(config.DATASETS_DIR, datasetFile)

        if (not os.path.exists(filePath)):
            print("\nSkipping exercise", exerciseNum, "(dataset not found)")
            continue

        dataset = loadDataset(filePath)
        samples = selectTestSamples(dataset, config.TEST_SAMPLES_PER_EXERCISE)

        print("\n--- Exercise", exerciseNum, "(" + str(len(samples)) + " test queries) ---")

        for i in range(len(samples)):
            sample = samples[i]
            query = sample["student"]
            expected = sample["tutor"]

            print("  [" + str(i + 1) + "/" + str(len(samples)) + "] Query:", query[:60] + "...")

            start = time.time()
            result = sendQuery(config.TEST_USER_ID, exerciseId, query)
            elapsed = round(time.time() - start, 2)

            if (result is None):
                print("    FAILED")
                continue

            response = result["response"]
            if (len(response) > 80):
                print("    Response:", response[:80] + "...")
            else:
                print("    Response:", response)
            print("    Time:", elapsed, "s")

            allResults.append({
                "exerciseNum": exerciseNum,
                "query": query,
                "expected": expected,
                "response": response,
                "timeSeconds": elapsed,
            })

            # Small delay between requests
            time.sleep(1)

    if (len(allResults) == 0):
        print("\nNo results collected. Check server and configuration.")
        return

    # Save benchmark results
    os.makedirs(config.RESULTS_DIR, exist_ok=True)
    outputPath = os.path.join(config.RESULTS_DIR, "benchmarkResults.json")
    f = open(outputPath, "w", encoding="utf-8")
    json.dump(allResults, f, indent=2, ensure_ascii=False)
    f.close()

    print("\n\n=== Benchmark Summary ===")
    print("Total queries:", len(allResults))

    totalTime = 0.0
    for r in allResults:
        totalTime = totalTime + r["timeSeconds"]

    print("Avg response time:", round(totalTime / len(allResults), 2), "s")
    print("Results saved to:", outputPath)

    # Run evaluation metrics
    print("\n\n=== Running Retrieval Evaluation ===")
    from evaluateRetrieval import evaluate as evalRetrieval
    evalRetrieval()

    print("\n\n=== Running Generation Evaluation ===")
    from evaluateGeneration import evaluate as evalGeneration
    evalGeneration()

    print("\n\nBenchmark complete. Check", config.RESULTS_DIR, "for detailed results.")

    # Try to launch Phoenix UI
    try:
        import phoenix
        print("\nLaunching Phoenix UI for trace visualization...")
        print("Open http://localhost:6006 in your browser")
        phoenix.launch_app()
    except ImportError:
        print("\nPhoenix not installed. Install with: pip install arize-phoenix")
        print("Then run this script again to get trace visualization.")


if (__name__ == "__main__"):
    runBenchmark()
