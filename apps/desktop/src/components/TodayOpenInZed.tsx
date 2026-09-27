import { useState } from "react";

import { describeClientError } from "../features/today.ts";
import { karazhanClient } from "../lib/karazhan-client.ts";

interface TodayOpenInZedProps {
  nodeId: string;
}

export default function TodayOpenInZed({ nodeId }: TodayOpenInZedProps) {
  const [state, setState] = useState<{
    status: "idle" | "opening" | "error";
    message: string;
  }>({ status: "idle", message: "" });

  async function open() {
    setState({ status: "opening", message: "" });
    try {
      await karazhanClient.openInZed(nodeId);
      setState({ status: "idle", message: "" });
    } catch (error) {
      setState({ status: "error", message: describeClientError(error) });
    }
  }

  return (
    <span className="today-zed-wrap">
      <button
        className="today-zed"
        type="button"
        disabled={state.status === "opening"}
        onClick={() => void open()}
      >
        {state.status === "opening" ? "Opening…" : "Open in Zed"}
      </button>
      {state.status === "error" && (
        <span className="today-zed-error" role="alert">{state.message}</span>
      )}
    </span>
  );
}
