# Smart Knife — 200-tool roadmap

This is a candidate backlog, not a promise to ship every item. Keep Smart Knife
private, local-first, and hand-made: a tool earns a place when it solves a real
repeat task cleanly, not because the count looks impressive.

## Product rules

- Prefer browser APIs and local processing. A file is not uploaded by default.
- Use the Python lane only when a real format library is needed; keep it
  one-shot, bounded, and covered by the existing JSON request/response contract.
- Any network-backed operation must be an explicit user action with the target
  and data disclosure visible before sending. No silent URL fetching.
- Give each tool a stable slug, a clear family, useful search synonyms, a sample
  or empty state, validation/errors, and copy/download where it makes sense.
- Set size/time bounds for large inputs; explain when a tool is approximate.
- Build shared primitives and domain helpers before adding near-duplicate tools.

## Catalog shape and scale gates

- `category` stays a small top-level aisle; `family` is the finer discovery
  facet. Search, family, favorites, and recents should compose rather than
  becoming hundreds of permanent filter chips.
- Keep `TOOLS` as metadata-only source of truth. Tool implementations remain
  route-level components; never put business logic in the registry.
- Before the component count grows past roughly 40–50, measure production route
  bundles. The current explicit component map statically imports every tool;
  adopt route-level dynamic imports only if bundle measurements show the cost.
- Before adding batch tools, build a shared bounded queue with per-file errors,
  cancellation, and visible progress; don't copy ad-hoc loops into each tool.
- Before adding 100+ tools, measure search latency and launcher render cost with
  a representative generated registry. Linear metadata search is preferable
  until measurement shows it is the bottleneck.
- Review the roadmap after each 20 shipped tools. Re-score by frequency,
  offline feasibility, reuse, and verification cost; drop stale ideas.

## Candidate backlog

### 1. Image inspection and processing

001. ICC color-profile inspector
002. EXIF/IPTC metadata inspector
003. Privacy metadata scrubber — shipped (`image-scrub`; canvas re-encode)
004. Transparent-margin trimmer — shipped (`transparent-trim`; alpha scan)
005. Manual crop and aspect-ratio preview — shipped (`image-crop`)
006. Contact-sheet generator — shipped (`contact-sheet`; 20-image bound)
007. Animated-image frame viewer
008. Alpha-channel inspector — shipped (`alpha-inspector`; 20 MP bound)
009. Perceptual image comparator — shipped (`image-compare`; pixel metrics, not SSIM)
010. Responsive image-set builder — shipped (`responsive-images`; WebP variants)

### 2. SVG, icons, and vector work

011. SVG sanitizer and previewer — shipped (`svg-sanitize`; allowlist)
012. SVG optimizer — shipped (`svg-optimize`; metadata/comments only)
013. SVG path inspector — shipped (`svg-paths`; command counts)
014. SVG-to-PNG exporter — shipped (`svg-to-png`; sanitized input)
015. Icon-font glyph sheet builder
016. Favicon and app-icon packager — shipped (`favicon-packager`; PNG sizes)
017. SVG symbol-sprite packager — shipped (`svg-symbol-sprite`)
018. Lottie JSON inspector — shipped (`lottie-inspector`; timing/assets, no renderer)
019. Vector viewBox and dimension fixer — shipped (`svg-viewbox`; add missing viewBox)
020. SVG path-morph previewer

### 3. Advanced PDF operations

021. PDF form-field inspector
022. Fillable PDF form writer
023. Visual page reorderer
024. PDF bookmarks editor
025. Page-label and numbering tool
026. Bates-number stamper
027. Embedded-attachment inspector and extractor
028. PDF metadata scrubber
029. Page-by-page PDF comparator
030. Visual-region redaction tool

### 4. Office documents

031. DOCX structure inspector
032. DOCX-to-Markdown converter
033. Markdown-to-DOCX exporter
034. XLSX workbook and sheet inspector
035. Spreadsheet formula/dependency analyzer
036. Multi-workbook sheet comparator
037. PPTX speaker-note extractor
038. PPTX slide-text browser
039. ODT text and metadata extractor
040. RTF cleanup and conversion tool

### 5. Text and writing

041. Unicode grapheme and emoji-sequence inspector — shipped in Character Inspector
042. Invisible-character detector — consolidated into Character Inspector
043. Whitespace visualizer — consolidated into Character Inspector
044. Line-wrap and column-width previewer — shipped (`line-wrap`)
045. Smart-quote and dash normalizer — shipped (`smart-quotes`)
046. Text-encoding confidence detector — shipped (`encoding-detect`; BOM/UTF validity, not probabilistic)
047. Word-frequency analyzer — shipped (`word-frequency`)
048. Reading-grade estimator — shipped (`reading-grade`; English heuristic)
049. Punctuation-spacing checker — shipped (`punctuation-check`; heuristic)
050. Lorem Ipsum and placeholder-data generator — shipped as Placeholder Text

### 6. Structured data and markup

051. JSON Schema validator — shipped (Draft 2020-12 validation)
052. JSONPath explorer — shipped (`jsonpath`; core path/index/wildcard subset)
053. JSON Pointer navigator — shipped (RFC 6901)
054. YAML parser and formatter
055. TOML parser and formatter
056. XML formatter and XPath explorer — shipped (`xml-xpath`; XPath 1.0)
057. INI editor and validator — shipped (`ini`; practical INI subset)
058. NDJSON stream validator — shipped (`ndjson`)
059. SQL formatter — shipped (`sql-format`; common clauses, not dialect-aware)
060. SQL schema parser

### 7. Tables and spreadsheets

061. Delimiter auto-detector — shipped (`delimiter-detect`)
062. Column profiler and type suggester — shipped (`csv-profile`; heuristic types)
063. Duplicate-row finder — shipped (`duplicate-rows`)
064. Column selector and reorderer — shipped (`csv-select-columns`)
065. Pivot-table previewer — shipped (`csv-pivot`)
066. Multi-file CSV merger — shipped (`csv-merge`; matching header required)
067. Large-CSV chunker
068. Fixed-width table parser — shipped (`fixed-width`)
069. TSV-to-Markdown table exporter — shipped (`tsv-markdown`)
070. Cell-by-cell spreadsheet comparator — shipped (`table-compare`)

### 8. Developer data and diagnostics

071. Cron schedule explorer — shipped
072. UUIDv7 generator
073. ULID generator
074. Snowflake ID decoder — shipped (`snowflake-decode`; configurable epoch/bit widths)
075. Semantic-version range checker — shipped (`semver`; common ranges, not full npm syntax)
076. npm lockfile analyzer — shipped (`npm-lockfile`; package-lock v2/v3)
077. Source-map stack-trace mapper
078. Stack-trace formatter — shipped (`stacktrace`; common JS/Python frame formats)
079. ANSI escape-sequence stripper — shipped (`ansi-strip`)
080. Binary and hex file viewer — shipped (`hex-viewer`; 1 MiB bound)

### 9. Web and HTTP helpers

081. Pasted HTTP-header inspector — shipped (`http-headers`)
082. Content-Security-Policy builder — shipped (`csp-builder`)
083. robots.txt evaluator — shipped (`robots-txt`; common group/wildcard rules)
084. Sitemap XML analyzer — shipped (`sitemap-xml`; pasted XML only)
085. User-Agent parser
086. Open Graph previewer (explicit remote fetch)
087. Punycode and IDN inspector — shipped (`idn-inspector`)
088. MIME multipart-body decoder — shipped (`multipart-decoder`; text parts only)
089. cURL command builder (build only; never execute) — shipped (`curl-builder`)
090. Redirect-chain analyzer (explicit remote fetch)

### 10. Front-end design helpers

091. CSS `clamp()` previewer — shipped (`css-clamp`)
092. CSS easing-curve editor — shipped (`css-easing`)
093. CSS Grid playground — shipped (`css-grid`)
094. Box-shadow builder — shipped (`box-shadow`)
095. Border-radius builder — shipped (`border-radius`)
096. CSS custom-property resolver — shipped (`css-var-resolver`; nested var() subset)
097. Design-token validator — shipped (`design-tokens`; custom-property subset)
098. Responsive type-scale previewer — shipped (`type-scale`; modular scale)
099. `object-fit` crop playground
100. Font-pairing specimen sheet

### 11. Time and calendar

101. Duration arithmetic tool — shipped (`duration-math`)
102. Custom date-format tester — shipped (`date-format`; common tokens)
103. ISO week and week-year calculator — shipped (`iso-week`)
104. Daylight-saving transition explorer — shipped (`dst-explorer`; browser timezone data)
105. Workday calculator — shipped (`workday-calculator`; supplied holidays only)
106. Recurrence-rule parser and previewer — shipped (`rrule-preview`; documented subset)
107. Time-zone meeting planner — shipped (`meeting-timezones`; UTC instant conversion)
108. Business-hour overlap calculator — shipped (`business-overlap`; same-day hours)
109. Date-range distribution tool — shipped (`date-distribution`; ≤10 years)
110. Leap-second table and converter

### 12. Units and science

111. Length converter
112. Mass converter
113. Temperature converter
114. Area converter
115. Volume converter
116. Speed converter
117. Pressure converter
118. Energy and power converter
119. Storage and bitrate converter
120. Concentration and density converter

### 13. Personal finance calculators

121. Compound-interest planner
122. Loan amortization schedule
123. Loan-scenario comparator
124. Savings-goal planner
125. ROI and annualized-return calculator
126. Margin and markup calculator
127. Configurable VAT calculator
128. Tip and bill splitter
129. Budget-envelope allocator
130. Manual-rate currency cross-calculator

### 14. Security and privacy

131. In-memory TOTP authenticator
132. HMAC signer and verifier
133. PEM certificate inspector
134. SSH public-key fingerprint calculator
135. TLS certificate-expiry inspector (explicit network action)
136. Local pasted-text secret scanner
137. PII redaction previewer
138. Password-policy evaluator
139. Certificate-chain viewer for pasted PEM
140. OpenPGP key metadata inspector

### 15. Audio

141. Audio metadata inspector
142. Clip-marker and trim planner
143. Audio channel splitter
144. Waveform visualizer
145. Silence-segment locator
146. Integrated-loudness analyzer
147. Normalization previewer
148. Fade-envelope editor
149. Sample-rate conversion planner
150. Audio cue-sheet generator

### 16. Video

151. Container and codec inspector
152. Video-frame contact sheet
153. Clip trimmer
154. Audio-track extractor
155. Rotation and transcode assistant
156. Subtitle-offset synchronizer
157. Subtitle-format converter
158. Frame-rate converter
159. Crop and aspect-preset previewer
160. Video-size and bitrate calculator

### 17. Scanning and OCR

161. Perspective corrector
162. Document-edge detector
163. Scan deskew previewer
164. Adaptive-threshold builder
165. OCR-to-text tool
166. Searchable-PDF builder
167. Scan page-boundary segmenter
168. Receipt and table OCR extractor
169. Batch barcode/QR scanner
170. OCR correction queue

### 18. Files and archives

171. ZIP archive browser
172. ZIP creator and extractor
173. Batch-rename previewer — shipped (`batch-rename`; preview only)
174. Filename normalizer — shipped (`filename-normalizer`; preview only)
175. Content-hash duplicate finder
176. Folder-tree-to-Markdown exporter
177. Directory checksum manifest builder
178. File-manifest comparator — shipped (`file-manifest-diff`; pasted path/hash manifests)
179. Safe file-set partitioner
180. Archive integrity checker

### 19. Accessibility and document quality

181. Heading-hierarchy auditor — shipped (`heading-audit`)
182. Alt-text review checklist
183. Accessible link-text finder — shipped (`link-text-audit`)
184. HTML form-label auditor — shipped (`form-label-audit`)
185. Keyboard-focus-order inspector
186. Color-vision previewer
187. Typographic readability checker
188. Sentence-complexity analyzer — shipped (`sentence-complexity`)
189. Screen-reader landmark checker — shipped (`landmark-audit`)
190. Tagged-PDF structure inspector

### 20. Diagrams and repeatable workflows

191. Mermaid graph editor and previewer
192. Sequence-diagram builder
193. ERD generator from SQL schema
194. OpenAPI route-map viewer
195. JSON-structure diagrammer — shipped (`json-diagram`; bounded tree)
196. Multi-step text-pipeline composer
197. Image-batch conversion queue
198. Reusable PDF job-recipe builder
199. Clipboard-template composer
200. Bounded local file-task queue with cancel/progress

## Delivery order

1. **Foundation (shipped):** families, personal navigation, shared controls,
   and the candidate roadmap.
2. **Browser-native essentials (74 shipped; catalog at 100):** text analysis,
   JSONPath/INI/NDJSON, CSV profiling/transforms, developer diagnostics,
   web-policy helpers, semantic versions, CSS builders, image/SVG processing,
   and accessibility audits. Production route measurement at 46 tools: shared
   static chunks 2.1 MB; tool server output 2.9 MB (up from 1.7 MB at 26).
   A generated-catalog benchmark at 100 tools measured 0.097 ms median search,
   9.3 ms representative card rendering, and 0.12 ms facet counts; at 1,000,
   1.15 ms, 70 ms, and 0.63 ms. The live 86-card launcher loaded in 210 ms DCL
   with 786 KB script transfer. At the 100-tool gate, linear registry search is
   adequate; keep measuring before much larger catalog growth.
3. **Next:** review actual use and proceed with local document/media workflows;
   defer heavy batch pipelines until their memory, cancellation, and backend
   requirements are met. A 100 count is a milestone, not a reason to add filler.
4. **Local document workflows (next 30–50):** only after library and memory
   bounds are measured; reuse the Python request contract and shared batch queue.
5. **Media/OCR (next 50–100):** identify a local processing backend first, then
   prove cancellation, resource limits, and no implicit uploads before adding UI.
6. **Specialist tools (100–200):** build from observed use, reuse shared domain
   primitives, and retire low-value candidates during each 20-tool review.

## Reference scan (2026-10)

External catalogs are idea sources, not a feature checklist. The useful patterns
were: quick-search-first discovery and explicit offline/privacy messaging
([LocallyTools](https://locallytools.com/)); grouping by repeat jobs rather than
one giant alphabetic list ([DevToolCore](https://www.devtoolcore.com/)); and
high-frequency developer conversions plus inspectors such as JSON tree/JSONPath,
schema, SQL, placeholder-data, and markup converters
([W3Schools Tools](https://www.w3schools.com/tools/index.php)). These map to the
existing families, privacy rules, and candidates above. Prefer deep workflows
such as validation, tree navigation, batch progress, and clear local/network
boundaries over shallow one-button duplicates.
