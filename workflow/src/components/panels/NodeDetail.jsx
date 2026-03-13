// Bottom panel showing full parameter detail for the selected node

export default function NodeDetail({ selectedNode, nodeStates }) {
  if (!selectedNode) {
    return (
      <div style={{
        height: "160px",
        background: "#1e293b",
        borderTop: "1px solid #334155",
        padding: "12px 16px",
        fontSize: "12px",
        color: "#64748b",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}>
        Click on a node to see its parameters
      </div>
    );
  }

  var state = nodeStates[selectedNode];
  if (!state) return null;

  var duration = state.startTime && state.endTime ? state.endTime - state.startTime : null;

  return (
    <div style={{
      height: "160px",
      background: "#1e293b",
      borderTop: "1px solid #334155",
      padding: "8px 16px",
      fontSize: "11px",
      overflowY: "auto",
      flexShrink: 0,
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        marginBottom: "8px",
      }}>
        <span style={{ fontWeight: 600, color: "#e2e8f0", fontSize: "13px" }}>
          {selectedNode}
        </span>
        <StatusBadge status={state.status} />
        {duration != null && (
          <span style={{ color: "#94a3b8", fontFamily: "monospace" }}>
            {duration}ms
          </span>
        )}
      </div>

      {state.data && (
        <pre style={{
          color: "#94a3b8",
          fontSize: "10px",
          lineHeight: "1.5",
          margin: 0,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          background: "#0f172a",
          padding: "8px",
          borderRadius: "4px",
          maxHeight: "110px",
          overflowY: "auto",
        }}>
          {JSON.stringify(state.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  var colors = {
    idle: { bg: "#334155", color: "#94a3b8" },
    active: { bg: "#1e3a5f", color: "#93c5fd" },
    completed: { bg: "#14532d", color: "#86efac" },
    error: { bg: "#450a0a", color: "#fca5a5" },
    skipped: { bg: "#334155", color: "#64748b" },
  };
  var c = colors[status] || colors.idle;

  return (
    <span style={{
      background: c.bg,
      color: c.color,
      padding: "2px 6px",
      borderRadius: "4px",
      fontSize: "10px",
      fontWeight: 600,
      textTransform: "uppercase",
    }}>
      {status}
    </span>
  );
}
