# Central configuration for all evaluation scripts

import os

# Paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
LOG_DIR = os.path.join(PROJECT_ROOT, "logs", "rag")
DATASETS_DIR = os.path.join(PROJECT_ROOT, "material-complementario", "llm", "datasets")
RESULTS_DIR = os.path.join(SCRIPT_DIR, "results")

# Exercise number -> dataset filename
DATASET_MAP = {
    1: "dataset_exercise_1.json",
    2: "dataset_exercise_1.json",
    3: "dataset_exercise_3.json",
    4: "dataset_exercise_4.json",
    5: "dataset_exercise_5.json",
    6: "dataset_exercise_6.json",
    7: "dataset_exercise_7.json",
}

# Retrieval evaluation
DEFAULT_K = 3

# Benchmark server
BASE_URL = os.environ.get("TUTOR_API_URL", "http://localhost:3000")
STREAM_ENDPOINT = "/api/ollama/chat/stream"
TEST_SAMPLES_PER_EXERCISE = 5
TEST_USER_ID = os.environ.get("TEST_USER_ID", "")

# Basic generation metrics (Socratic indicators)
QUESTION_WORDS = ["por qué", "cómo", "qué", "cuál", "dónde"]
REVEAL_PHRASES = ["la respuesta es", "las resistencias son", "la solución es"]
