import { useState, type FormEvent } from "react";

import {
  saveWorkItemFields,
  type SaveFeedback,
} from "../features/today.ts";
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
const PRIORITY_OPTIONS: Priority[] = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
];

interface InlineWorkItemFieldsProps {
  nodeId: string;
  revision: number;
  status: WorkStatus;
  priority: Priority;
  blocker: string | null;
  title?: string;
  summary?: string | null;
  goal?: string | null;
  acceptance?: string | null;
  onSaved?: (fields: {
    title?: string;
    summary?: string | null;
    goal?: string | null;
    acceptance?: string | null;
    status: WorkStatus;
    priority: Priority;
    blocker: string | null;
    revision: number;
  }) => void;
}

const IDLE: SaveFeedback = { status: "idle", message: "" };

function label(value: string): string {
  return value.replaceAll("_", " ");
}

export default function InlineWorkItemFields({
  nodeId,
  revision,
  status: initialStatus,
  priority: initialPriority,
  blocker: initialBlocker,
  title: initialTitle,
  summary: initialSummary,
  goal: initialGoal,
  acceptance: initialAcceptance,
  onSaved,
}: InlineWorkItemFieldsProps) {
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [status, setStatus] = useState(initialStatus);
  const [priority, setPriority] = useState(initialPriority);
  const [blocker, setBlocker] = useState(initialBlocker ?? "");
  const [title, setTitle] = useState(initialTitle ?? "");
  const [summary, setSummary] = useState(initialSummary ?? "");
  const [goal, setGoal] = useState(initialGoal ?? "");
  const [acceptance, setAcceptance] = useState(initialAcceptance ?? "");
  const [feedback, setFeedback] = useState<SaveFeedback>(IDLE);
  const saving = feedback.status === "saving";
  const detailed = initialTitle !== undefined;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const nextRevision = await saveWorkItemFields(
        karazhanClient,
        {
          nodeId,
          expectedRevision: currentRevision,
          ...(detailed ? { title, summary, goal, acceptance } : {}),
          status,
          priority,
          blocker,
        },
        setFeedback,
      );
      setCurrentRevision(nextRevision);
      const savedTitle = title.trim();
      const savedBlocker = blocker.trim();
      if (detailed) setTitle(savedTitle);
      setBlocker(savedBlocker);
      onSaved?.({
        ...(detailed
          ? {
              title: savedTitle,
              summary: summary.trim().length === 0 ? null : summary,
              goal: goal.trim().length === 0 ? null : goal,
              acceptance: acceptance.trim().length === 0 ? null : acceptance,
            }
          : {}),
        status,
        priority,
        blocker: savedBlocker.length === 0 ? null : savedBlocker,
        revision: nextRevision,
      });
    } catch {
      // saveWorkItemFields has already converted the failure to visible feedback.
    }
  }

  return (
    <form className={`inline-fields${detailed ? " detailed" : ""}`} onSubmit={handleSubmit}>
      {detailed && (
        <div className="detailed-fields">
          <label className="title-field">
            <span>Title</span>
            <input
              value={title}
              disabled={saving}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            <span>Summary</span>
            <textarea
              value={summary}
              disabled={saving}
              rows={2}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <label>
            <span>Goal</span>
            <textarea
              value={goal}
              disabled={saving}
              rows={2}
              onChange={(event) => setGoal(event.target.value)}
            />
          </label>
          <label>
            <span>Acceptance</span>
            <textarea
              value={acceptance}
              disabled={saving}
              rows={2}
              onChange={(event) => setAcceptance(event.target.value)}
            />
          </label>
        </div>
      )}
      <label>
        <span>Status</span>
        <select
          value={status}
          disabled={saving}
          onChange={(event) => setStatus(event.target.value as WorkStatus)}
        >
          {STATUS_OPTIONS.map((value) => (
            <option value={value} key={value}>{label(value)}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Priority</span>
        <select
          value={priority}
          disabled={saving}
          onChange={(event) => setPriority(event.target.value as Priority)}
        >
          {PRIORITY_OPTIONS.map((value) => (
            <option value={value} key={value}>{value}</option>
          ))}
        </select>
      </label>
      <label className="blocker-field">
        <span>Blocker</span>
        <input
          value={blocker}
          disabled={saving}
          placeholder="No blocker"
          onChange={(event) => setBlocker(event.target.value)}
        />
      </label>
      <button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
      {feedback.status !== "idle" && (
        <span
          className={`save-feedback ${feedback.status}`}
          role={feedback.status === "conflict" || feedback.status === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </span>
      )}
    </form>
  );
}
