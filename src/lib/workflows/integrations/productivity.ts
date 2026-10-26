import { choice, json, text, GOOGLE_TYPES, GRAPH_TYPES, TOKEN_TYPES, type IntegrationSpec } from "./types";

export const PRODUCTIVITY_INTEGRATIONS: IntegrationSpec[] = [
  {
    type: "core.google-sheets", label: "Google Sheets", baseUrl: "https://sheets.googleapis.com/v4", credentialTypes: GOOGLE_TYPES,
    description: "Read an A1 range or append a matrix of cell values. Returns the ValueRange/update envelope (not inferred column objects).",
    credentialHelp: "Google OAuth2 with spreadsheets.readonly (read) or spreadsheets (append) scope; enable the Sheets API.",
    operations: [
      { id: "readRange", label: "Read a range", method: "GET", path: "/spreadsheets/{spreadsheetId}/values/{range}", docs: "https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get", fields: [text("spreadsheetId", "Spreadsheet ID", "path"), text("range", "A1 range", "path", "range", true, "Sheet1!A1:Z100")], query: { majorDimension: "ROWS" } },
      { id: "appendRows", label: "Append rows", method: "POST", path: "/spreadsheets/{spreadsheetId}/values/{range}:append", docs: "https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append", fields: [text("spreadsheetId", "Spreadsheet ID", "path"), text("range", "A1 range", "path", "range", true, "Sheet1!A1:Z100"), json("values", "Rows (JSON array of arrays)", "values", "matrix", '[["Hello",42]]'), choice("valueInputOption", "Interpret cell values", "query", ["RAW", "USER_ENTERED"], "RAW")], query: { insertDataOption: "INSERT_ROWS" }, body: { majorDimension: "ROWS" } },
    ],
  },
  {
    type: "core.google-drive", label: "Google Drive", baseUrl: "https://www.googleapis.com/drive/v3", credentialTypes: GOOGLE_TYPES,
    description: "List file metadata and create folders. No file upload/download or binary content in this wave.",
    credentialHelp: "Google OAuth2 with drive.metadata.readonly (list) or drive.file/drive (folder creation); enable the Drive API.",
    operations: [
      { id: "listFiles", label: "List files", method: "GET", path: "/files", docs: "https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list", fields: [text("q", "Drive search query", "query", "q", false, "trashed = false")], query: { fields: "nextPageToken,files(id,name,mimeType,webViewLink,parents)" }, output: "files", optionalOutput: true, pagination: { mode: "cursor", limitKey: "pageSize", maxPageSize: 100, cursorKey: "pageToken", cursorPath: "nextPageToken" } },
      { id: "createFolder", label: "Create a folder", method: "POST", path: "/files", docs: "https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create", fields: [text("name", "Folder name", "body"), { ...text("parentId", "Parent folder ID (optional)", "body", "parents", false), transform: "array" }], query: { fields: "id,name,mimeType,parents,webViewLink" }, body: { mimeType: "application/vnd.google-apps.folder" } },
    ],
  },
  {
    type: "core.google-calendar", label: "Google Calendar", baseUrl: "https://www.googleapis.com/calendar/v3", credentialTypes: GOOGLE_TYPES,
    description: "List events and create timed events with RFC3339 start/end offsets. All-day, recurrence and attendee management are not included.",
    credentialHelp: "Google OAuth2 with calendar.events.readonly (list) or calendar.events (create); enable the Calendar API.",
    operations: [
      { id: "listEvents", label: "List events", method: "GET", path: "/calendars/{calendarId}/events", docs: "https://developers.google.com/workspace/calendar/api/v3/reference/events/list", fields: [text("calendarId", "Calendar ID", "path", "calendarId", true, "primary"), { ...text("timeMin", "Events ending after (RFC3339)", "query", "timeMin", false), validate: "instant" }, { ...text("timeMax", "Events starting before (RFC3339)", "query", "timeMax", false), validate: "instant" }], query: { singleEvents: "true", orderBy: "startTime" }, output: "items", optionalOutput: true, timeOrder: ["timeMin", "timeMax"], pagination: { mode: "cursor", limitKey: "maxResults", maxPageSize: 100, cursorKey: "pageToken", cursorPath: "nextPageToken" } },
      { id: "createEvent", label: "Create a timed event", method: "POST", path: "/calendars/{calendarId}/events", docs: "https://developers.google.com/workspace/calendar/api/v3/reference/events/insert", fields: [text("calendarId", "Calendar ID", "path", "calendarId", true, "primary"), text("summary", "Event title", "body"), { ...text("start", "Start (RFC3339 with offset)", "body", "start.dateTime"), validate: "instant" }, { ...text("end", "End (RFC3339 with offset)", "body", "end.dateTime"), validate: "instant" }, text("description", "Description", "body", "description", false)], timeOrder: ["start", "end"] },
    ],
  },
  {
    type: "core.microsoft-outlook", label: "Microsoft Outlook", baseUrl: "https://graph.microsoft.com/v1.0", credentialTypes: GRAPH_TYPES,
    description: "List the signed-in user's mail and send plain-text mail. Send returns accepted status, not a delivery receipt. Delegated access only.",
    credentialHelp: "Microsoft delegated OAuth2 with Mail.ReadBasic/Mail.Read (list) and Mail.Send (send).",
    operations: [
      { id: "listMessages", label: "List mail messages", method: "GET", path: "/me/messages", docs: "https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0", fields: [], query: { "$select": "id,subject,from,receivedDateTime,bodyPreview", "$orderby": "receivedDateTime desc" }, output: "value", pagination: { mode: "graph", limitKey: "$top", maxPageSize: 100 } },
      { id: "sendMail", label: "Send mail", method: "POST", path: "/me/sendMail", docs: "https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0", fields: [{ ...text("to", "Recipient email(s), comma-separated", "body", "message.toRecipients"), validate: "recipients", transform: "recipients" }, text("subject", "Subject", "body", "message.subject"), text("content", "Plain-text body", "body", "message.body.content")], body: { message: { body: { contentType: "Text" } } } },
    ],
  },
  {
    type: "core.microsoft-teams", label: "Microsoft Teams", baseUrl: "https://graph.microsoft.com/v1.0", credentialTypes: GRAPH_TYPES,
    description: "List and send plain-text channel messages. No chats, attachments, replies or migration/app-only posting.",
    credentialHelp: "Microsoft OAuth2: ChannelMessage.Read.All for list, delegated ChannelMessage.Send for normal posting (tenant consent may be required).",
    operations: [
      { id: "listMessages", label: "List channel messages", method: "GET", path: "/teams/{teamId}/channels/{channelId}/messages", docs: "https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0", fields: [text("teamId", "Team ID", "path"), text("channelId", "Channel ID", "path")], output: "value", pagination: { mode: "graph", limitKey: "$top", maxPageSize: 50 } },
      { id: "sendMessage", label: "Send a channel message", method: "POST", path: "/teams/{teamId}/channels/{channelId}/messages", docs: "https://learn.microsoft.com/en-us/graph/api/channel-post-messages?view=graph-rest-1.0", fields: [text("teamId", "Team ID", "path"), text("channelId", "Channel ID", "path"), text("content", "Message text", "body", "body.content")], body: { body: { contentType: "text" } } },
    ],
  },
  {
    type: "core.hubspot", label: "HubSpot", baseUrl: "https://api.hubapi.com", credentialTypes: TOKEN_TYPES,
    description: "List CRM contacts and create contacts from named CRM properties. No companies, deals, associations or batch writes yet.",
    credentialHelp: "Bearer private-app token or OAuth2 with crm.objects.contacts.read/write scopes.",
    operations: [
      { id: "listContacts", label: "List contacts", method: "GET", path: "/crm/v3/objects/contacts", docs: "https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/guide", fields: [text("properties", "Properties (comma-separated)", "query", "properties", false, "email,firstname,lastname")], output: "results", pagination: { mode: "cursor", limitKey: "limit", maxPageSize: 100, cursorKey: "after", cursorPath: "paging.next.after" } },
      { id: "createContact", label: "Create a contact", method: "POST", path: "/crm/v3/objects/contacts", docs: "https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/basic/post-crm-v3-objects-contacts", fields: [json("contactProperties", "Contact properties (email, firstname or lastname required)", "properties", "properties", '{"email":"person@example.com","firstname":"Ada"}')], body: { associations: [] } },
    ],
  },
];
