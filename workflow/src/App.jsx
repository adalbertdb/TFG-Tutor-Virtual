// Main workflow monitor app: React Flow graph + panels

import { useMemo, useCallback } from "react";
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

  return (
    <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column", background: "#0f172a" }}>
      <RequestInfo currentRequest={ws.currentRequest} connected={ws.connected} />

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: 1, position: "relative" }}>
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
            <MiniMap
              style={{ background: "#1e293b", border: "1px solid #334155" }}
              nodeColor={function (node) {
                var state = ws.nodeStates[node.id];
                if (!state) return "#475569";
                var colors = { idle: "#475569", active: "#3b82f6", completed: "#22c55e", error: "#ef4444", skipped: "#64748b" };
                return colors[state.status] || "#475569";
              }}
            />
          </ReactFlow>
        </div>

        <EventLog eventLog={ws.eventLog} />
      </div>

      <TimingBar nodeStates={ws.nodeStates} currentRequest={ws.currentRequest} />
      <NodeDetail selectedNode={ws.selectedNode} nodeStates={ws.nodeStates} />
    </div>
  );
}
