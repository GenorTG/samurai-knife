/** Word lists shared by the lint and translation checks. All entries lowercase. */

const words = (block: string): ReadonlySet<string> => new Set(block.split(/\s+/).filter(Boolean));

/** Tech names and acronyms. Language-neutral: never "foreign", always a concrete signal. Excludes plain words ("go", "c", "r"). */
export const TECH_TERMS = words(`
  python java javascript typescript node nodejs deno bun react vue angular svelte nextjs django
  flask fastapi spring hibernate rails laravel symfony nestjs dotnet asp kotlin swift php
  ruby scala rust golang elixir haskell perl lua dart flutter android ios linux unix windows macos
  ubuntu debian docker kubernetes k8s helm podman terraform ansible puppet vagrant
  aws azure gcp heroku vercel netlify cloudflare nginx apache haproxy envoy istio
  git github gitlab bitbucket jenkins circleci travis argocd jira confluence trello slack
  postgres postgresql mysql mariadb sqlite oracle mssql mongodb redis memcached cassandra
  dynamodb elasticsearch opensearch kibana logstash grafana prometheus datadog sentry splunk
  kafka rabbitmq activemq nats celery airflow spark hadoop flink dbt snowflake bigquery
  graphql rest restful grpc soap websocket websockets http https tcp udp ssh tls ssl dns
  api sdk cli gui ui ux sql nosql orm etl elt crud cqrs mvc mvp html css sass scss json yaml
  xml csv protobuf openapi swagger oauth oauth2 jwt saml sso ldap ci cd cicd devops devsecops
  sre qa qc tdd bdd ddd agile scrum kanban saas paas iaas b2b b2c erp crm cms sap salesforce
  ml ai llm nlp gpu cpu ram ssd pytorch tensorflow keras sklearn pandas numpy scipy jupyter
  opencv huggingface langchain openai bash zsh powershell vim emacs vscode intellij pycharm
  webpack vite babel eslint ruff pytest jest junit selenium cypress playwright postman
  figma photoshop powerpoint sharepoint outlook
  microservices microservice monorepo serverless lambda iot embedded firmware arduino raspberry
  blockchain solidity ethereum bitcoin
`);

/** Capitalised words that are not proper nouns for our purposes (months, days, languages). */
export const NAME_EXCLUDE = words(`
  january february march april may june july august september october november december
  monday tuesday wednesday thursday friday saturday sunday
  english polish german french spanish italian russian ukrainian czech chinese japanese
  present pln usd eur gbp chf
`);

/** Function words that only exist in English (not Polish): evidence of an English fragment. */
export const EN_STOP = words(`
  the and with for of using were been have has had from that this which our your their into
  across through within over between while when also more than built developed implemented
  designed managed led delivered improved reduced increased created worked responsible
  experience years months company customers
`);

/** Function words that only exist in Polish: evidence of a Polish fragment inside English text. */
export const PL_STOP = words(`
  się oraz dla przez który która które którzy których jest są był była było jako przy także
  również poprzez między wraz aby żeby ponad około tylko nie nad pod przed podczas dzięki ale
  że jak na od po za
`);

export const PL_DIACRITICS = "ąćęłńóśźżĄĆĘŁŃÓŚŹŻ";
