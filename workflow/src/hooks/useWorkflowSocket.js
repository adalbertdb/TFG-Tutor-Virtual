// WebSocket hook for connecting to the RAG workflow event bus
// Manages node states, event log, and current request metadata

import { useState, useEffect, useRef, useCallback } from "react";

// Maps event names to node IDs in the React Flow graph
const eventToNode = {
  request_start: "middleware",
  exercise_loaded: "mongodb",
  pipeline_start: "orchestrator",
  pipeline_end: "orchestrator",
  no_rag: "orchestrator",
  classify_start: "classifier",
  classify_end: "classifier",
  routing_decision: "orchestrator",
  kg_search_start: "knowledge-graph",
  kg_search_end: "knowledge-graph",
  hybrid_search_start: "hybrid-search",
  hybrid_search_end: "hybrid-search",
  embedding_start: "embedding",
  embedding_end: "embedding",
  bm25_search_start: "bm25",
  bm25_search_end: "bm25",
  semantic_search_start: "chromadb",
  semantic_search_end: "chromadb",
  rrf_fusion_start: "rrf",
  rrf_fusion_end: "rrf",
  crag_reformulate: "crag",
  student_history_start: "student-history",
  student_history_end: "student-history",
  augmentation_built: "orchestrator",
  deterministic_finish: "deterministic",
  prompt_built: "middleware",
  history_loaded: "mongodb",
  ollama_call_start: "poligpt",
  ollama_call_end: "poligpt",
  guardrail_leak: "guardrail-leak",
  guardrail_false_confirm: "guardrail-confirm",
  guardrail_state_reveal: "guardrail-state",
  ollama_retry: "poligpt",
  response_sent: "response",
  mongodb_save: "mongodb",
  log_written: "logger",
  request_end: "middleware",
  request_error: "middleware",
};

// All node IDs used in the graph
const ALL_NODE_IDS = [
  "frontend", "middleware", "mongodb", "classifier", "orchestrator",
  "knowledge-graph", "hybrid-search", "embedding", "bm25", "chromadb",
  "rrf", "crag", "student-history", "deterministic", "poligpt",
  "guardrail-leak", "guardrail-confirm", "guardrail-state",
  "response", "logger", "datasets", "kg-data",
];

function buildIdleStates() {
  var states = {};
  for (var i = 0; i < ALL_NODE_IDS.length; i++) {
    states[ALL_NODE_IDS[i]] = { status: "idle", data: null, startTime: null, endTime: null };
  }
  return states;
}

export default function useWorkflowSocket(url) {
  var [connected, setConnected] = useState(false);
  var [nodeStates, setNodeStates] = useState(buildIdleStates);
  var [eventLog, setEventLog] = useState([]);
  var [currentRequest, setCurrentRequest] = useState(null);
  var [selectedNode, setSelectedNode] = useState(null);
  var wsRef = useRef(null);
  var retryRef = useRef(0);

  var connect = useCallback(function () {
    if (wsRef.current && wsRef.current.readyState < 2) return;

    var ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = function () {
      setConnected(true);
      retryRef.current = 0;
    };

    ws.onclose = function () {
      setConnected(false);
      var delay = Math.min(1000 * Math.pow(2, retryRef.current), 10000);
      retryRef.current++;
      setTimeout(connect, delay);
    };

    ws.onerror = function () {
      ws.close();
    };

    ws.onmessage = function (msg) {
      var event;
      try {
        event = JSON.parse(msg.data);
      } catch (e) {
        return;
      }

      // Add to event log
      setEventLog(function (prev) {
        var next = prev.concat(event);
        if (next.length > 500) next = next.slice(-500);
        return next;
      });

      // Handle request_start: reset all nodes
      if (event.event === "request_start") {
        setNodeStates(buildIdleStates());
        setCurrentRequest({
          requestId: event.requestId,
          userId: event.data.userId,
          userMessage: event.data.userMessage,
          exerciseId: event.data.exerciseId,
          startTime: event.timestamp,
        });
        // Activate frontend node
        setNodeStates(function (prev) {
          return Object.assign({}, prev, {
            frontend: { status: "completed", data: event.data, startTime: event.timestamp, endTime: event.timestamp },
          });
        });
      }

      // Update current request with classification/decision
      if (event.event === "classify_end") {
        setCurrentRequest(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, { classification: event.data.type });
        });
      }
      if (event.event === "routing_decision") {
        setCurrentRequest(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, { decision: event.data.decision, path: event.data.path });
        });
      }
      if (event.event === "request_end") {
        setCurrentRequest(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, { totalTimeMs: event.data.totalTimeMs });
        });
      }

      // Map event to node and update its state
      var nodeId = eventToNode[event.event];
      if (!nodeId) return;

      setNodeStates(function (prev) {
        var current = prev[nodeId] || { status: "idle", data: null };
        var newStatus = current.status;
        var newData = Object.assign({}, current.data || {}, event.data);

        if (event.status === "start") {
          newStatus = "active";
        } else if (event.status === "end") {
          // Special: guardrails show red if triggered
          if (event.event === "guardrail_leak" && event.data.result && event.data.result.leaked) {
            newStatus = "error";
          } else if (event.event === "guardrail_false_confirm" && event.data.result && event.data.result.confirmed) {
            newStatus = "error";
          } else if (event.event === "guardrail_state_reveal" && event.data.result && event.data.result.revealed) {
            newStatus = "error";
          } else if (event.event === "request_error") {
            newStatus = "error";
          } else {
            newStatus = "completed";
          }
        } else if (event.status === "skip") {
          newStatus = "skipped";
        }

        var updated = {};
        updated[nodeId] = {
          status: newStatus,
          data: newData,
          startTime: event.status === "start" ? event.timestamp : current.startTime,
          endTime: event.status === "end" ? event.timestamp : current.endTime,
        };
        return Object.assign({}, prev, updated);
      });

      // Also mark data source nodes when their consumers activate
      if (event.event === "kg_search_start") {
        setNodeStates(function (prev) {
          var u = {};
          u["kg-data"] = { status: "active", data: {}, startTime: event.timestamp, endTime: null };
          return Object.assign({}, prev, u);
        });
      }
      if (event.event === "kg_search_end") {
        setNodeStates(function (prev) {
          var u = {};
          u["kg-data"] = { status: "completed", data: event.data, startTime: prev["kg-data"].startTime, endTime: event.timestamp };
          return Object.assign({}, prev, u);
        });
      }
      if (event.event === "bm25_search_start" || event.event === "semantic_search_start") {
        setNodeStates(function (prev) {
          var u = {};
          u["datasets"] = { status: "active", data: event.data, startTime: event.timestamp, endTime: null };
          return Object.assign({}, prev, u);
        });
      }
      if (event.event === "bm25_search_end" || event.event === "semantic_search_end") {
        setNodeStates(function (prev) {
          var u = {};
          u["datasets"] = { status: "completed", data: event.data, startTime: prev["datasets"].startTime, endTime: event.timestamp };
          return Object.assign({}, prev, u);
        });
      }
    };
  }, [url]);

  useEffect(function () {
    connect();
    return function () {
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  return {
    connected: connected,
    nodeStates: nodeStates,
    eventLog: eventLog,
    currentRequest: currentRequest,
    selectedNode: selectedNode,
    selectNode: setSelectedNode,
  };
}
