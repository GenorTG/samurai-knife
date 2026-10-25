"use client";

/** Dates' Meeting planner tab: one instant in many zones, and the working hours two zones share (once a tab of its own). */
import BusinessOverlap from "./BusinessOverlap";
import MeetingTimezones from "./MeetingTimezones";

export default function MeetingPlannerTab() {
  return (
    <div className="space-y-6">
      <MeetingTimezones />
      <BusinessOverlap />
    </div>
  );
}
