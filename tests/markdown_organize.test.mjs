// Markdown organizer: re-running it on its own output must change nothing and lose nothing; nested ToC entries must
// not leak; sibling headings stay siblings.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/markdown_organize.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { organize } from "../src/lib/markdown-organize.ts";

const SAMPLE = "# Project notes\n\n### Overview\nA short summary.\n\n* First item\n+ Second item\n\n### Next steps\n1. Start\n1. Finish";

const DOCS = {
  "no heading after Contents (the walkthrough input)": "# T\n\nImportant body text.\n\n- keep me",
  "body list straight after the generated ToC": "# T\n\n- keep me\n- me too\n\ntext",
  "the default sample": SAMPLE,
  "nested ToC, 4-space entries": "# A\n## Contents\n- [A](#a)\n\n  - [B](#b)\n\n    - [C](#c)\n## B\n### C\ntext",
  "fenced code containing a fake heading": "# Doc\n\n```md\n# not a heading\n- [x](#x)\n```\n\n## Real\ntext",
  "tilde fence and indented code": "# Doc\n\n~~~\n## fake\n~~~\n\n    # indented fake\n\n## Real",
  "duplicate headings": "# Same\n## Same\n## Same\n### Same",
  CRLF: "# T\r\n\r\n## A\r\ntext\r\n\r\n* x\r\n* y\r\n",
  empty: "",
  "whitespace only": "  \n\n  ",
  "no headings": "just text\n\n* a\n* b\n\n1. one\n1. two",
  "skipped levels": "# Top\n#### Deep\n## Mid\n###### Deepest",
  "only a title": "# Only title",
  "starts with a deeper heading": "### Start\ntext\n## Next\n# Last",
  "contents with ordered entries and a body that follows": "# T\n\n## Contents\n\n1. [T](#t)\n2. [A](#a)\n\n## A\nbody\n\n- list",
  "title not first": "intro line\n\n# T\n## A",
  "two Contents sections": "# T\n## Contents\n- [T](#t)\n## A\n## Contents\n- old\n## B",
  "accented and punctuated titles": "# Zażółć gęślą jaźń!\n## What's `new`?\n## C# and F#",
  "mixed lists and numbering": "# T\n\n3. c\n1. a\n\n* x\n   1) nested\n+ y",
  "contents heading only": "## Contents",
};

for (const addToc of [true, false]) {
  for (const [name, doc] of Object.entries(DOCS)) {
    test(`idempotent (toc ${addToc ? "on" : "off"}): ${name}`, () => {
      const once = organize(doc, addToc);
      assert.equal(organize(once, addToc), once);
    });
  }
}

test("re-run keeps the body (no heading follows the Contents section)", () => {
  const once = organize(DOCS["no heading after Contents (the walkthrough input)"], true);
  assert.equal(once, "# T\n\n## Contents\n\n- [T](#t)\n\nImportant body text.\n\n- keep me\n");
  assert.equal(organize(once, true), once);
});

test("a list right after the generated ToC is body, not part of the ToC", () => {
  const once = organize(DOCS["body list straight after the generated ToC"], true);
  assert.ok(once.includes("- keep me\n- me too"), once);
  assert.equal(organize(once, true), once);
});

test("a hand-written Contents list is still replaced", () => {
  const out = organize("# T\n## Contents\n- old\n- older\n## A\n", true);
  assert.ok(!out.includes("old"), out);
  assert.equal(out, "# T\n\n## Contents\n\n- [T](#t)\n  - [A](#a)\n\n## A\n");
});

test("a ToC entry nested three levels (4-space indent) does not leak as indented code", () => {
  const out = organize(DOCS["nested ToC, 4-space entries"], true);
  assert.equal(out.split("[C](#c)").length - 1, 1, out);
  assert.equal(out.split("[B](#b)").length - 1, 1, out);
  assert.equal(out, "# A\n\n## Contents\n\n- [A](#a)\n  - [B](#b)\n    - [C](#c)\n\n## B\n\n### C\n\ntext\n");
});

test("sibling headings stay siblings", () => {
  assert.equal(organize("# A\n### X\n### Y\n", false), "# A\n\n## X\n\n## Y\n");
  const out = organize(SAMPLE, true);
  assert.ok(out.includes("\n## Overview\n") && out.includes("\n## Next steps\n"), out);
  assert.ok(out.includes("\n  - [Overview](#overview)\n  - [Next steps](#next-steps)\n"), out);
});

test("hierarchy repair is relative to the nearest shallower original ancestor", () => {
  assert.equal(organize("# Top\n#### Deep\n## Mid\n###### Deepest\n", false), "# Top\n\n## Deep\n\n## Mid\n\n### Deepest\n");
  assert.equal(organize("# A\n## B\n### C\n## D\n", false), "# A\n\n## B\n\n### C\n\n## D\n");
  assert.equal(organize("### X\n## Y\n", false), "# X\n\n# Y\n");
});

test("fenced code, duplicate slugs and CRLF keep working", () => {
  const fenced = organize(DOCS["fenced code containing a fake heading"], true);
  assert.ok(fenced.includes("# not a heading") && !fenced.includes("[not a heading]"), fenced);
  const dup = organize(DOCS["duplicate headings"], true);
  assert.ok(dup.includes("(#same)") && dup.includes("(#same-1)") && dup.includes("(#same-2)"), dup);
  assert.equal(organize("# T\r\n\r\ntext\r\n", false), "# T\n\ntext\n");
  assert.equal(organize("", true), "");
  assert.equal(organize("no headings", true), "no headings\n");
});

test("a title alone still gets its Contents after the title", () => {
  assert.equal(organize("# Only title", true), "# Only title\n\n## Contents\n\n- [Only title](#only-title)\n");
});

test("idempotent over 3000 generated documents", () => {
  const pieces = ["# T", "## A", "### B", "#### C", "## Contents", "- [T](#t)", "  - [A](#a)", "    - [B](#b)", "- item", "* item", "1. one", "3) three", "", "", "text", "```", "~~~", "    code", "\ttab", "#hash", "- [x](#x)", "Contents"];
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 3000; i += 1) {
    const length = 1 + Math.floor(random() * 10);
    const doc = Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)]).join("\n");
    for (const addToc of [true, false]) {
      const once = organize(doc, addToc);
      assert.equal(organize(once, addToc), once, JSON.stringify(doc));
    }
  }
});
