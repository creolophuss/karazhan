import { useEffect, useState } from "react";

import { describeClientError, loadAllSteps, loadRecentSteps } from "../features/today.ts";
import { karazhanClient, type ProgressEvent } from "../lib/karazhan-client.ts";

type StepsState =
  | { status: "idle" | "loading" }
  | { status: "ready"; events: ProgressEvent[] }
  | { status: "error"; message: string };

interface TodayRecentStepsProps {
  nodeId: string;
  blocker: string | null;
  enabled: boolean;
  includeDescendants?: boolean;
  refreshToken?: number;
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

export default function TodayRecentSteps({
  nodeId,
  blocker,
  enabled,
  includeDescendants = false,
  refreshToken = 0,
}: TodayRecentStepsProps) {
  const [state, setState] = useState<StepsState>({ status: "idle" });
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    setState({ status: "loading" });
    const load = showAll ? loadAllSteps : loadRecentSteps;
    load(karazhanClient, nodeId, includeDescendants).then(
      (events) => setState({ status: "ready", events }),
      (error: unknown) => setState({ status: "error", message: describeClientError(error) }),
    );
  }, [enabled, includeDescendants, nodeId, refreshToken, showAll]);

  return (
    <section className="today-steps" aria-labelledby={`today-steps-${nodeId}`}>
      <div className="steps-heading"><h3 id={`today-steps-${nodeId}`}>{showAll ? "Action log" : "Recent steps"}</h3>{state.status === "ready" && (showAll || state.events.length > 0) && <button type="button" onClick={() => setShowAll((current) => !current)}>{showAll ? "Show recent" : "View action log"}</button>}</div>
      {state.status === "loading" && <p className="today-steps-state">Loading…</p>}
      {state.status === "error" && (
        <p className="today-steps-state error" role="alert">{state.message}</p>
      )}
      {state.status === "ready" && blocker === null && state.events.length === 0 && (
        <p className="today-steps-state">No recent steps.</p>
      )}
      <ul>
        {blocker && <li className="blocker-step">Blocked: {blocker}</li>}
        {state.status === "ready" && state.events.map((event) => (
          <li className={event.step_status === "pending" ? "pending-step" : undefined} key={event.id}>
            {event.subject_node_id !== nodeId && <span className="step-source">{event.subject_title}</span>}
            <span className="step-summary">{event.summary}</span>
            {event.step_status && <span className={`step-status ${event.step_status.replaceAll("_", "-")}`}>{statusLabel(event.step_status)}</span>}
            {showAll && event.details && <div className="action-log-details">{event.details}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
