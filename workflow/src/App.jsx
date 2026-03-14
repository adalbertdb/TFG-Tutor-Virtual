// Main workflow monitor app: React Flow graph + flow diagram + panels + export

import { useState, useMemo, useCallback } from "react";
import { ReactFlow, Background, Controls, MiniMap } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./App.css";

import useWorkflowSocket from "./hooks/useWorkflowSocket.js";
import { initialNodes, initialEdges } from "./components/layout/workflowLayout.js";
import PipelineStepNode from "./components/nodes/PipelineStepNode.jsx";
import ExternalServiceNode from "./components/nodes/ExternalServiceNode.jsx";
import AlgorithmNode from "./components/nodes/AlgorithmNode.jsx";
import GuardrailNode from "./components/nodes/GuardrailNode.jsx";
import AnimatedEdge from "./components/edges/AnimatedEdge.jsx";
import RequestInfo from "./components/panels/RequestInfo.jsx";
import EventLog from "./components/panels/EventLog.jsx";
import NodeDetail from "./components/panels/NodeDetail.jsx";
import TimingBar from "./components/panels/TimingBar.jsx";
import RequestHistory from "./components/panels/RequestHistory.jsx";
import ExportButton from "./components/panels/ExportExcel.jsx";
import FlowDiagram from "./components/panels/FlowDiagram.jsx";

var WS_URL = "ws://localhost:3000/ws/workflow";

var nodeTypes = {
  pipelineStep: PipelineStepNode,
  externalService: ExternalServiceNode,
  algorithmNode: AlgorithmNode,
  guardrailNode: GuardrailNode,
};

var edgeTypes = {
  animated: AnimatedEdge,
};

export default function App() {
  var ws = useWorkflowSocket(WS_URL);
  var [activeTab, setActiveTab] = useState("graph"); // "graph" or "flow"

  // Merge node states into node data for rendering
  var nodes = useMemo(function () {
    return initialNodes.map(function (node) {
      return Object.assign({}, node, {
        data: Object.assign({}, node.data, {
          nodeState: ws.nodeStates[node.id] || null,
        }),
        selected: ws.selectedNode === node.id,
      });
    });
  }, [ws.nodeStates, ws.selectedNode]);

  var onNodeClick = useCallback(function (_event, node) {
    ws.selectNode(node.id);
  }, [ws.selectNode]);

  var onPaneClick = useCallback(function () {
    ws.selectNode(null);
  }, [ws.selectNode]);

  var tabStyle = function (tab) {
    return {
      padding: "4px 14px",
      fontSize: "11px",
      fontWeight: 600,
      cursor: "pointer",
      background: activeTab === tab ? "#1e40af" : "transparent",
      color: activeTab === tab ? "#e2e8f0" : "#64748b",
      border: "1px solid " + (activeTab === tab ? "#3b82f6" : "#475569"),
      borderRadius: "4px",
      transition: "all 0.2s",
    };
  };

  return (
    <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column", background: "#0f172a" }}>
      {/* Top bar: request info + tabs + export button */}
      <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #334155", background: "#1e293b", flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <RequestInfo currentRequest={ws.currentRequest} connected={ws.connected} />
        </div>
        <div style={{ display: "flex", gap: "6px", padding: "0 12px" }}>
          <button onClick={function () { setActiveTab("graph"); }} style={tabStyle("graph")}>
            Component Graph
          </button>
          <button onClick={function () { setActiveTab("flow"); }} style={tabStyle("flow")}>
            Flow Diagram
          </button>
        </div>
        <div style={{ padding: "0 12px" }}>
          <ExportButton requestHistory={ws.requestHistory} />
        </div>
      </div>

      {/* Main area: history + center view + event log */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Left: Request History */}
        {ws.requestHistory.length > 0 && (
          <RequestHistory requestHistory={ws.requestHistory} />
        )}

        {/* Center: Graph or Flow Diagram */}
        <div style={{ flex: 1, position: "relative" }}>
          {activeTab === "graph" ? (
            <ReactFlow
              nodes={nodes}
              edges={initialEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.3}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#334155" gap={20} size={1} />
              <Controls
                style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: "6px" }}
                buttonStyle={{ color: "#94a3b8", background: "#1e293b", border: "none" }}
              />
            {/*  <MiniMap
                style={{ background: "#1e293b", border: "1px solid #334155" }}
                nodeColor={function (node) {
                  var state = ws.nodeStates[node.id];
                  if (!state) return "#475569";
                  var colors = { idle: "#475569", active: "#3b82f6", completed: "#22c55e", error: "#ef4444", skipped: "#64748b" };
                  return colors[state.status] || "#475569";
                }}
              />*/}
            </ReactFlow>
          ) : (
            <FlowDiagram
              nodeStates={ws.nodeStates}
              currentRequest={ws.currentRequest}
              onSelectNode={ws.selectNode}
            />
          )}
        </div>

        {/* Right: Event Log */}
        <EventLog
          eventLog={ws.eventLog}
          selectedEvent={ws.selectedEvent}
          onSelectEvent={ws.selectEvent}
        />
      </div>

      {/* Bottom: Timing + Node detail */}
      <TimingBar nodeStates={ws.nodeStates} currentRequest={ws.currentRequest} />
      <NodeDetail selectedNode={ws.selectedNode} nodeStates={ws.nodeStates} />
    </div>
  );
}
