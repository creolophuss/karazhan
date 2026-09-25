import type { FormEvent } from "react";

import type { WorkStatus } from "../lib/karazhan-client.ts";

export interface AddStepTarget {
  id: string;
  title: string;
  revision: number;
}

interface AddStepModalProps {
  target: AddStepTarget;
  onCancel: () => void;
  onSubmit: (summary: string, status: WorkStatus) => void;
}

export default function AddStepModal({ target, onCancel, onSubmit }: AddStepModalProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const summary = String(form.get("step-summary") ?? "").trim();
    if (!summary) return;
    onSubmit(summary, String(form.get("step-status") ?? "ready") as WorkStatus);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal-card" onSubmit={submit}>
        <h2>Add step</h2>
        <p>{target.title}</p>
        <label>Step<textarea name="step-summary" rows={3} autoFocus required /></label>
        <label>Status<select name="step-status" defaultValue="ready"><option value="planned">Planned</option><option value="ready">Ready</option><option value="in_progress">In progress</option><option value="pending">Pending</option><option value="review">Review</option><option value="done">Done</option><option value="cancelled">Cancelled</option></select></label>
        <div className="modal-actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary-action" type="submit">Add step</button></div>
      </form>
    </div>
  );
}
