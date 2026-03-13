// Custom animated edge with flowing dots when active

import { BaseEdge, getStraightPath, EdgeLabelRenderer } from "@xyflow/react";

export default function AnimatedEdge({ id, sourceX, sourceY, targetX, targetY, label, style }) {
  var [edgePath, labelX, labelY] = getStraightPath({
    sourceX: sourceX,
    sourceY: sourceY,
    targetX: targetX,
    targetY: targetY,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: "#475569",
          strokeWidth: 1.5,
          ...style,
        }}
      />
      <circle r="3" fill="#3b82f6">
        <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
      </circle>
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: "translate(-50%, -50%) translate(" + labelX + "px," + labelY + "px)",
              fontSize: "9px",
              color: "#64748b",
              background: "#0f172a",
              padding: "1px 4px",
              borderRadius: "3px",
              pointerEvents: "none",
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
