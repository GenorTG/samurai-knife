# n8n node inventory and Smart Knife plan

Every node in n8n's public documentation index (docs.n8n.io, fetched 2026-10-22), with the wave in which Smart Knife's
own workflow engine offers an equivalent. Names are n8n's so people can find what they know; no n8n code, node
definitions or UI is copied (n8n is under the Sustainable Use License): every node is written from its documented
behaviour. Contract of the engine: docs/WORKFLOWS.md.

Waves: **1** = the engine release; **2** = next; **3** = with the AI phase or later; **A** = first integrations wave
(declarative integration specs + OAuth2 with the user's own app); **B** = later integrations (same spec format, added by
demand); **P** = needs a raw protocol client (TCP/binary driver), decided case by case; **-** = not offered, with the reason.
Any HTTP API not listed works from day one through HTTP Request + a credential.

**Delivered (0.7):** every wave 1 core node except XML, HTML, RSS Read, Send Email and Data Table (next); AI Agent
(tools: HTTP request, JavaScript, sub-workflow, calculator, clock; memory per session), Ask AI (Basic LLM Chain),
Information Extractor and Text Classifier, all on the account's provider profiles or an AI provider credential.

## Core nodes

| Node | Wave | Notes |
| --- | --- | --- |
| Activation Trigger | - | Replaced by workflow activation events. |
| Aggregate | 1 | Individual fields or all item data into one list. |
| AI Transform | 3 | AI node family (phase 3): instruction -> generated Code node. |
| Chat | 2 | Send a message to the chat user and wait for the reply. |
| Chat Trigger | 2 | Hosted chat page / embeddable widget, pairs with the AI Agent node. |
| Code | 1 | JavaScript in QuickJS-WASM (no host access), run once for all items or per item. Python later. |
| Compare Datasets | 1 | Four outputs: only A, same, different, only B. |
| Compression | 1 | Zip / gzip, unzip / gunzip. |
| Convert to File | 1 | CSV, XLSX, ODS, HTML, JSON, text, iCal, base64 to file. |
| Crypto | 1 | Hash, HMAC, sign, random string/UUID. |
| Data Table | 1 | Per-account tables stored in the workflow space (insert, update, upsert, get, delete). |
| Date & Time | 1 | Add/subtract, format, extract part, round, difference, current time. |
| Debug Helper | 1 | Fake data, throw, out-of-memory simulation is refused. |
| Edit Fields (Set) | 1 | Manual mapping or JSON; keep/drop other fields; dot notation. |
| Edit Image | 2 | Resize, crop, rotate, text, composite; uses the app's image code without the UI. |
| Email Trigger (IMAP) | 2 | Polling IMAP with the user's credential. |
| Error Trigger | 1 | Runs the account's error workflow with the failed run's details. |
| Evaluation | 3 | Datasets + metrics for AI workflows. |
| Evaluation Trigger | 3 |  |
| Execute Command | - | Never: shell on the host. Use SSH to your own server. |
| Execute Sub-workflow | 1 | Call another workflow of the same account, wait or not, per item or once. |
| Execute Sub-workflow Trigger | 1 | Declared inputs. |
| Execution Data | 1 | Custom key/value saved with the run, searchable in history. |
| Extract From File | 1 | CSV, XLSX, ODS, PDF text, HTML, JSON, ICS, RTF, text, base64. |
| Filter | 1 | Same conditions as If, one output, kept/discarded counts. |
| FTP | 2 | FTP/SFTP to the user's server through the outbound policy. |
| Git | 3 | Clone/commit/push in a throwaway sandboxed checkout. |
| GraphQL | 1 | Over the HTTP Request transport. |
| Guardrails | 3 | AI node family (phase 3). |
| HTML | 1 | Extract with CSS selectors, generate a template, convert to table. |
| HTTP Request | 1 | Every method, query/headers/body (JSON, form, multipart, raw, binary), credentials, pagination, retries; outbound policy applies. |
| If | 1 | Typed conditions (string, number, date, boolean, array, object), AND/OR. |
| JWT | 1 | Sign, decode, verify (HS/RS/ES). |
| LDAP | 3 | Protocol client, outbound policy. |
| Limit | 1 | First / last N items. |
| Local File Trigger | - | Never: host filesystem. |
| Loop Over Items (Split in Batches) | 1 | Batch size, loop + done outputs, reset. |
| Manual Trigger | 1 | Run from the editor. |
| Markdown | 1 | Markdown <-> HTML. |
| MCP Client | 2 | Call tools of any MCP server the user adds. |
| MCP Server Trigger | 2 | Expose a workflow as an MCP tool on the account's MCP endpoint. |
| Merge | 1 | Append, combine by fields / position / all combinations, choose branch, SQL-free join modes. |
| Message an Agent | 3 | AI node family (phase 3). |
| n8n | - | n8n's own API; the Smart Knife MCP + workflow API replace it. |
| n8n Form | 2 | Hosted multi-page form as a trigger + form steps (Smart Knife form pages). |
| n8n Trigger | - | Replaced by workflow activation events. |
| No Operation, do nothing | 1 |  |
| Read/Write Files from Disk | - | Never: host filesystem. Use the account's files / office library nodes. |
| Remove Duplicates | 1 | Within the input, or across executions (stored keys). |
| Rename Keys | 1 | Pairs and regex rename. |
| Respond to Webhook | 1 | Text, JSON, binary, redirect, status + headers. |
| RSS Feed Trigger | 2 | Polling, new items only. |
| RSS Read | 1 |  |
| Schedule Trigger | 1 | Interval or cron, per-workflow time zone. |
| Send Email | 1 | SMTP credential of the user (never the instance mailer). |
| Sort | 1 | By fields, random, or code-free custom order. |
| Split Out | 1 | Split a list field into items, include other fields. |
| SSE Trigger | 2 | Listen to a server-sent events URL (long-lived, worker slot cost). |
| SSH | 2 | Commands on the user's own server (outbound only, never this host). |
| Stop And Error | 1 | Fails the run with a message or an error object. |
| Summarize | 1 | Count, sum, min, max, average, concatenate, count unique; split by fields. |
| Switch | 1 | Rules or expression, numbered outputs, fallback output. |
| TOTP | 1 | Generate a code from a stored secret. |
| Track Time Saved | - | n8n insights feature. |
| Wait | 1 | Time interval, until a date, or until a resume webhook call. |
| Webhook | 1 | Test + production URLs, methods, auth (header, basic, bearer), raw body, binary. |
| Workflow Trigger | 1 | Covered by Execute Sub-workflow Trigger + activation events. |
| XML | 1 | XML <-> JSON. |

## AI (cluster) nodes: phase 3

One **Chat model** sub-node replaces n8n's per-vendor chat model nodes: it either inherits one of the account's saved
provider profiles or takes a manual endpoint, key and model (OpenAI-compatible, Anthropic, Gemini, Ollama, OpenRouter,
Groq, Mistral, DeepSeek, xAI, … are all one of those shapes).

| Node | Kind | Wave |
| --- | --- | --- |
| AI Agent | root | 3 |
| Conversational Agent | root | 3+ |
| OpenAI Functions Agent | root | 3+ |
| Plan and Execute Agent | root | 3+ |
| ReAct Agent | root | 3+ |
| SQL Agent | root | 3+ |
| Tools Agent | root | 3 |
| Basic LLM Chain | root | 3 |
| Question and Answer Chain | root | 3+ |
| Summarization Chain | root | 3 |
| Information Extractor | root | 3 |
| Text Classifier | root | 3 |
| Sentiment Analysis | root | 3 |
| LangChain Code | root | 3+ |
| Microsoft Agent 365 Trigger | root | 3+ |
| Databricks AI Agent | root | 3+ |
| Azure AI Search Vector Store | root | 3+ |
| Simple Vector Store | root | 3+ |
| Milvus Vector Store | root | 3+ |
| MongoDB Atlas Vector Store | root | 3+ |
| PGVector Vector Store | root | 3+ |
| Oracle Database Vector Store | root | 3+ |
| Chroma Vector Store | root | 3+ |
| Databricks Vector Store | root | 3+ |
| Pinecone Vector Store | root | 3+ |
| Qdrant Vector Store | root | 3+ |
| Redis Vector Store | root | 3+ |
| Supabase Vector Store | root | 3+ |
| Weaviate Vector Store | root | 3+ |
| Zep Vector Store | root | 3+ |
| Default Data Loader | sub-node | 3+ |
| GitHub Document Loader | sub-node | 3+ |
| Embeddings AWS Bedrock | sub-node | 3+ |
| Microsoft Foundry Embeddings | sub-node | 3+ |
| Embeddings Cohere | sub-node | 3+ |
| Embeddings Databricks | sub-node | 3+ |
| Embeddings Google Gemini | sub-node | 3+ |
| Embeddings Google PaLM | sub-node | 3+ |
| Embeddings Google Vertex | sub-node | 3+ |
| Embeddings HuggingFace Inference | sub-node | 3+ |
| Embeddings Lemonade | sub-node | 3+ |
| Embeddings Mistral Cloud | sub-node | 3+ |
| Embeddings Ollama | sub-node | 3+ |
| Embeddings OpenAI | sub-node | 3+ |
| Embeddings Oracle Database | sub-node | 3+ |
| Qwen Cloud Chat Model | sub-node | 3 (as Chat model) |
| Anthropic Chat Model | sub-node | 3 (as Chat model) |
| AWS Bedrock Chat Model | sub-node | 3 (as Chat model) |
| Microsoft Foundry Chat Model | sub-node | 3 (as Chat model) |
| Cohere Chat Model | sub-node | 3 (as Chat model) |
| Databricks Chat Model | sub-node | 3 (as Chat model) |
| DeepSeek Chat Model | sub-node | 3 (as Chat model) |
| Google Gemini Chat Model | sub-node | 3 (as Chat model) |
| Google Vertex Chat Model | sub-node | 3 (as Chat model) |
| Groq Chat Model | sub-node | 3 (as Chat model) |
| Lemonade Chat Model | sub-node | 3 (as Chat model) |
| MiniMax Chat Model | sub-node | 3 (as Chat model) |
| Mistral Cloud Chat Model | sub-node | 3 (as Chat model) |
| Moonshot Kimi Chat Model node | sub-node | 3 (as Chat model) |
| NVIDIA Nemotron Chat Model | sub-node | 3 (as Chat model) |
| Ollama Chat Model | sub-node | 3 (as Chat model) |
| OpenAI Chat Model | sub-node | 3 (as Chat model) |
| OpenRouter Chat Model | sub-node | 3 (as Chat model) |
| Vercel AI Gateway Chat Model | sub-node | 3 (as Chat model) |
| xAI Grok Chat Model | sub-node | 3 (as Chat model) |
| Cohere Model | sub-node | 3 (as Chat model) |
| Lemonade Model | sub-node | 3 (as Chat model) |
| Ollama Model | sub-node | 3 (as Chat model) |
| Hugging Face Inference Model | sub-node | 3 (as Chat model) |
| Chat Memory Manager | sub-node | 3+ |
| Simple Memory | sub-node | 3 |
| Motorhead | sub-node | 3+ |
| MongoDB Chat Memory | sub-node | 3+ |
| Redis Chat Memory | sub-node | 3+ |
| Postgres Chat Memory | sub-node | 3+ |
| Xata | sub-node | 3+ |
| Zep | sub-node | 3+ |
| Auto-fixing Output Parser | sub-node | 3 |
| Item List Output Parser | sub-node | 3 |
| Structured Output Parser | sub-node | 3 |
| Contextual Compression Retriever | sub-node | 3+ |
| MultiQuery Retriever | sub-node | 3+ |
| Vector Store Retriever | sub-node | 3+ |
| Workflow Retriever | sub-node | 3+ |
| Character Text Splitter | sub-node | 3 |
| Recursive Character Text Splitter | sub-node | 3 |
| Token Splitter | sub-node | 3+ |
| AI Agent Tool | sub-node | 3 |
| Calculator | sub-node | 3 |
| Custom Code Tool | sub-node | 3 |
| Databricks Genie One MCP server | sub-node | 3+ |
| MCP Client Tool | sub-node | 3 |
| SearXNG Tool | sub-node | 3 |
| SerpApi (Google Search) | sub-node | 3+ |
| Think Tool | sub-node | 3 |
| Vector Store Question Answer Tool | sub-node | 3+ |
| Wikipedia | sub-node | 3 |
| Wolfram|Alpha tool | sub-node | 3+ |
| Call n8n Workflow Tool | sub-node | 3 |
| Reranker Cohere | sub-node | 3+ |
| Model Selector | sub-node | 3 |

## App nodes (275)

Waves: A 103, B 155, P 17.

| Node | Wave |
| --- | --- |
| Action Network | B |
| ActiveCampaign | B |
| Adalo | B |
| Affinity | B |
| Agile CRM | B |
| Airtable | A |
| Airtop | B |
| AMQP Sender | P |
| Anthropic | A |
| APITemplate.io | B |
| Asana | A |
| Autopilot | B |
| AWS Certificate Manager | B |
| AWS Cognito | B |
| AWS Comprehend | B |
| AWS DynamoDB | B |
| AWS Elastic Load Balancing | B |
| AWS IAM | B |
| AWS Lambda | B |
| AWS Rekognition | B |
| AWS S3 | A |
| AWS SES | B |
| AWS SNS | B |
| AWS SQS | B |
| AWS Textract | B |
| AWS Transcribe | B |
| Azure Cosmos DB | P |
| Azure Storage | B |
| BambooHR | B |
| Bannerbear | B |
| Baserow | A |
| Beeminder | B |
| Bitly | A |
| Bitwarden | A |
| Box | B |
| Brandfetch | B |
| Brevo | A |
| Bubble | B |
| Chargebee | B |
| CircleCI | B |
| Clearbit | B |
| ClickUp | A |
| Clockify | B |
| Cloudflare | A |
| Cockpit | B |
| Coda | B |
| CoinGecko | A |
| Confluence | B |
| Contentful | A |
| ConvertKit | B |
| Copper | B |
| Cortex | B |
| CrateDB | P |
| Customer Datastore (n8n Training) | B |
| Customer Messenger (n8n Training) | B |
| Customer.io | B |
| Databricks | P |
| DeepL | A |
| Demio | B |
| DHL | B |
| Discord | A |
| Discourse | B |
| Disqus | B |
| Drift | B |
| Dropbox | A |
| Dropcontact | B |
| E-goi | B |
| Elastic Security | B |
| Elasticsearch | A |
| Emelia | B |
| ERPNext | B |
| Facebook Graph API | A |
| FileMaker | P |
| Flow | B |
| Freshdesk | A |
| Freshservice | B |
| Freshworks CRM | B |
| GetResponse | B |
| Ghost | A |
| GitHub | A |
| GitLab | A |
| Gmail | A |
| Gong | B |
| Google Ads | A |
| Google Analytics | A |
| Google BigQuery | A |
| Google Books | B |
| Google Business Profile | A |
| Google Calendar | A |
| Google Chat | A |
| Google Cloud Firestore | P |
| Google Cloud Natural Language | B |
| Google Cloud Realtime Database | P |
| Google Cloud Storage | B |
| Google Contacts | A |
| Google Docs | A |
| Google Drive | A |
| Google Gemini | A |
| Google Perspective | B |
| Google Sheets | A |
| Google Slides | A |
| Google Tasks | A |
| Google Translate | A |
| Google Workspace Admin | B |
| Gotify | A |
| GoToWebinar | B |
| Grafana | A |
| Grist | A |
| Hacker News | A |
| HaloPSA | B |
| Harvest | B |
| Help Scout | B |
| HighLevel | B |
| Home Assistant | A |
| HubSpot | A |
| Humantic AI | B |
| Hunter | B |
| Intercom | A |
| Invoice Ninja | B |
| Iterable | B |
| Jenkins | B |
| Jina AI | B |
| Jira Software | A |
| Kafka | P |
| Keap | B |
| Kitemaker | B |
| KoboToolbox | B |
| Lemlist | B |
| Line | B |
| Linear | A |
| LingvaNex | B |
| LinkedIn | A |
| LoneScale | B |
| Magento 2 | B |
| Mailcheck | B |
| Mailchimp | A |
| MailerLite | A |
| Mailgun | A |
| Mailjet | B |
| Mandrill | B |
| marketstack | B |
| Matrix | A |
| Mattermost | A |
| Mautic | B |
| Medium | B |
| MessageBird | B |
| Metabase | B |
| Microsoft Dataverse | B |
| Microsoft Dynamics CRM | B |
| Microsoft Entra ID | B |
| Microsoft Excel (OneDrive) | A |
| Microsoft Excel (SharePoint) | B |
| Microsoft Graph Security | B |
| Microsoft OneDrive | A |
| Microsoft Outlook | A |
| Microsoft SharePoint | B |
| Microsoft SQL | P |
| Microsoft Teams | A |
| Microsoft To Do | A |
| Mindee | B |
| MiniMax | B |
| MISP | B |
| Mistral AI | A |
| Mocean | B |
| monday.com | A |
| MongoDB | A |
| Monica CRM | B |
| Moonshot Kimi | B |
| MQTT | P |
| MSG91 | B |
| MySQL | A |
| NASA | B |
| Netlify | A |
| Netscaler ADC | P |
| Nextcloud | A |
| NocoDB | A |
| Notion | A |
| npm | B |
| Odoo | B |
| Okta | B |
| One Simple API | B |
| Onfleet | B |
| OpenAI | A |
| OpenThesaurus | B |
| OpenWeatherMap | A |
| Oracle Database | P |
| Oura | B |
| Paddle | B |
| PagerDuty | A |
| PayPal | A |
| Peekalink | B |
| Perplexity | A |
| PhantomBuster | B |
| Philips Hue | B |
| Pipedrive | A |
| Plivo | B |
| PostBin | B |
| Postgres | A |
| PostHog | B |
| ProfitWell | B |
| Pushbullet | A |
| Pushcut | B |
| Pushover | A |
| QuestDB | P |
| Quick Base | B |
| QuickBooks Online | A |
| QuickChart | A |
| Qwen Cloud | B |
| RabbitMQ | P |
| Raindrop | B |
| Reddit | A |
| Redis | A |
| Rocket.Chat | A |
| Rundeck | B |
| S3 | A |
| Salesforce | A |
| Salesmate | B |
| SeaTable | B |
| SecurityScorecard | B |
| Segment | B |
| SendGrid | A |
| Sendy | B |
| Sentry.io | A |
| ServiceNow | B |
| seven | B |
| Shopify | A |
| SIGNL4 | B |
| Slack | A |
| Snowflake | P |
| Splunk | P |
| Spotify | A |
| Stackby | B |
| Storyblok | B |
| Strapi | A |
| Strava | B |
| Stripe | A |
| Supabase | A |
| SyncroMSP | B |
| Taiga | B |
| Tapfiliate | B |
| Telegram | A |
| TheHive | B |
| TheHive 5 | B |
| TimescaleDB | P |
| Todoist | A |
| Travis CI | B |
| Trello | A |
| Twake | B |
| Twilio | A |
| Twist | B |
| Unleashed Software | B |
| UpLead | B |
| uProc | B |
| UptimeRobot | A |
| urlscan.io | B |
| Venafi TLS Protect Cloud | B |
| Venafi TLS Protect Datacenter | B |
| Vero | B |
| Vonage | B |
| Webex by Cisco | B |
| Webflow | A |
| Wekan | B |
| WhatsApp Business Cloud | A |
| Wise | B |
| WooCommerce | A |
| WordPress | A |
| X (Formerly Twitter) | A |
| Xero | A |
| Yourls | B |
| YouTube | A |
| Zammad | B |
| Zendesk | A |
| Zoho CRM | A |
| Zoom | A |
| Zulip | B |

## App trigger nodes (91)

Waves: A 37, B 50, P 4.

| Node | Wave |
| --- | --- |
| ActiveCampaign Trigger | B |
| Acuity Scheduling Trigger | B |
| Affinity Trigger | B |
| Airtable Trigger | A |
| AMQP Trigger | B |
| Asana Trigger | A |
| Autopilot Trigger | B |
| AWS SNS Trigger | B |
| Bitbucket Trigger | B |
| Box Trigger | B |
| Brevo Trigger | A |
| Cal Trigger | B |
| Calendly Trigger | A |
| Chargebee Trigger | B |
| ClickUp Trigger | A |
| Clockify Trigger | B |
| ConvertKit Trigger | B |
| Copper Trigger | B |
| Customer.io Trigger | B |
| Databricks Trigger | P |
| Emelia Trigger | B |
| Eventbrite Trigger | B |
| Facebook Lead Ads Trigger | B |
| Facebook Trigger | B |
| Figma Trigger (Beta) | B |
| Flow Trigger | B |
| Form.io Trigger | B |
| Formstack Trigger | B |
| GetResponse Trigger | B |
| GitHub Trigger | A |
| GitLab Trigger | A |
| Gmail Trigger | A |
| Google Business Profile Trigger | A |
| Google Calendar Trigger | A |
| Google Drive Trigger | A |
| Google Sheets Trigger | A |
| Gumroad Trigger | B |
| Help Scout Trigger | B |
| HubSpot Trigger | A |
| Invoice Ninja Trigger | B |
| Jira Trigger | B |
| Jotform Trigger | A |
| Kafka Trigger | P |
| Keap Trigger | B |
| KoboToolbox Trigger | B |
| Lemlist Trigger | B |
| Linear Trigger | A |
| LoneScale Trigger | B |
| Mailchimp Trigger | A |
| MailerLite Trigger | A |
| Mailjet Trigger | B |
| Mautic Trigger | B |
| Microsoft OneDrive Trigger | A |
| Microsoft Outlook Trigger | A |
| Microsoft SharePoint Trigger | B |
| Microsoft Teams Trigger | A |
| MQTT Trigger | P |
| Netlify Trigger | A |
| Notion Trigger | A |
| Onfleet Trigger | B |
| PayPal Trigger | A |
| Pipedrive Trigger | A |
| Postgres Trigger | A |
| Postmark Trigger | B |
| Pushcut Trigger | B |
| RabbitMQ Trigger | P |
| Redis Trigger | A |
| Salesforce Trigger | A |
| SeaTable Trigger | B |
| Shopify Trigger | A |
| Slack Trigger | A |
| Strava Trigger | B |
| Stripe Trigger | A |
| SurveyMonkey Trigger | B |
| Taiga Trigger | B |
| Telegram Trigger | A |
| TheHive 5 Trigger | B |
| TheHive Trigger | B |
| Toggl Trigger | B |
| Trello Trigger | A |
| Twilio Trigger | A |
| Typeform Trigger | A |
| Venafi TLS Protect Cloud Trigger | B |
| Webex by Cisco Trigger | B |
| Webflow Trigger | A |
| WhatsApp Trigger | B |
| Wise Trigger | B |
| WooCommerce Trigger | A |
| Workable Trigger | B |
| Wufoo Trigger | B |
| Zendesk Trigger | A |

App triggers run as a webhook the service calls (registered with the user's credential where the API allows it)
or as a polling trigger (schedule + stored cursor), whichever the service supports.

## Credentials (322)

n8n documents one credential type per service. Smart Knife ships generic types first (API key in header/query, bearer,
basic, custom headers, OAuth2 with the user's own client id/secret and presets for Google, Meta/Facebook, Microsoft,
GitHub, Slack, Discord, Notion, …; SMTP; IMAP; database URLs) and each integration spec names which one it uses.
