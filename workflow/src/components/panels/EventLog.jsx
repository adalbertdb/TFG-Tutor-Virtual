// Scrollable event log panel (right sidebar)

import { useEffect, useRef } from "react";

var statusBadge = {
  start: { bg: "#1e3a5f", color: "#93c5fd", label: "START" },
  end: { bg: "#14532d", color: "#86efac", label: "END" },
  skip: { bg: "#1e293b", color: "#64748b", label: "SKIP" },
};

export default function EventLog({ eventLog, onSelectEvent }) {
  var scrollRef = useRef(null);

  useEffect(function () {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [eventLog.length]);

  var baseTime = eventLog.length > 0 ? eventLog[0].timestamp : 0;

  return (
    <div style={{
      width: "320px",
      background: "#1e293b",
      borderLeft: "1px solid #334155",
      display: "flex",
      flexDirection: "column",
      flexShrink: 0,
    }}>
      <div style={{
        padding: "8px 12px",
        borderBottom: "1px solid #334155",
        fontSize: "12px",
        fontWeight: 600,
        color: "#e2e8f0",
        display: "flex",
        justifyContent: "space-between",
      }}>
        <span>Event Log</span>
        <span style={{ color: "#64748b" }}>{eventLog.length} events</span>
      </div>
      <div ref={scrollRef} style={{
        flex: 1,
        overflowY: "auto",
        padding: "4px",
      }}>
        {eventLog.map(function (ev, i) {
          var badge = statusBadge[ev.status] || statusBadge.end;
          var relTime = ev.timestamp - baseTime;

          return (
            <div
              key={i}
              onClick={function () { if (onSelectEvent) onSelectEvent(ev); }}
              style={{
                padding: "4px 8px",
                borderBottom: "1px solid #0f172a",
                cursor: "pointer",
                fontSize: "10px",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span style={{ color: "#64748b", fontFamily: "monospace", minWidth: "45px" }}>
                +{relTime}ms
              </span>
              <span style={{
                background: badge.bg,
                color: badge.color,
                padding: "1px 4px",
                borderRadius: "3px",
                fontSize: "9px",
                fontWeight: 600,
                minWidth: "32px",
                textAlign: "center",
              }}>
                {badge.label}
              </span>
              <span style={{ color: "#e2e8f0", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {ev.event}
              </span>
              {renderQuickData(ev)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function renderQuickData(ev) {
  var d = ev.data;
  var text = "";

  if (d.type) text = d.type;
  else if (d.decision) text = d.decision;
  else if (d.resultCount != null) text = d.resultCount + " res";
  else if (d.responseLength) text = d.responseLength + " ch";
  else if (d.totalTimeMs) text = d.totalTimeMs + "ms";
  else if (d.durationMs) text = d.durationMs + "ms";
  else if (d.leaked) text = "LEAKED";
  else if (d.confirmed) text = "CONFIRMED";
  else if (d.revealed) text = "REVEALED";
  else if (d.error) text = "ERROR";

  if (!text) return null;

  return (
    <span style={{ color: "#94a3b8", fontSize: "9px" }}>
      {text}
    </span>
  );
}
