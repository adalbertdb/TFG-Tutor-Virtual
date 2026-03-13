// Static node positions and edge definitions for the RAG workflow graph

export var initialNodes = [
  // Layer 1 -- Entry & External Services
  { id: "frontend", position: { x: 50, y: 30 }, type: "externalService", data: { label: "Student (Frontend)", icon: "user" } },
  { id: "mongodb", position: { x: 900, y: 30 }, type: "externalService", data: { label: "MongoDB Atlas", icon: "database" } },

  // Layer 2 -- Middleware & Classification
  { id: "middleware", position: { x: 50, y: 160 }, type: "pipelineStep", data: { label: "RAG Middleware" } },
  { id: "classifier", position: { x: 350, y: 160 }, type: "pipelineStep", data: { label: "Query Classifier" } },
  { id: "orchestrator", position: { x: 650, y: 160 }, type: "pipelineStep", data: { label: "Pipeline Orchestrator" } },

  // Layer 3 -- Retrieval & Algorithms
  { id: "knowledge-graph", position: { x: 0, y: 320 }, type: "pipelineStep", data: { label: "Knowledge Graph" } },
  { id: "embedding", position: { x: 220, y: 320 }, type: "algorithmNode", data: { label: "Embedding Generator" } },
  { id: "bm25", position: { x: 440, y: 320 }, type: "algorithmNode", data: { label: "BM25 Search" } },
  { id: "chromadb", position: { x: 660, y: 320 }, type: "externalService", data: { label: "ChromaDB Semantic", icon: "vector" } },
  { id: "rrf", position: { x: 550, y: 450 }, type: "algorithmNode", data: { label: "RRF Fusion" } },
  { id: "crag", position: { x: 220, y: 450 }, type: "algorithmNode", data: { label: "CRAG Reformulation" } },
  { id: "student-history", position: { x: 900, y: 320 }, type: "pipelineStep", data: { label: "Student History" } },
  { id: "hybrid-search", position: { x: 880, y: 450 }, type: "pipelineStep", data: { label: "Hybrid Search" } },

  // Layer 4 -- Generation & Safety
  { id: "deterministic", position: { x: 0, y: 580 }, type: "pipelineStep", data: { label: "Deterministic Finish" } },
  { id: "poligpt", position: { x: 250, y: 580 }, type: "externalService", data: { label: "PoliGPT (Ollama qwen2.5)", icon: "llm" } },
  { id: "guardrail-leak", position: { x: 500, y: 580 }, type: "guardrailNode", data: { label: "Solution Leak" } },
  { id: "guardrail-confirm", position: { x: 680, y: 580 }, type: "guardrailNode", data: { label: "False Confirmation" } },
  { id: "guardrail-state", position: { x: 860, y: 580 }, type: "guardrailNode", data: { label: "State Reveal" } },

  // Layer 5 -- Output
  { id: "response", position: { x: 250, y: 710 }, type: "pipelineStep", data: { label: "Response (SSE)" } },
  { id: "logger", position: { x: 550, y: 710 }, type: "pipelineStep", data: { label: "JSONL Logger" } },

  // Data Sources (background)
  { id: "datasets", position: { x: 440, y: 230 }, type: "externalService", data: { label: "Datasets", icon: "data" } },
  { id: "kg-data", position: { x: 0, y: 230 }, type: "externalService", data: { label: "KG Data", icon: "data" } },
];

export var initialEdges = [
  // Layer 1 → 2
  { id: "e-frontend-middleware", source: "frontend", target: "middleware", type: "animated" },
  { id: "e-middleware-mongodb-load", source: "middleware", target: "mongodb", type: "animated", label: "load exercise" },
  { id: "e-middleware-classifier", source: "middleware", target: "classifier", type: "animated" },
  { id: "e-classifier-orchestrator", source: "classifier", target: "orchestrator", type: "animated" },

  // Layer 2 → 3 (conditional)
  { id: "e-orchestrator-kg", source: "orchestrator", target: "knowledge-graph", type: "animated" },
  { id: "e-orchestrator-hybrid", source: "orchestrator", target: "hybrid-search", type: "animated" },
  { id: "e-orchestrator-history", source: "orchestrator", target: "student-history", type: "animated" },
  { id: "e-hybrid-embedding", source: "hybrid-search", target: "embedding", type: "animated" },
  { id: "e-embedding-bm25", source: "embedding", target: "bm25", type: "animated" },
  { id: "e-embedding-chromadb", source: "embedding", target: "chromadb", type: "animated" },
  { id: "e-bm25-rrf", source: "bm25", target: "rrf", type: "animated" },
  { id: "e-chromadb-rrf", source: "chromadb", target: "rrf", type: "animated" },
  { id: "e-rrf-crag", source: "rrf", target: "crag", type: "animated", label: "low score" },
  { id: "e-crag-embedding", source: "crag", target: "embedding", type: "animated", label: "retry" },

  // Data sources
  { id: "e-kgdata-kg", source: "kg-data", target: "knowledge-graph", type: "animated" },
  { id: "e-datasets-bm25", source: "datasets", target: "bm25", type: "animated" },
  { id: "e-datasets-chromadb", source: "datasets", target: "chromadb", type: "animated" },

  // Layer 3 → 4
  { id: "e-middleware-deterministic", source: "middleware", target: "deterministic", type: "animated" },
  { id: "e-middleware-poligpt", source: "middleware", target: "poligpt", type: "animated" },
  { id: "e-poligpt-guardrail-leak", source: "poligpt", target: "guardrail-leak", type: "animated" },
  { id: "e-poligpt-guardrail-confirm", source: "poligpt", target: "guardrail-confirm", type: "animated" },
  { id: "e-poligpt-guardrail-state", source: "poligpt", target: "guardrail-state", type: "animated" },
  { id: "e-guardrail-leak-retry", source: "guardrail-leak", target: "poligpt", type: "animated", label: "retry" },
  { id: "e-guardrail-confirm-retry", source: "guardrail-confirm", target: "poligpt", type: "animated", label: "retry" },
  { id: "e-guardrail-state-retry", source: "guardrail-state", target: "poligpt", type: "animated", label: "retry" },

  // Layer 4 → 5
  { id: "e-middleware-response", source: "middleware", target: "response", type: "animated" },
  { id: "e-middleware-logger", source: "middleware", target: "logger", type: "animated" },
  { id: "e-response-frontend", source: "response", target: "frontend", type: "animated" },
  { id: "e-middleware-mongodb-save", source: "middleware", target: "mongodb", type: "animated", label: "save" },
  { id: "e-history-mongodb", source: "student-history", target: "mongodb", type: "animated" },
];
