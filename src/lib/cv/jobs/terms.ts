/**
 * Term dictionary + text folding for deterministic matching. Pure; relative imports only.
 *
 * Alias syntax (matched on diacritic-folded text, word-bounded):
 * - plain alias            case-insensitive            "postgres"
 * - "=Alias"               case-SENSITIVE (ambiguous)  "=Go", "=AI"
 * - trailing "*" on a word prefix match of that word   "uczeni* maszynow*" (Polish inflection)
 * - words separated by space also match across hyphens ("machine-learning")
 */

/** Polish case endings seen on Latin-script tech names: Dockerze, Pythonie, Reactem, SQLu, Dockerów. */
const PL_SUFFIX = "(?:ami|ach|iem|owi|ie|ze|em|om|ow|[aueyoi])?";
const WORD_CHAR = "[\\p{L}\\p{N}_]";

/** Strip diacritics (ł, ó, ą ...) keeping case and, for precomposed text, length. */
export function foldCase(text: string): string {
  return text.replace(/ł/g, "l").replace(/Ł/g, "L").normalize("NFD").replace(/\p{Mn}/gu, "");
}

/** Canonical label -> aliases (see the alias syntax above). Order is display order only. */
export const TECH: Readonly<Record<string, readonly string[]>> = {
  "Python": ["python"],
  "JavaScript": ["javascript", "js", "ecmascript", "es6"],
  "TypeScript": ["typescript", "ts"],
  "Java": ["java"],
  "Kotlin": ["kotlin"],
  "Swift": ["=Swift"],
  "Go": ["=Go", "golang"],
  "Rust": ["=Rust"],
  "C++": ["c++"], // not "cpp": it is the extension of llama.cpp / whisper.cpp
  "C#": ["c#", "csharp"],
  ".NET": [".net", "dotnet", "asp.net"],
  "PHP": ["php"],
  "Ruby": ["ruby"],
  "Scala": ["scala"],
  "Dart": ["=Dart"],
  "SQL": ["sql"],
  "Bash": ["bash", "shell scripting"],
  "React": ["react", "reactjs", "react.js"],
  "React Native": ["react native"],
  "Next.js": ["next.js", "nextjs"],
  "Vue": ["vue", "vuejs", "vue.js"],
  "Angular": ["angular", "angularjs"],
  "Svelte": ["svelte", "sveltekit"],
  "HTML": ["html", "html5"],
  "CSS": ["css", "css3"],
  "Sass": ["sass", "scss"],
  "Tailwind": ["tailwind", "tailwindcss"],
  "Redux": ["redux"],
  "Node.js": ["node", "nodejs", "node.js"],
  "Express": ["=Express", "express.js", "expressjs"],
  "NestJS": ["nestjs", "nest.js"],
  "Django": ["django"],
  "Flask": ["flask"],
  "FastAPI": ["fastapi"],
  "Spring": ["=Spring", "spring boot", "springboot"],
  "Laravel": ["laravel"],
  "Rails": ["ruby on rails", "=Rails"],
  "GraphQL": ["graphql"],
  "gRPC": ["grpc"],
  "REST": ["=REST", "restful", "rest api", "rest-api", "restful api"],
  "WebSocket": ["websocket*", "web socket*"],
  "OAuth": ["oauth", "oauth2", "openid connect"],
  "JWT": ["jwt"],
  "Microservices": ["microservice*", "mikroserwis*", "micro-services"],
  "Android": ["android"],
  "iOS": ["=iOS"],
  "Flutter": ["flutter"],
  "PostgreSQL": ["postgresql", "postgres", "psql"],
  "MySQL": ["mysql"],
  "MariaDB": ["mariadb"],
  "SQL Server": ["sql server", "mssql", "ms sql"],
  "Oracle": ["=Oracle"],
  "SQLite": ["sqlite"],
  "MongoDB": ["mongodb", "mongo"],
  "Redis": ["redis"],
  "Elasticsearch": ["elasticsearch", "elastic search", "opensearch"],
  "Kafka": ["kafka"],
  "RabbitMQ": ["rabbitmq"],
  "Snowflake": ["=Snowflake"],
  "BigQuery": ["bigquery"],
  "Spark": ["=Spark", "apache spark", "pyspark"],
  "Airflow": ["airflow"],
  "dbt": ["=dbt"],
  "Pandas": ["pandas"],
  "NumPy": ["numpy"],
  "ETL": ["etl", "elt"],
  "Power BI": ["power bi", "powerbi"],
  "Tableau": ["tableau"],
  "Data Science": ["data science"],
  "Data Engineering": ["data engineering", "inzynieri* danych"],
  "Docker": ["docker", "dockerfile", "docker compose", "docker-compose"],
  "Kubernetes": ["kubernetes", "k8s"],
  "Helm": ["=Helm"],
  "Terraform": ["terraform"],
  "Ansible": ["ansible"],
  "CI/CD": ["ci/cd", "cicd", "ci-cd", "ci cd", "continuous integration", "continuous delivery", "continuous deployment"],
  "Jenkins": ["jenkins"],
  "GitHub Actions": ["github actions"],
  "GitLab CI": ["gitlab ci", "gitlab-ci"],
  "Git": ["git"],
  "GitHub": ["github"],
  "GitLab": ["gitlab"],
  "Linux": ["linux", "unix"],
  "AWS": ["aws", "amazon web services"],
  "Azure": ["azure"],
  "GCP": ["gcp", "google cloud", "google cloud platform"],
  "Nginx": ["nginx"],
  "Prometheus": ["prometheus"],
  "Grafana": ["grafana"],
  "DevOps": ["devops"],
  "Cybersecurity": ["cybersecurity", "cyber security", "cyberbezpieczenstw*"],
  "OWASP": ["owasp"],
  "Machine Learning": ["machine learning", "=ML", "uczeni* maszynow*"],
  "Deep Learning": ["deep learning", "uczeni* glebok*"],
  "AI": ["=AI", "artificial intelligence", "sztuczn* inteligencj*"],
  "LLM": ["llm", "llms", "large language model*", "duz* model* jezykow*"],
  "RAG": ["=RAG", "retrieval augmented generation", "retrieval-augmented generation"],
  "NLP": ["nlp", "natural language processing", "przetwarzani* jezyka naturalnego"],
  "Computer Vision": ["computer vision", "widzeni* komputerow*"],
  "PyTorch": ["pytorch"],
  "TensorFlow": ["tensorflow"],
  "scikit-learn": ["scikit-learn", "sklearn", "scikit learn"],
  "Hugging Face": ["hugging face", "huggingface"],
  "LangChain": ["langchain"],
  "OpenAI": ["openai"],
  "Prompt Engineering": ["prompt engineering"],
  "MLOps": ["mlops"],
  "Agile": ["agile", "zwinn*"],
  "Scrum": ["scrum"],
  "Kanban": ["kanban"],
  "TDD": ["=TDD", "test-driven", "test driven development"],
  "Unit Testing": ["unit test*", "testy jednostkow*", "testow* jednostkow*"],
  "Pytest": ["pytest"],
  "Jest": ["=Jest"],
  "Selenium": ["selenium"],
  "Cypress": ["cypress"],
  "Playwright": ["playwright"],
  "Code Review": ["code review*", "przeglad* kodu"],
  "OOP": ["=OOP", "object-oriented", "object oriented", "programowani* obiektow*"],
  "Design Patterns": ["design patterns", "wzorc* projektow*"],
  "SOLID": ["=SOLID"],
  "Jira": ["jira"],
  "Confluence": ["confluence"],
  "Figma": ["figma"],
  "SAP": ["=SAP"],
  "Salesforce": ["salesforce"],
  "Unity": ["=Unity"],
  "Godot": ["godot"],
  "Blockchain": ["blockchain"],
  "Solidity": ["solidity"],
};

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasRegex(alias: string, pl: boolean): string {
  const parts = alias.split(/\s+/).filter(Boolean).map((word, i, all) => {
    const wildcard = word.endsWith("*");
    let body = escapeRegex(foldCase(word.replace(/\*+$/, "")));
    if (wildcard) body += `${WORD_CHAR}*`;
    else if (pl && i === all.length - 1 && word.length >= 3 && /\p{L}$/u.test(word)) body += PL_SUFFIX;
    return body;
  });
  return parts.join("[\\s\\-]+");
}

export interface TechPatterns {
  /** Matches against the folded + lowercased text. */
  ci: RegExp | null;
  /** Matches against the folded text with case kept (ambiguous aliases such as Go, REST, AI). */
  cs: RegExp | null;
}

const patternCache = new Map<string, TechPatterns>();

/** Compiled (global) patterns for one dictionary entry; use `spansOf` / `hasMatch` so lastIndex never leaks. */
export function techPatterns(label: string, pl: boolean): TechPatterns {
  const cacheKey = `${pl ? "pl" : "en"}|${label}`;
  const cached = patternCache.get(cacheKey);
  if (cached) return cached;
  const aliases = TECH[label];
  if (!aliases) throw new Error(`unknown tech term '${label}'`);
  const ci: string[] = [];
  const cs: string[] = [];
  for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
    if (alias.startsWith("=")) cs.push(aliasRegex(alias.slice(1), pl));
    else ci.push(aliasRegex(alias, pl));
  }
  const build = (parts: string[], flags: string): RegExp | null =>
    parts.length ? new RegExp(`(?<!${WORD_CHAR})(?:${parts.join("|")})(?!${WORD_CHAR})`, flags) : null;
  const made = { ci: build(ci, "giu"), cs: build(cs, "gu") };
  patternCache.set(cacheKey, made);
  return made;
}

export function hasMatch(re: RegExp | null, text: string): boolean {
  if (!re) return false;
  re.lastIndex = 0;
  const found = re.test(text);
  re.lastIndex = 0;
  return found;
}

/** [start, end) spans of every match. */
export function spansOf(re: RegExp | null, text: string): [number, number][] {
  if (!re) return [];
  re.lastIndex = 0;
  return [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
}

// --- non-tech keywords ----------------------------------------------------------------------

const wordSet = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

/**
 * Words that appear in nearly every posting AND every CV: matching them says nothing.
 * Exact (folded) words; Polish roots in STOP_PREFIXES because inflection is open-ended.
 */
const STOP_WORDS = wordSet(
  "ability able about above across after again against also among another anyone anything application apply around bardzo because bedzie bedziesz before behind being below " +
    "benefit benefits between beyond business candidate candidates client clients company could customer customers daily develop developer developers developing development " +
    "dobra dobre doing during each either employer employment engineer engineering engineers ensure environment equal every everyone experience experienced from further " +
    "global good great have having hybrid include includes including jestesmy join knowledge ktora ktore ktory ktorych które leading location looking must naszego naszej " +
    "naszych naszym need needs neither nice oferujemy offer offering offers office opportunities opportunity oraz other passion passionate people plus position " +
    "poszukujemy preferred product products project projects related relevant remote require required requirements requires responsibilities responsibility responsible " +
    "role roles rowniez salary seeking service services should skill skills software solution solutions someone something strong strongly szukamy takze team teams " +
    "technical technologies technology their there these those through under until used uses using well where whether which while widziane will within without " +
    "work worked working works world would wymagamy year years your yours",
);
const STOP_PREFIXES = [
  "doswiadcz", "umiejetn", "znajomos", "wymaga", "oferuj", "oferta", "ofert", "praca", "pracy", "prace", "pracow", "firm", "zespol",
  "kandydat", "stanowisk", "mozliwos", "rozwoj", "projekt", "oprogramowan", "programist", "wiedza", "wiedz", "obowiaz", "odpowiedzial",
];

const STOP_FOLDED: ReadonlySet<string> = new Set([...STOP_WORDS].map((w) => foldCase(w).toLowerCase()));

/** `word` must be folded + lowercase. */
export function isStop(word: string): boolean {
  return STOP_FOLDED.has(word) || STOP_PREFIXES.some((p) => word.startsWith(p));
}

/**
 * Polish-inflection-tolerant prefix of a folded word: drop up to 3 endings, never fewer than 5 or more than 6 chars, so
 * "prowadzeniu" and "prowadzilem" share the stem "prowad" (a longer prefix would split a word family at its suffix).
 */
export function stem(word: string): string {
  return word.slice(0, Math.min(6, Math.max(5, word.length - 3)));
}
