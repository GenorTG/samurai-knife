"use client";

/** Text kit's Transforms tab: the transforms, then line wrapping and smart punctuation (once tabs of their own). */
import LineWrapPreview from "./LineWrapPreview";
import SmartPunctuation from "./SmartPunctuation";
import TextKit from "./TextKit";

export default function TextTransforms() {
  return (
    <div className="space-y-6">
      <TextKit />
      <LineWrapPreview />
      <SmartPunctuation />
    </div>
  );
}
