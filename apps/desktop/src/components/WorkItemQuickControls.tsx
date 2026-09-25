import { useState } from "react";

import { saveWorkItemFields, type SaveFeedback } from "../features/today.ts";
import {
  karazhanClient,
  type Priority,
  type WorkStatus,
} from "../lib/karazhan-client.ts";

const STATUS_OPTIONS: WorkStatus[] = [
  "planned",
  "ready",
  "in_progress",
  "pending",
  "review",
  "done",
  "cancelled",
];
const PRIORITY_OPTIONS: Priority[] = ["urgent", "high", "medium", "low", "none"];
const IDLE: SaveFeedback = { status: "idle", message: "" };

interface WorkItemQuickControlsProps {
  nodeId: string;
  revision: number;
  status: WorkStatus;
  priority: Priority;
  blocker: string | null;
  label: string;
  checkbox?: boolean;
  minimal?: boolean;
  onSaved?: (fields: { status: WorkStatus; priority: Priority; revision: number }) => void;
}

function label(value: string) {
  return value.replaceAll("_", " ");
}

export default function WorkItemQuickControls({
  nodeId,
  revision: initialRevision,
  status: initialStatus,
  priority: initialPriority,
  blocker,
  label: itemLabel,
  checkbox = false,
  minimal = false,
  onSaved,
}: WorkItemQuickControlsProps) {
  const [revision, setRevision] = useState(initialRevision);
  const [status, setStatus] = useState(initialStatus);
  const [priority, setPriority] = useState(initialPriority);
  const [feedback, setFeedback] = useState<SaveFeedback>(IDLE);
  const saving = feedback.status === "saving";

  async function persist(nextStatus: WorkStatus, nextPriority: Priority) {
    if ((nextStatus === status && nextPriority === priority) || saving) return;
    const previousStatus = status;
    const previousPriority = priority;
    setStatus(nextStatus);
    setPriority(nextPriority);
    try {
      const nextRevision = await saveWorkItemFields(
        karazhanClient,
        {
          nodeId,
          expectedRevision: revision,
          status: nextStatus,
          priority: nextPriority,
          blocker: blocker ?? "",
        },
        setFeedback,
      );
      setRevision(nextRevision);
      onSaved?.({ status: nextStatus, priority: nextPriority, revision: nextRevision });
    } catch {
      setStatus(previousStatus);
      setPriority(previousPriority);
    }
  }

  return (
    <span className="quick-controls">
      {checkbox && (
        <input
          type="checkbox"
          checked={status === "done"}
          disabled={saving}
          aria-label={`Mark ${itemLabel} ${status === "done" ? "ready" : "done"}`}
          onChange={(event) => void persist(event.target.checked ? "done" : "ready", priority)}
        />
      )}
      {!minimal && <label className="quick-select status">
        <span className="visually-hidden">Status of {itemLabel}</span>
        <select
          className={`quick-status ${status}`}
          value={status}
          disabled={saving}
          aria-label={`Status of ${itemLabel}`}
          onChange={(event) => void persist(event.target.value as WorkStatus, priority)}
        >
          {STATUS_OPTIONS.map((option) => <option value={option} key={option}>{label(option)}</option>)}
        </select>
      </label>}
      {!minimal && <label className="quick-select priority">
        <span className="visually-hidden">Priority of {itemLabel}</span>
        <select
          className={`quick-priority ${priority}`}
          value={priority}
          disabled={saving}
          aria-label={`Priority of ${itemLabel}`}
          onChange={(event) => void persist(status, event.target.value as Priority)}
        >
          {PRIORITY_OPTIONS.map((option) => <option value={option} key={option}>{label(option)}</option>)}
        </select>
      </label>}
      {(feedback.status === "conflict" || feedback.status === "error") && (
        <span className="compact-save-error" role="alert">{feedback.message}</span>
      )}
    </span>
  );
}
