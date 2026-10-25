"use client";

/** Dates' Date format tab: the format tester and the ISO week of a date (once a tab of its own). */
import DateFormatTester from "./DateFormatTester";
import IsoWeekCalculator from "./IsoWeekCalculator";

export default function DateFormatTab() {
  return (
    <div className="space-y-6">
      <DateFormatTester />
      <IsoWeekCalculator />
    </div>
  );
}
