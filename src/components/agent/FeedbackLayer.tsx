"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getFeedback, getServerFeedback, subscribeFeedback, watchOutputs } from "@/lib/agent-client/feedback";
import "./agent-feedback.css";

/** Page-level cues: page-switch progress bar, toast, and the "AI is here" badge. */
export function FeedbackLayer() {
  const fb = useSyncExternalStore(subscribeFeedback, getFeedback, getServerFeedback);

  useEffect(() => {
    watchOutputs(fb.active);
    return () => watchOutputs(false);
  }, [fb.active]);

  return (
    <div data-agent-feedback="" aria-hidden={fb.toast ? undefined : true}>
      {fb.navigating ? <div data-agent-progress="" /> : null}
      {fb.toast ? (
        <div key={fb.toast.id} role="status" data-agent-toast={fb.toast.text}>
          {fb.toast.text}
        </div>
      ) : null}
      {fb.here ? (
        <div key={fb.here.id} data-agent-here={fb.here.label} style={{ left: fb.here.x, top: fb.here.y }}>
          AI · {fb.here.label}
        </div>
      ) : null}
    </div>
  );
}
