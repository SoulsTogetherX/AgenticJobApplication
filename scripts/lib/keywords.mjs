// The one skill lexicon. Everything that asks "what technology is named here?"
// reads this file.
//
// Before this existed there were two lists that had already drifted apart:
//
//   TECH_TERMS   (lib.mjs)         flat literal strings -> techTermsIn()
//                                  -> verify-claims R6, the truthfulness gate
//   TECH_LEXICON (profile-gaps.mjs) regex + aliases     -> extractTech()
//                                  -> lead_keywords, recommend, gap analysis
//
// They disagreed in both directions: TECH_LEXICON knew Svelte, Kafka and
// Observability; TECH_TERMS knew Cognito, EventBridge and Monte Carlo. Any
// keyword feature built on top of that inherits the disagreement, so both are
// now projections of the table below.
//
// The two consumers genuinely need different things, which is why an entry
// carries two different name fields:
//
//   surface   strings watched inside the user's OWN documents. A surface form
//             must be something a resume would really write. Abstractions
//             ("Testing", "Auth") have none, and entries without one simply do
//             not participate in R6 — exactly as before.
//   aliases   what the same skill looks like in SOMEONE ELSE'S job posting,
//             matched loosely and case-insensitively. "k8s" belongs here, never
//             in surface: a posting may say it, a truthful resume would not.
//
// SURFACE MATCHING IS NO LONGER "THIS EXACT STRING" (2026-08-05). It used to
// be, and that wording survived here for a while after it stopped being true;
// two audit findings are why it changed, and both are worth knowing because
// each looks like the other's opposite:
//
//   - R6 was CASE-SENSITIVE, so a document claiming "kubernetes" and
//     "terraform" in lowercase produced zero violations and exited 0. The
//     load-bearing truthfulness gate was blind to any invention that simply
//     used the wrong case. Matching is now case-insensitive by default, and
//     CASE_SENSITIVE_SURFACE below is the deliberate exception list: terms that
//     are ordinary English words ("Go", "R", "C") still require exact case,
//     because "go to the store" is not a technology claim.
//   - R6 treated two SPELLINGS OF ONE SKILL as two different skills, so a
//     profile saying "Postgres" plus a resume saying "PostgreSQL" was a
//     violation and a blocked render — while docs/tailoring-rules.md §8
//     instructs the writer to use "PostgreSQL not Postgres". SURFACE_SPELLINGS
//     below folds such siblings to one canonical form on BOTH sides of the
//     comparison, which tightens nothing and loosens nothing.
//
// The folding uses `surface` and never `aliases`, and that distinction is the
// load-bearing half. `surface` means "the same skill, written differently by
// the same honest person". `aliases` means "how a stranger's job ad refers to
// it" — folding those in would let a posting's vocabulary vouch for a claim the
// fact base cannot back, which is the exact hole R6 exists to close.
//
// ats is the third: the form(s) to actually place in a tailored resume. ATS
// keyword matching is frequently literal, and some systems index the acronym
// while others index the expansion, so the first use should carry both.
//
// adjacent drives keyword-coverage.mjs' "you probably have this and never wrote
// it down" bucket. It is a static, hand-checked map, never a model guess, and
// it is deliberately conservative: adjacency means "someone who genuinely has
// A has very likely touched B", not "A and B appear in the same job ads".

// ---------------------------------------------------------------------------
// Groups exist so a resume's SKILLS block can be assembled in a sensible order
// rather than alphabetically.
// ---------------------------------------------------------------------------
export const GROUPS = [
  "Languages",
  "Frontend",
  "Backend",
  "Data",
  "Cloud",
  "Infra",
  "Practices",
  "AI",
  "Games",
  "Tools",
]

// prettier-ignore
export const SKILLS = [
  // --- Languages -----------------------------------------------------------
  { canonical: "TypeScript", group: "Languages", surface: ["TypeScript"], aliases: ["typescript", "ts"], ats: ["TypeScript"], adjacent: ["JavaScript", "Node.js", "React"] },
  { canonical: "JavaScript", group: "Languages", surface: ["JavaScript"], aliases: ["javascript", "es6", "ecmascript"], ats: ["JavaScript"], adjacent: ["TypeScript", "Node.js", "HTML/CSS"] },
  { canonical: "Python", group: "Languages", surface: ["Python"], aliases: ["python"], ats: ["Python"], adjacent: ["Pandas", "NumPy", "FastAPI"] },
  { canonical: "C++", group: "Languages", surface: ["C++"], aliases: ["c\\+\\+", "cpp"], ats: ["C++"], adjacent: [] },
  { canonical: "C#", group: "Languages", surface: ["C#"], aliases: ["c#", "\\.net", "dotnet"], ats: ["C#"], adjacent: [] },
  { canonical: "Java", group: "Languages", surface: ["Java"], aliases: ["java"], ats: ["Java"], adjacent: [] },
  { canonical: "Go", group: "Languages", surface: ["Golang", "Go"], aliases: ["golang"], ats: ["Go"], adjacent: [] },
  { canonical: "Rust", group: "Languages", surface: ["Rust"], aliases: ["rust"], ats: ["Rust"], adjacent: [] },
  // Not a bare "rails" — the pre-merge lexicon had that and read "do not go off
  // the rails" as Ruby experience.
  { canonical: "Ruby", group: "Languages", surface: ["Ruby"], aliases: ["ruby", "ruby on rails"], ats: ["Ruby"], adjacent: [] },
  { canonical: "PHP", group: "Languages", surface: ["PHP"], aliases: ["php", "laravel"], ats: ["PHP"], adjacent: [] },
  { canonical: "Swift", group: "Languages", surface: ["Swift"], aliases: ["swift"], ats: ["Swift"], adjacent: [] },
  { canonical: "Kotlin", group: "Languages", surface: ["Kotlin"], aliases: ["kotlin"], ats: ["Kotlin"], adjacent: [] },
  { canonical: "Scala", group: "Languages", surface: ["Scala"], aliases: ["scala"], ats: ["Scala"], adjacent: [] },
  { canonical: "GDScript", group: "Languages", surface: ["GDScript"], aliases: ["gdscript"], ats: ["GDScript"], adjacent: ["Godot"] },
  { canonical: "SQL", group: "Languages", surface: ["SQL"], aliases: ["sql"], ats: ["SQL"], adjacent: ["PostgreSQL", "MySQL"] },
  { canonical: "Bash", group: "Languages", surface: ["Bash", "Shell"], aliases: ["bash", "shell scripting", "shell script"], ats: ["Bash"], adjacent: ["Linux"] },

  // --- Frontend ------------------------------------------------------------
  { canonical: "React", group: "Frontend", surface: ["React"], aliases: ["react", "react\\.js", "reactjs"], ats: ["React"], adjacent: ["Redux", "Next.js", "JavaScript", "HTML/CSS"] },
  { canonical: "React Native", group: "Frontend", surface: ["React Native"], aliases: ["react native"], ats: ["React Native"], adjacent: ["React"] },
  { canonical: "Next.js", group: "Frontend", surface: ["Next.js"], aliases: ["next\\.js", "nextjs"], ats: ["Next.js"], adjacent: ["React", "SSR"] },
  { canonical: "Vue", group: "Frontend", surface: ["Vue"], aliases: ["vue", "vue\\.js", "vuejs", "nuxt"], ats: ["Vue"], adjacent: [] },
  { canonical: "Angular", group: "Frontend", surface: ["Angular"], aliases: ["angular"], ats: ["Angular"], adjacent: [] },
  { canonical: "Svelte", group: "Frontend", surface: ["Svelte"], aliases: ["svelte", "sveltekit"], ats: ["Svelte"], adjacent: [] },
  { canonical: "Remix", group: "Frontend", surface: ["Remix"], aliases: ["remix\\.run", "remixjs", "remix framework"], ats: ["Remix"], adjacent: ["React"] },
  { canonical: "Astro", group: "Frontend", surface: ["Astro"], aliases: ["astro"], ats: ["Astro"], adjacent: [] },
  { canonical: "Redux", group: "Frontend", surface: ["Redux"], aliases: ["redux", "zustand", "state management"], ats: ["Redux"], adjacent: ["React"] },
  // tailwind/sass/scss stay as aliases here even though each is also its own
  // entry: a posting that only names Tailwind is still CSS work, and the old
  // lexicon counted it that way. Both fire, which is the accurate answer.
  { canonical: "HTML/CSS", group: "Frontend", surface: ["HTML", "CSS"], aliases: ["html", "html5", "css", "css3", "tailwind", "tailwindcss", "sass", "scss"], ats: ["HTML", "CSS"], adjacent: ["Tailwind", "Responsive design"] },
  { canonical: "Tailwind", group: "Frontend", surface: ["Tailwind"], aliases: ["tailwind", "tailwindcss"], ats: ["Tailwind CSS"], adjacent: ["HTML/CSS"] },
  { canonical: "Sass", group: "Frontend", surface: ["Sass", "SCSS"], aliases: ["sass", "scss", "less"], ats: ["Sass"], adjacent: ["HTML/CSS"] },
  { canonical: "Bootstrap", group: "Frontend", surface: ["Bootstrap"], aliases: ["bootstrap"], ats: ["Bootstrap"], adjacent: ["HTML/CSS"] },
  { canonical: "jQuery", group: "Frontend", surface: ["jQuery"], aliases: ["jquery"], ats: ["jQuery"], adjacent: ["JavaScript"] },
  { canonical: "Responsive design", group: "Frontend", surface: [], aliases: ["responsive design", "mobile-first", "mobile first"], ats: ["Responsive design"], adjacent: ["HTML/CSS"] },
  { canonical: "Accessibility", group: "Frontend", surface: ["WCAG", "ARIA"], aliases: ["accessibility", "wcag", "a11y", "aria", "section 508"], ats: ["Accessibility (WCAG)"], adjacent: ["HTML/CSS"] },
  { canonical: "SSR", group: "Frontend", surface: ["SSR", "SSG"], aliases: ["server-side rendering", "server side rendering", "ssr", "ssg", "static site generation"], ats: ["Server-side rendering (SSR)"], adjacent: ["Next.js"] },
  { canonical: "Vite", group: "Frontend", surface: ["Vite"], aliases: ["vite"], ats: ["Vite"], adjacent: ["JavaScript"] },
  { canonical: "Webpack", group: "Frontend", surface: ["Webpack"], aliases: ["webpack", "rollup", "esbuild"], ats: ["Webpack"], adjacent: ["JavaScript"] },
  { canonical: "Babel", group: "Frontend", surface: ["Babel"], aliases: ["babel"], ats: ["Babel"], adjacent: ["JavaScript"] },
  { canonical: "Storybook", group: "Frontend", surface: ["Storybook"], aliases: ["storybook"], ats: ["Storybook"], adjacent: ["React"] },

  // --- Backend -------------------------------------------------------------
  { canonical: "Node.js", group: "Backend", surface: ["Node.js"], aliases: ["node", "node\\.js", "nodejs"], ats: ["Node.js"], adjacent: ["Express", "JavaScript", "TypeScript"] },
  // Never a bare "express" — the pre-merge lexicon had that and read "deliver
  // express service to every guest" as backend experience. Matched instead via
  // the dotted form, an explicit noun, or a neighbour in a stack list.
  { canonical: "Express", group: "Backend", surface: ["Express"], aliases: ["express\\.js", "expressjs", "express (?:framework|server|middleware|router|api)", "(?:node|nodejs|node\\.js)\\s*[/,+&]\\s*express", "express\\s*[/,+&]\\s*(?:node|mongo|react|postgres)"], ats: ["Express"], adjacent: ["Node.js", "REST APIs"] },
  { canonical: "NestJS", group: "Backend", surface: ["NestJS"], aliases: ["nestjs", "nest\\.js"], ats: ["NestJS"], adjacent: ["Node.js"] },
  { canonical: "Deno", group: "Backend", surface: ["Deno"], aliases: ["deno"], ats: ["Deno"], adjacent: ["TypeScript"] },
  // Not a bare "bun" — that reads a catered-lunch perk as a JS runtime.
  { canonical: "Bun", group: "Backend", surface: ["Bun"], aliases: ["bun\\.sh", "bunjs", "bun runtime"], ats: ["Bun"], adjacent: ["JavaScript"] },
  { canonical: "Django", group: "Backend", surface: ["Django"], aliases: ["django"], ats: ["Django"], adjacent: ["Python"] },
  { canonical: "Flask", group: "Backend", surface: ["Flask"], aliases: ["flask"], ats: ["Flask"], adjacent: ["Python"] },
  { canonical: "FastAPI", group: "Backend", surface: ["FastAPI"], aliases: ["fastapi"], ats: ["FastAPI"], adjacent: ["Python", "REST APIs"] },
  { canonical: "Spring", group: "Backend", surface: ["Spring"], aliases: ["spring boot", "spring framework"], ats: ["Spring"], adjacent: ["Java"] },
  { canonical: "Rails", group: "Backend", surface: ["Rails"], aliases: ["ruby on rails", "rails (?:app|framework|developer|engineer)"], ats: ["Rails"], adjacent: ["Ruby"] },
  { canonical: "Laravel", group: "Backend", surface: ["Laravel"], aliases: ["laravel"], ats: ["Laravel"], adjacent: ["PHP"] },
  { canonical: "REST APIs", group: "Backend", surface: ["REST", "RESTful"], aliases: ["rest api", "rest apis", "restful", "rest endpoints"], ats: ["REST APIs", "RESTful services"], adjacent: ["Node.js", "Express", "OpenAPI"] },
  { canonical: "GraphQL", group: "Backend", surface: ["GraphQL"], aliases: ["graphql", "apollo"], ats: ["GraphQL"], adjacent: ["REST APIs"] },
  { canonical: "gRPC", group: "Backend", surface: ["gRPC"], aliases: ["grpc", "protobuf", "protocol buffers"], ats: ["gRPC"], adjacent: ["Microservices"] },
  { canonical: "OpenAPI", group: "Backend", surface: ["OpenAPI", "Swagger"], aliases: ["openapi", "swagger"], ats: ["OpenAPI (Swagger)"], adjacent: ["REST APIs"] },
  { canonical: "WebSockets", group: "Backend", surface: ["WebSockets", "WebSocket"], aliases: ["websocket", "websockets", "socket\\.io", "real-time messaging"], ats: ["WebSockets"], adjacent: ["Node.js"] },
  { canonical: "Microservices", group: "Backend", surface: ["Microservices"], aliases: ["microservice", "microservices", "service-oriented"], ats: ["Microservices"], adjacent: ["Docker", "REST APIs"] },
  { canonical: "Serverless", group: "Backend", surface: ["Serverless"], aliases: ["serverless", "lambda functions"], ats: ["Serverless"], adjacent: ["AWS"] },
  { canonical: "Auth", group: "Backend", surface: ["OAuth", "OAuth2", "JWT", "SSO", "OIDC", "RBAC"], aliases: ["oauth", "oauth2", "oidc", "sso", "authentication", "authorization", "jwt", "rbac", "role-based access"], ats: ["Authentication (OAuth2, JWT)"], adjacent: ["REST APIs"] },
  { canonical: "Caching", group: "Backend", surface: [], aliases: ["caching", "cache invalidation", "cdn"], ats: ["Caching"], adjacent: ["Redis"] },
  { canonical: "nginx", group: "Backend", surface: ["nginx"], aliases: ["nginx", "reverse proxy", "load balanc"], ats: ["nginx"], adjacent: ["Linux"] },

  // --- Data ----------------------------------------------------------------
  { canonical: "PostgreSQL", group: "Data", surface: ["PostgreSQL", "Postgres"], aliases: ["postgres", "postgresql"], ats: ["PostgreSQL"], adjacent: ["SQL"] },
  { canonical: "MySQL", group: "Data", surface: ["MySQL"], aliases: ["mysql", "mariadb"], ats: ["MySQL"], adjacent: ["SQL"] },
  { canonical: "SQLite", group: "Data", surface: ["SQLite"], aliases: ["sqlite"], ats: ["SQLite"], adjacent: ["SQL"] },
  { canonical: "MongoDB", group: "Data", surface: ["MongoDB"], aliases: ["mongodb", "mongo"], ats: ["MongoDB"], adjacent: [] },
  { canonical: "Redis", group: "Data", surface: ["Redis"], aliases: ["redis", "memcached"], ats: ["Redis"], adjacent: ["Caching"] },
  { canonical: "DynamoDB", group: "Data", surface: ["DynamoDB"], aliases: ["dynamodb"], ats: ["DynamoDB"], adjacent: ["AWS"] },
  { canonical: "Elasticsearch", group: "Data", surface: ["Elasticsearch"], aliases: ["elasticsearch", "opensearch"], ats: ["Elasticsearch"], adjacent: [] },
  { canonical: "Firebase", group: "Data", surface: ["Firebase"], aliases: ["firebase", "firestore"], ats: ["Firebase"], adjacent: [] },
  { canonical: "Supabase", group: "Data", surface: ["Supabase"], aliases: ["supabase"], ats: ["Supabase"], adjacent: ["PostgreSQL"] },
  { canonical: "Prisma", group: "Data", surface: ["Prisma"], aliases: ["prisma", "drizzle", "typeorm", "sequelize"], ats: ["Prisma"], adjacent: ["TypeScript", "PostgreSQL"] },
  { canonical: "Kafka", group: "Data", surface: ["Kafka"], aliases: ["kafka"], ats: ["Kafka"], adjacent: ["Microservices"] },
  { canonical: "RabbitMQ", group: "Data", surface: ["RabbitMQ"], aliases: ["rabbitmq", "message queue", "sqs"], ats: ["RabbitMQ"], adjacent: ["Microservices"] },
  { canonical: "Spark", group: "Data", surface: ["Spark"], aliases: ["apache spark"], ats: ["Spark"], adjacent: [] },
  { canonical: "Hadoop", group: "Data", surface: ["Hadoop"], aliases: ["hadoop"], ats: ["Hadoop"], adjacent: [] },
  { canonical: "Pandas", group: "Data", surface: ["Pandas"], aliases: ["pandas"], ats: ["Pandas"], adjacent: ["Python"] },
  { canonical: "NumPy", group: "Data", surface: ["NumPy"], aliases: ["numpy"], ats: ["NumPy"], adjacent: ["Python"] },
  { canonical: "JSON", group: "Data", surface: ["JSON"], aliases: ["json", "json schema"], ats: ["JSON"], adjacent: ["REST APIs"] },
  { canonical: "Data modeling", group: "Data", surface: [], aliases: ["data model", "data modeling", "schema design", "database design"], ats: ["Data modeling"], adjacent: ["SQL", "PostgreSQL"] },

  // --- Cloud ---------------------------------------------------------------
  { canonical: "AWS", group: "Cloud", surface: ["AWS"], aliases: ["aws", "amazon web services"], ats: ["AWS"], adjacent: ["EC2", "S3", "Lambda"] },
  { canonical: "EC2", group: "Cloud", surface: ["EC2"], aliases: ["ec2"], ats: ["Amazon EC2"], adjacent: ["AWS"] },
  { canonical: "S3", group: "Cloud", surface: ["S3"], aliases: ["s3 bucket", "amazon s3"], ats: ["Amazon S3"], adjacent: ["AWS"] },
  { canonical: "Lambda", group: "Cloud", surface: ["Lambda"], aliases: ["aws lambda"], ats: ["AWS Lambda"], adjacent: ["AWS", "Serverless"] },
  { canonical: "Cognito", group: "Cloud", surface: ["Cognito"], aliases: ["cognito"], ats: ["AWS Cognito"], adjacent: ["AWS", "Auth"] },
  { canonical: "EventBridge", group: "Cloud", surface: ["EventBridge"], aliases: ["eventbridge"], ats: ["AWS EventBridge"], adjacent: ["AWS"] },
  { canonical: "GCP", group: "Cloud", surface: ["GCP"], aliases: ["gcp", "google cloud"], ats: ["Google Cloud (GCP)"], adjacent: [] },
  { canonical: "Azure", group: "Cloud", surface: ["Azure"], aliases: ["azure"], ats: ["Azure"], adjacent: [] },
  { canonical: "Heroku", group: "Cloud", surface: ["Heroku"], aliases: ["heroku"], ats: ["Heroku"], adjacent: [] },
  { canonical: "Vercel", group: "Cloud", surface: ["Vercel"], aliases: ["vercel"], ats: ["Vercel"], adjacent: ["Next.js"] },
  { canonical: "Netlify", group: "Cloud", surface: ["Netlify"], aliases: ["netlify"], ats: ["Netlify"], adjacent: [] },
  { canonical: "Cloud deployment", group: "Cloud", surface: [], aliases: ["cloud deployment", "deploy to production", "production deployment"], ats: ["Cloud deployment"], adjacent: ["AWS", "Docker"] },

  // --- Infra ---------------------------------------------------------------
  { canonical: "Docker", group: "Infra", surface: ["Docker"], aliases: ["docker", "container", "containers", "containerized", "containerised"], ats: ["Docker"], adjacent: ["Linux", "CI/CD"] },
  { canonical: "Kubernetes", group: "Infra", surface: ["Kubernetes"], aliases: ["kubernetes", "k8s", "eks", "helm"], ats: ["Kubernetes"], adjacent: ["Docker"] },
  { canonical: "Terraform", group: "Infra", surface: ["Terraform"], aliases: ["terraform", "infrastructure as code", "pulumi"], ats: ["Terraform"], adjacent: ["AWS"] },
  { canonical: "Ansible", group: "Infra", surface: ["Ansible"], aliases: ["ansible", "chef", "puppet"], ats: ["Ansible"], adjacent: ["Linux"] },
  { canonical: "Linux", group: "Infra", surface: ["Linux", "Unix"], aliases: ["linux", "unix", "ubuntu", "debian"], ats: ["Linux"], adjacent: ["Bash"] },
  { canonical: "CI/CD", group: "Infra", surface: ["CI/CD", "GitHub Actions", "Jenkins", "CircleCI"], aliases: ["ci/cd", "cicd", "continuous integration", "continuous delivery", "continuous deployment", "github actions", "jenkins", "circleci", "gitlab ci", "build pipeline", "deployment pipeline"], ats: ["CI/CD", "continuous integration and delivery", "GitHub Actions"], adjacent: ["Git", "Docker", "Testing"] },
  { canonical: "Observability", group: "Infra", surface: ["Datadog", "Grafana", "Prometheus", "Sentry"], aliases: ["observability", "monitoring", "datadog", "grafana", "prometheus", "sentry", "logging", "alerting"], ats: ["Observability and monitoring"], adjacent: ["Linux"] },
  { canonical: "Incident response", group: "Infra", surface: [], aliases: ["incident response", "on-call", "on call rotation", "postmortem", "root cause analysis"], ats: ["Incident response"], adjacent: ["Observability"] },

  // --- Practices -----------------------------------------------------------
  { canonical: "Git", group: "Practices", surface: ["Git"], aliases: ["git", "version control", "github", "gitlab", "bitbucket"], ats: ["Git", "version control"], adjacent: ["CI/CD", "Code review"] },
  { canonical: "Code review", group: "Practices", surface: [], aliases: ["code review", "pull request", "peer review", "merge request"], ats: ["Code review"], adjacent: ["Git"] },
  { canonical: "Testing", group: "Practices", surface: ["Jest", "Vitest", "Mocha", "Cypress", "Playwright", "Selenium", "Puppeteer", "pytest"], aliases: ["unit test", "unit testing", "integration test", "automated test", "test coverage", "jest", "vitest", "mocha", "pytest", "cypress", "playwright", "selenium", "puppeteer", "tdd", "test-driven"], ats: ["Automated testing", "unit testing"], adjacent: ["CI/CD", "Code review"] },
  { canonical: "Agile", group: "Practices", surface: ["Agile", "Scrum", "Kanban"], aliases: ["agile", "scrum", "kanban", "sprint", "standup", "retrospective"], ats: ["Agile/Scrum"], adjacent: ["Jira"] },
  { canonical: "System design", group: "Practices", surface: [], aliases: ["system design", "architecture design", "distributed systems", "scalable systems", "scalability"], ats: ["System design"], adjacent: ["Microservices"] },
  { canonical: "Performance", group: "Practices", surface: [], aliases: ["performance optimization", "performance tuning", "profiling", "latency reduction"], ats: ["Performance optimization"], adjacent: ["Caching"] },
  { canonical: "Security", group: "Practices", surface: [], aliases: ["secure coding", "owasp", "vulnerability", "penetration test", "security best practices"], ats: ["Secure coding"], adjacent: ["Auth"] },
  { canonical: "Documentation", group: "Practices", surface: [], aliases: ["technical documentation", "write documentation", "api documentation", "runbook"], ats: ["Technical documentation"], adjacent: ["Code review"] },
  { canonical: "Mentoring", group: "Practices", surface: [], aliases: ["mentor", "mentoring", "coaching junior", "onboarding engineers"], ats: ["Mentoring"], adjacent: ["Code review"] },
  { canonical: "i18n", group: "Practices", surface: ["i18n"], aliases: ["internationalization", "localization", "i18n", "l10n"], ats: ["Internationalization (i18n)"], adjacent: [] },

  // --- AI ------------------------------------------------------------------
  { canonical: "AI/LLM integration", group: "AI", surface: ["Claude", "ChatGPT", "Codex", "MCP", "OpenAI"], aliases: ["llm", "openai api", "anthropic api", "rag", "prompt engineering", "genai", "generative ai", "ai-powered", "ai agent", "ai agents", "agentic", "claude", "chatgpt", "copilot", "mcp"], ats: ["LLM integration", "generative AI"], adjacent: ["Python", "REST APIs"] },
  { canonical: "Machine Learning", group: "AI", surface: ["TensorFlow", "PyTorch", "Keras"], aliases: ["machine learning", "pytorch", "tensorflow", "keras", "scikit-learn", "deep learning", "neural network"], ats: ["Machine learning"], adjacent: ["Python", "NumPy"] },
  // 2026 posting analysis: deep learning is the single highest-demand AI
  // competency, and RAG / agents / MLOps / vector search now appear as named
  // requirements rather than as "nice to have AI exposure".
  { canonical: "RAG", group: "AI", surface: ["RAG"], aliases: ["retrieval[- ]augmented generation", "\\brag pipeline", "retrieval augmented"], ats: ["RAG (retrieval-augmented generation)"], adjacent: ["AI/LLM integration", "Vector databases"] },
  { canonical: "Vector databases", group: "AI", surface: ["Pinecone", "Weaviate", "pgvector"], aliases: ["vector database", "vector store", "embeddings", "pinecone", "weaviate", "pgvector", "semantic search"], ats: ["Vector databases"], adjacent: ["RAG", "PostgreSQL"] },
  { canonical: "MLOps", group: "AI", surface: ["MLOps"], aliases: ["mlops", "model deployment", "model serving", "feature store"], ats: ["MLOps"], adjacent: ["CI/CD", "Machine Learning"] },
  { canonical: "Prompt engineering", group: "AI", surface: [], aliases: ["prompt engineering", "prompt design", "few[- ]shot", "system prompt"], ats: ["Prompt engineering"], adjacent: ["AI/LLM integration"] },
  { canonical: "NLP", group: "AI", surface: ["NLP"], aliases: ["natural language processing", "\\bnlp\\b", "named entity recognition", "sentiment analysis"], ats: ["NLP (natural language processing)"], adjacent: ["Machine Learning", "Python"] },

  // --- Backend fundamentals hiring managers name explicitly ------------------
  // 2026 analysis: backend/infrastructure is the largest hiring category by
  // volume, and postings ask for evidence of concurrency, caching and
  // idempotency by name rather than inferring them from a stack list.
  { canonical: "Concurrency", group: "Backend", surface: [], aliases: ["concurrency", "concurrent programming", "multithread", "async programming", "parallelism", "race condition"], ats: ["Concurrency"], adjacent: ["System design", "Performance"] },
  { canonical: "Idempotency", group: "Backend", surface: [], aliases: ["idempoten", "exactly[- ]once", "at[- ]least[- ]once delivery", "retry logic"], ats: ["Idempotency"], adjacent: ["REST APIs", "Microservices"] },
  { canonical: "Event-driven", group: "Backend", surface: [], aliases: ["event[- ]driven", "pub/?sub", "event sourcing", "message broker", "event bus"], ats: ["Event-driven architecture"], adjacent: ["Kafka", "Microservices"] },
  { canonical: "Rate limiting", group: "Backend", surface: [], aliases: ["rate limit", "throttling", "backpressure", "circuit breaker"], ats: ["Rate limiting"], adjacent: ["REST APIs", "Caching"] },
  { canonical: "Feature flags", group: "Practices", surface: ["LaunchDarkly"], aliases: ["feature flag", "feature toggle", "launchdarkly", "canary release", "blue[- ]green deploy"], ats: ["Feature flags"], adjacent: ["CI/CD"] },
  { canonical: "Migrations", group: "Data", surface: [], aliases: ["database migration", "schema migration", "zero[- ]downtime migration", "backfill"], ats: ["Database migrations"], adjacent: ["SQL", "PostgreSQL"] },

  // --- Games / math --------------------------------------------------------
  { canonical: "Godot", group: "Games", surface: ["Godot"], aliases: ["godot"], ats: ["Godot"], adjacent: ["GDScript"] },
  { canonical: "GameMaker", group: "Games", surface: ["GameMaker"], aliases: ["gamemaker", "game maker"], ats: ["GameMaker"], adjacent: [] },
  { canonical: "Unity", group: "Games", surface: ["Unity"], aliases: ["unity3d", "unity engine"], ats: ["Unity"], adjacent: ["C#"] },
  { canonical: "Unreal", group: "Games", surface: ["Unreal"], aliases: ["unreal engine"], ats: ["Unreal Engine"], adjacent: ["C++"] },
  { canonical: "Flutter", group: "Games", surface: ["Flutter"], aliases: ["flutter"], ats: ["Flutter"], adjacent: [] },
  { canonical: "Monte Carlo", group: "Games", surface: ["Monte Carlo"], aliases: ["monte carlo", "simulation modeling"], ats: ["Monte Carlo simulation"], adjacent: ["Probability"] },
  { canonical: "Probability", group: "Games", surface: [], aliases: ["probability", "statistics", "combinatorics", "rtp", "volatility model", "math model"], ats: ["Probability and statistics"], adjacent: ["Monte Carlo"] },

  // --- Tools ---------------------------------------------------------------
  { canonical: "Jira", group: "Tools", surface: ["Jira"], aliases: ["jira", "confluence", "linear app", "asana"], ats: ["Jira"], adjacent: ["Agile"] },
  { canonical: "Figma", group: "Tools", surface: ["Figma"], aliases: ["figma", "sketch app"], ats: ["Figma"], adjacent: ["HTML/CSS"] },
  { canonical: "Postman", group: "Tools", surface: ["Postman"], aliases: ["postman", "insomnia"], ats: ["Postman"], adjacent: ["REST APIs"] },
  { canonical: "n8n", group: "Tools", surface: ["n8n"], aliases: ["n8n", "zapier", "workflow automation"], ats: ["n8n"], adjacent: [] },
  { canonical: "ESLint", group: "Tools", surface: ["ESLint", "Prettier"], aliases: ["eslint", "prettier", "linting"], ats: ["ESLint"], adjacent: ["JavaScript"] },
]

// ---------------------------------------------------------------------------
// Projections. Both consumers below existed before this file and their exact
// behaviour is preserved — see tests/lib/keywords.test.mjs, which asserts the
// old TECH_TERMS list is still a subset and that extractTech's output over the
// live store is unchanged.
// ---------------------------------------------------------------------------

const escLiteral = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// TECH_TERMS: literal strings the verifier watches inside the user's OWN
// documents (verify-claims R6). Longest-first ordering is applied by
// techTermsIn, not here.
export const TECH_TERMS = [...new Set(SKILLS.flatMap((s) => s.surface ?? []))]

// ---------------------------------------------------------------------------
// How R6 is allowed to compare two spellings — casing, then siblings.
// Both lists below are hand-enumerated, like WRITTEN_FORM and `adjacent`, and
// for the same reason: a mechanical rule would have to guess, and the thing
// being guessed at is a truthfulness gate.
// ---------------------------------------------------------------------------

// Surface forms matched EXACTLY. Everything else matches case-insensitively.
//
// techTermsIn used to have no "i" flag at all, so R6 could not see a lowercase
// invention: `techTermsIn("Built with kubernetes and terraform")` returned []
// — zero violations on a claim the fact base cannot back (AUDIT C4). A
// lowercase lie is still a lie, so the default is now case-insensitive.
//
// It is NOT a blanket "i", because the lexicon's short surface forms are
// ordinary English words, and a blanket flag reads honest prose as technology
// claims: "go through legal", "the rest of the team", "react to feedback", "a
// spring internship", "express approval", "off the rails", "made it prettier".
// TECH_LEXICON's own header records six such false positives out of nine probes
// when `surface` was folded into the posting-side matcher; the same trap is
// here, and worse, because R6 FAILS the document. A gate that cries wolf on
// truthful resumes gets muted, and then it protects nothing.
//
// So a term is listed here when its lowercase form is an ordinary English word
// a truthful resume or cover letter might really contain. Terms whose lowercase
// form the project ALREADY treats as a mis-spelled claim are deliberately NOT
// listed — "docker", "python", "java", "linux", "html", "css", "sql", "json",
// "kubernetes", "tailwind", "javascript", "typescript", "c#", "c++" all appear
// in WRITTEN_FORM's `wrong` lists below, which is this repository saying they
// name a technology however they are cased.
//
// Listing a term here preserves EXACTLY the pre-2026-08-05 behaviour for it, so
// the safe direction when in doubt is to add it: the cost is a miss, and the
// cost of the other mistake is failing an honest document.
export const CASE_SENSITIVE_SURFACE = new Set([
  "Agile",
  "Angular",
  "ARIA",
  "Azure",
  "Babel",
  "Bash",
  "Bootstrap",
  "Bun",
  "Codex",
  "Cypress",
  "Express",
  "Flask",
  "Flutter",
  "Git",
  "Go",
  "Jest",
  "Lambda",
  "Mocha",
  "Pandas",
  "Pinecone",
  "Playwright",
  "Postman",
  "Prettier",
  "Puppeteer",
  "RAG",
  "Rails",
  "React",
  "Redux",
  "Remix",
  "REST",
  "RESTful",
  "Ruby",
  "Rust",
  "S3",
  "Sass",
  "Scrum",
  "Selenium",
  "Sentry",
  "Shell",
  "Spark",
  "Spring",
  "Storybook",
  "Svelte",
  "Swagger",
  "Swift",
  "Unity",
  "Unreal",
])

// Surface forms that are ONE artifact spelled two ways. R6 compares a
// document's tech terms against the fact base's, and these must compare equal.
//
// The eight groups are exactly the false failures AUDIT C3 reproduced: a
// profile saying "Postgres" and a resume saying "PostgreSQL" failed R6 and
// exited 1, while docs/tailoring-rules.md §8 instructs "PostgreSQL not
// Postgres" and checkWrittenForm() below tells the writer to make that same
// edit. The gate, the rules document and the linter were fighting each other,
// and each round cost a model turn plus a re-verify.
//
// NOT derived from `surface`, and that refusal is the load-bearing half. A
// skill's surface list is "literal strings watched for this skill", which for an
// ABSTRACTION groups genuinely different products: Testing's surface is
// Jest/Vitest/Mocha/Cypress/Playwright/Selenium/Puppeteer/pytest,
// Observability's is Datadog/Grafana/Prometheus/Sentry, Auth's is
// OAuth/JWT/SSO/OIDC/RBAC, AI/LLM integration's is Claude/ChatGPT/OpenAI.
// Folding a whole surface list would make a profile that mentions Jest into
// evidence for a resume claiming Selenium — an invention rule 1 forbids,
// arriving through the truthfulness gate itself. So equivalence is enumerated,
// one group per artifact, and a group earns its place only when a reader would
// call the two strings the same thing spelled two ways.
//
// OAuth/OAuth2 is deliberately absent for the same reason: that is a protocol
// version, not a spelling.
export const SURFACE_SPELLINGS = [
  ["PostgreSQL", "Postgres"],
  ["Go", "Golang"],
  ["REST", "RESTful"],
  ["WebSockets", "WebSocket"],
  ["Sass", "SCSS"],
  ["Linux", "Unix"],
  ["Bash", "Shell"],
  ["OpenAPI", "Swagger"],
]

const SPELLING_CANONICAL = new Map(
  SURFACE_SPELLINGS.flatMap(([first, ...rest]) =>
    rest.map((alt) => [alt, first]),
  ),
)

// The representative spelling of `term`, or `term` itself when it has no
// sibling. Identity for everything outside SURFACE_SPELLINGS, so a caller can
// map both sides of a comparison through it unconditionally.
export function canonicalSurface(term) {
  return SPELLING_CANONICAL.get(term) ?? term
}

// TECH_LEXICON: canonical name + a loose alias regex, for reading SOMEONE
// ELSE'S posting.
//
// `surface` is deliberately NOT folded in here, and that is the whole reason
// the two fields exist separately. A surface form is trusted because of WHERE
// it appears: "Go" in the user's own SKILLS block is the language. The same
// three letters in a job posting are usually not. Auto-folding surface into
// this regex was tried and matched, in order: "we go to production", "Spring
// 2027 internship", "use a lambda function", "bagels, a bun, and coffee",
// "a remix of our culture deck", "Section S3 of the handbook" — six false
// positives out of nine probes. Same trap as SOFTWARE_BODY matching bare
// "code" in find-jobs.mjs.
//
// So detection aliases are curated per entry and must be unambiguous in
// running prose. If a skill has no unambiguous alias, it is better to miss it
// than to index every posting that mentions a season.
export const TECH_LEXICON = SKILLS.map((s) => ({
  name: s.canonical,
  group: s.group,
  // Same boundary shape as the original lexicon in profile-gaps.mjs: a term
  // may not be preceded or followed by another word character, but "+", "#"
  // and "." are allowed INSIDE a term so C++, C# and Node.js match.
  re: new RegExp(
    `(^|[^a-z0-9+#.])(${(s.aliases ?? []).join("|")})($|[^a-z0-9+#])`,
    "i",
  ),
}))

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export const SKILL_BY_NAME = new Map(SKILLS.map((s) => [s.canonical, s]))

// ---------------------------------------------------------------------------
// Written form: one spelling per skill, and the acronym paired with its
// expansion the first time it appears.
//
// Two different failures, both of which cost real screening points:
//
//   WRONG SPELLING     "Javascript", "NodeJS", "Github", "Postgres SQL". A
//                      literal keyword matcher looking for "JavaScript" or
//                      "Node.js" may not match these, and a human reviewer
//                      reads them as carelessness.
//   SPLIT FORM         writing "AWS" in the skills block and "Amazon Web
//                      Services" in a bullet. Neither is wrong, but a matcher
//                      indexing only one of the two sees half the evidence,
//                      and the document reads as though it were assembled by
//                      two different people.
//
// The rule this encodes: pick ONE form and use it everywhere, and pair it with
// the alternate ONCE — "AWS (Amazon Web Services)" — so a system indexing
// either form finds it. That is the same reasoning behind ats_forms, applied to
// the finished document instead of the plan.
//
// `wrong` is the misspellings and mis-casings actually seen on resumes.
// `pair` is the acronym/expansion partner, when a skill has one.
const WRITTEN_FORM = [
  {
    canonical: "JavaScript",
    wrong: ["Javascript", "javascript", "JavaScipt", "JS"],
  },
  { canonical: "TypeScript", wrong: ["Typescript", "typescript", "TS"] },
  {
    canonical: "Node.js",
    wrong: ["NodeJS", "Nodejs", "node js", "NodeJs", "Node JS"],
  },
  { canonical: "Next.js", wrong: ["NextJS", "Nextjs", "Next JS"] },
  { canonical: "React", wrong: ["ReactJS", "React JS", "Reactjs"] },
  {
    canonical: "PostgreSQL",
    wrong: ["Postgresql", "Postgres", "postgres", "Postgres SQL", "PostGres"],
  },
  { canonical: "MySQL", wrong: ["MySql", "mySQL", "My SQL"] },
  { canonical: "MongoDB", wrong: ["Mongodb", "Mongo DB", "mongoDB"] },
  { canonical: "GitHub", wrong: ["Github", "github", "Git Hub"] },
  { canonical: "GitHub Actions", wrong: ["Github Actions", "GH Actions"] },
  { canonical: "GitLab", wrong: ["Gitlab", "Git Lab"] },
  { canonical: "REST", wrong: ["Rest API", "restful", "RESTFUL"] },
  { canonical: "GraphQL", wrong: ["Graphql", "GraphQl", "Graph QL"] },
  { canonical: "CI/CD", wrong: ["CICD", "ci/cd", "CI-CD"] },
  { canonical: "Kubernetes", wrong: ["kubernetes", "K8s", "k8s"] },
  { canonical: "Docker", wrong: ["docker"] },
  { canonical: "Python", wrong: ["python"] },
  { canonical: "Java", wrong: ["java"] },
  { canonical: "C#", wrong: ["C sharp", "CSharp", "c#"] },
  { canonical: "C++", wrong: ["CPP", "C ++", "c++"] },
  { canonical: "HTML", wrong: ["Html", "html"] },
  { canonical: "CSS", wrong: ["Css", "css"] },
  { canonical: "SQL", wrong: ["Sql", "sql"] },
  { canonical: "JSON", wrong: ["Json", "json"] },
  { canonical: "Tailwind CSS", wrong: ["TailwindCSS", "tailwind"] },
  { canonical: "Vue.js", wrong: ["VueJS", "Vuejs", "Vue JS"] },
  { canonical: "jQuery", wrong: ["JQuery", "Jquery"] },
  { canonical: "Linux", wrong: ["linux"] },
  { canonical: "macOS", wrong: ["MacOS", "Mac OS", "OSX"] },
  { canonical: "iOS", wrong: ["IOS", "ios"] },
  { canonical: "OAuth", wrong: ["Oauth", "oAuth", "OAUTH"] },
  {
    canonical: "WebSockets",
    wrong: ["Websockets", "Web Sockets", "websockets"],
  },
]

// Acronym <-> expansion partners: writing one and never the other means a
// matcher indexing the other form finds nothing.
//
// Deliberately SHORT. A pair earns its place only when both forms are really
// used in postings and a reader would not blink at seeing them together. The
// first draft included API/SQL/UI/UX/ML/QA/MVC/CRUD/SDK and produced eight
// warnings on a perfectly good resume — nobody indexes "Structured Query
// Language", and "UI (user interface)" reads as padding. A checker that cries
// wolf gets ignored, which costs more than the pairs it was trying to catch.
const FORM_PAIRS = [
  ["AWS", "Amazon Web Services"],
  ["GCP", "Google Cloud Platform"],
  ["CI/CD", "continuous integration"],
  ["JWT", "JSON Web Token"],
  ["SSO", "single sign-on"],
  ["RBAC", "role-based access control"],
  ["TDD", "test-driven development"],
  ["ETL", "extract, transform, load"],
  ["LLM", "large language model"],
  ["RAG", "retrieval-augmented generation"],
  ["IaC", "infrastructure as code"],
  ["WCAG", "Web Content Accessibility Guidelines"],
  ["SLA", "service level agreement"],
]

// URLs, emails and file paths are stripped before the spelling check: the "g"
// in "github.com/xalva" is correct lowercase, not a misspelling of "GitHub",
// and flagging it trains the reader to ignore this whole report.
const ADDRESSES =
  /\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+\.[\w.]+\b|\b\w+\.(?:com|io|dev|org|net|ai|co)\b\S*/gi

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Does `text` contain `form` as a standalone token? Tolerates "." "+" "#"
// inside a term the way techTermsIn does, so "Node.js" and "C++" work.
function usesForm(text, form) {
  return new RegExp(`(?<![A-Za-z0-9+#.])${escRe(form)}(?![A-Za-z0-9+#])`).test(
    text,
  )
}

// Check a FINISHED document for written-form problems.
// Returns [{ issue, found, prefer, note }]; empty means consistent.
export function checkWrittenForm(text) {
  const raw = String(text ?? "")
  const issues = []
  if (!raw.trim()) return issues
  const doc = raw.replace(ADDRESSES, " ")

  for (const { canonical, wrong } of WRITTEN_FORM) {
    for (const w of wrong) {
      // Case matters here — that is the whole point — so compare exactly, and
      // skip a "wrong" form that IS the canonical spelling of another skill.
      if (w === canonical) continue
      if (!usesForm(doc, w)) continue
      issues.push({
        issue: "noncanonical_spelling",
        found: w,
        prefer: canonical,
        note: `write "${canonical}" — a literal keyword matcher may not match "${w}"`,
      })
    }
  }

  for (const [short, long] of FORM_PAIRS) {
    const hasShort = usesForm(doc, short)
    const hasLong = new RegExp(escRe(long), "i").test(doc)
    if (hasShort && !hasLong) {
      issues.push({
        issue: "unpaired_acronym",
        found: short,
        prefer: `${short} (${long})`,
        note: `pair it once so a system indexing "${long}" also matches`,
      })
    } else if (hasLong && !hasShort) {
      issues.push({
        issue: "unpaired_expansion",
        found: long,
        prefer: `${short} (${long})`,
        note: `pair it once so a system indexing "${short}" also matches`,
      })
    }
  }

  return issues
}

// The single form a skill should be written as throughout a document.
export function preferredForm(name) {
  const s = SKILL_BY_NAME.get(name)
  if (s?.ats?.length) return s.ats[0]
  const w = WRITTEN_FORM.find((f) => f.canonical === name)
  return w?.canonical ?? name
}

// Which canonical skills does this text name? Used for job postings and for the
// profile alike, which is what makes "demanded vs evidenced" a set operation.
export function extractTech(text, lexicon = TECH_LEXICON) {
  const found = new Set()
  const t = String(text ?? "")
  for (const { name, re } of lexicon) {
    if (re.test(t)) found.add(name)
  }
  return found
}

// The ATS surface forms for a canonical skill — acronym AND expansion, because
// some systems index one and not the other.
export function atsFormsFor(name) {
  return SKILL_BY_NAME.get(name)?.ats ?? [name]
}

// Skills a person who genuinely has `names` has very likely also touched, minus
// the ones they already evidence. This is the "you forgot to write it down"
// candidate set; it is a suggestion for the USER to confirm, never a fact.
export function adjacentTo(names, evidenced = new Set()) {
  const out = new Map() // candidate -> the evidenced skills implying it
  for (const n of names) {
    for (const a of SKILL_BY_NAME.get(n)?.adjacent ?? []) {
      if (evidenced.has(a)) continue
      if (!out.has(a)) out.set(a, [])
      out.get(a).push(n)
    }
  }
  return out
}
