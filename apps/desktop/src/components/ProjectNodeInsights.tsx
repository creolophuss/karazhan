import { useEffect, useState } from "react";

import {
  loadProjectNodeDetails,
  loadProjectTimeline,
  openProjectInZed,
  primaryAvailableWorkspace,
  type ProjectNodeDetails,
} from "../features/projects.ts";
import { describeClientError } from "../features/today.ts";
import {
  karazhanClient,
  type ProgressEvent,
} from "../lib/karazhan-client.ts";

type InsightsState =
  | { status: "idle" | "loading" }
  | { status: "ready"; details: ProjectNodeDetails }
  | { status: "error"; message: string };

interface ProjectNodeInsightsProps {
  nodeId: string;
  enabled: boolean;
}

function ProgressList({ events }: { events: readonly ProgressEvent[] }) {
  if (events.length === 0) return <p className="detail-empty">No progress recorded.</p>;
  return (
    <ol className="progress-list">
      {events.map((event) => (
        <li key={event.id}>
          <div>
            <span className="progress-kind">{event.event_type.replaceAll("_", " ")}</span>
            <time dateTime={event.occurred_at}>{event.occurred_at}</time>
          </div>
          <p>{event.summary}</p>
          {event.blocker && <p className="progress-blocker">Blocked: {event.blocker}</p>}
        </li>
      ))}
    </ol>
  );
}

export default function ProjectNodeInsights({ nodeId, enabled }: ProjectNodeInsightsProps) {
  const [state, setState] = useState<InsightsState>({ status: "idle" });
  const [timeline, setTimeline] = useState<ProgressEvent[] | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState("");
  const [showTimeline, setShowTimeline] = useState(false);
  const [zedState, setZedState] = useState<{
    status: "idle" | "opening" | "success" | "error";
    message: string;
  }>({ status: "idle", message: "" });

  useEffect(() => {
    if (!enabled || state.status !== "idle") return;
    setState({ status: "loading" });
    loadProjectNodeDetails(karazhanClient, nodeId).then(
      (details) => setState({ status: "ready", details }),
      (error: unknown) => {
        setState({ status: "error", message: describeClientError(error) });
      },
    );
  }, [enabled, nodeId]);

  async function toggleTimeline() {
    if (showTimeline) {
      setShowTimeline(false);
      return;
    }
    if (timeline !== null) {
      setShowTimeline(true);
      return;
    }
    setTimelineLoading(true);
    setTimelineError("");
    try {
      const events = await loadProjectTimeline(karazhanClient, nodeId);
      setTimeline(events);
      setShowTimeline(true);
    } catch (error) {
      setTimelineError(describeClientError(error));
    } finally {
      setTimelineLoading(false);
    }
  }

  async function openInZed() {
    setZedState({ status: "opening", message: "Opening Workspace in Zed…" });
    try {
      await openProjectInZed(karazhanClient, nodeId);
      setZedState({ status: "success", message: "Opened Workspace in Zed." });
    } catch (error) {
      setZedState({ status: "error", message: describeClientError(error) });
    }
  }

  if (state.status !== "ready") {
    if (state.status === "error") {
      return <p className="insights-state error" role="alert">{state.message}</p>;
    }
    return <p className="insights-state" role="status">Loading details…</p>;
  }

  const events = showTimeline && timeline !== null ? timeline : state.details.recentProgress;
  const workspace = primaryAvailableWorkspace(state.details.resourceBindings);
  return (
    <div className="node-insights">
      <section className="insight-section" aria-labelledby={`progress-title-${nodeId}`}>
        <div className="insight-heading">
          <h3 id={`progress-title-${nodeId}`}>
            {showTimeline ? "Progress timeline" : "Recent Progress"}
          </h3>
          <button type="button" disabled={timelineLoading} onClick={() => void toggleTimeline()}>
            {timelineLoading ? "Loading…" : showTimeline ? "Show recent" : "View full timeline"}
          </button>
        </div>
        {timelineError && <p className="insights-state error" role="alert">{timelineError}</p>}
        <ProgressList events={events} />
      </section>

      <section className="insight-section" aria-labelledby={`context-title-${nodeId}`}>
        <h3 id={`context-title-${nodeId}`}>Context</h3>
        {state.details.contextPath ? (
          <code className="context-path">{state.details.contextPath}</code>
        ) : (
          <p className="detail-empty">No Context path.</p>
        )}
        <p className="context-note">Path only. Context contents are not read.</p>
      </section>

      <section className="insight-section" aria-labelledby={`resources-title-${nodeId}`}>
        <div className="insight-heading">
          <h3 id={`resources-title-${nodeId}`}>Resource bindings</h3>
          {workspace && (
            <button
              type="button"
              disabled={zedState.status === "opening"}
              onClick={() => void openInZed()}
            >
              {zedState.status === "opening" ? "Opening…" : "Open in Zed"}
            </button>
          )}
        </div>
        {zedState.status !== "idle" && (
          <p
            className={`zed-feedback ${zedState.status}`}
            role={zedState.status === "error" ? "alert" : "status"}
          >
            {zedState.message}
          </p>
        )}
        {state.details.resourceBindings.length === 0 ? (
          <p className="detail-empty">No resource bindings.</p>
        ) : (
          <ul className="resource-list">
            {state.details.resourceBindings.map((binding) => (
              <li key={binding.id}>
                <div className="resource-meta">
                  <span>{binding.kind}</span>
                  {binding.is_primary && <span>primary</span>}
                  <span className={`availability ${binding.availability}`}>
                    {binding.availability}
                  </span>
                </div>
                <code>{binding.locator}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
