"use client";

/** Tables' Convert tab: CSV ⇄ JSON, and any delimited table to a Markdown table (once a tab of its own). */
import CsvTool from "./CsvTool";
import TsvMarkdown from "./TsvMarkdown";

export default function CsvConvertTab() {
  return (
    <div className="space-y-6">
      <CsvTool />
      <TsvMarkdown />
    </div>
  );
}
