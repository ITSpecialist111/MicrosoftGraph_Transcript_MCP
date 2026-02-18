# Transcripts MCP Server

A remote **Model Context Protocol (MCP)** server that retrieves Microsoft Teams meeting transcripts via the Microsoft Graph API, using delegated **OAuth 2.0 On-Behalf-Of (OBO)** authentication.

Hosted on **Azure Container Apps** and designed for integration with **Microsoft Copilot Studio** (via the MCP Wizard), though any MCP-compatible client can connect.

---

## Table of Contents

- [Use Cases](#use-cases)
- [Features](#features)
- [Combining with Other MCP Servers](#combining-with-other-mcp-servers)
- [Architecture](#architecture)
- [How It Works — Internals](#how-it-works--internals)
  - [End-to-End Pipeline](#end-to-end-pipeline)
  - [Meeting Discovery (Calendar API)](#meeting-discovery-calendar-api)
  - [Meeting Resolution (OnlineMeetings API)](#meeting-resolution-onlinemeetings-api)
  - [Transcript Download & Cleaning](#transcript-download--cleaning)
  - [MCP Transport](#mcp-transport)
  - [Authentication Chain](#authentication-chain)
- [Tools](#tools)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Azure App Registration Setup](#azure-app-registration-setup)
- [Environment Variables](#environment-variables)
- [Local Development](#local-development)
- [Docker Build & Run](#docker-build--run)
- [Deploy to Azure Container Apps](#deploy-to-azure-container-apps)
- [Copilot Studio Integration](#copilot-studio-integration)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Permissions Deep Dive](#permissions-deep-dive)
- [Troubleshooting](#troubleshooting)
- [Development History](#development-history)
- [License](#license)

---

## Use Cases

Once an AI agent can access the full text of a meeting, the transcript becomes a launchpad for downstream automation:

| Use Case | Description |
|----------|-------------|
| **Sentiment analysis** | Gauge how a customer call *actually* went — detect frustration, satisfaction, or escalation patterns across every interaction, not just the ones a manager happened to attend. |
| **Follow-on automation** | Extract action items, decisions, and deadlines, then push them into Power Automate flows — create Planner tasks, send follow-up emails, or update CRM records automatically. |
| **Customer service reviews** | Audit support calls at scale without replaying hours of recordings. Search across transcripts for specific topics, complaints, or compliance language. |
| **Deal intelligence** | Surface objections, competitor mentions, pricing commitments, and next steps from sales calls — feed them into your pipeline reporting. |
| **Training & coaching** | Identify coaching moments by analysing how reps handle objections, discovery questions, or product demos. Compare top performers against the team. |
| **Compliance & audit** | Verify that required disclosures, disclaimers, or consent language were delivered during regulated conversations. |
| **Meeting summaries on demand** | Let users ask an agent *"What did we decide in the design review?"* and get a structured answer — without anyone having to write meeting notes. |

The server returns clean, speaker-attributed text — ready for any LLM to analyse, summarise, or act on.

---

## Features

- **Two MCP tools**: List meetings with transcript availability, retrieve and clean full transcripts
- **Delegated-only permissions**: The server never has its own access — every Graph call runs in the signed-in user's context via OBO
- **Calendar-based discovery**: Uses `/me/calendarView` to find meetings, then resolves each to an online meeting ID — works around severe `/me/onlineMeetings` API limitations
- **Optimised name search**: Filters calendar events by subject *before* resolving to online meetings (avoids unnecessary API calls)
- **VTT cleaning**: Strips all WebVTT metadata (timestamps, cue IDs, NOTE blocks, HTML tags) and merges consecutive same-speaker lines into readable paragraphs
- **Comprehensive logging**: All Graph API calls are traced with `[graph]` prefixes for debugging
- **Stateless container**: Scales to zero when idle, ~250ms cold start on Alpine Node.js 20
- **Built for Copilot Studio**: Drop-in MCP server with OAuth 2.0 wizard support

---

## Combining with Other MCP Servers

MCP is designed to be composable — a single Copilot Studio agent can connect to **multiple MCP servers** simultaneously, each providing different tools. This Transcripts MCP server becomes significantly more powerful when paired with other Microsoft 365 MCP servers.

### With the Office 365 Outlook / Meeting Management MCP

Copilot Studio includes a built-in **Office 365 Outlook MCP connector** (Meeting Management MCP Server) that provides tools for listing, creating, and managing calendar events. When both servers are connected to the same agent:

| Agent capability | How it works |
|-----------------|---------------|
| *"What meetings do I have today?"* | The **Outlook MCP** lists today's calendar events (including non-Teams meetings). |
| *"Get the transcript from the Design Review"* | The **Transcripts MCP** finds the meeting and returns the cleaned transcript. |
| *"Summarise my Monday standup and create follow-up tasks"* | The agent chains both servers — retrieves the transcript, then uses the Outlook MCP to schedule follow-up meetings or send recap emails. |

The LLM in Copilot Studio automatically decides which MCP server's tools to call based on the user's prompt. No manual routing is needed — the agent sees all available tools from all connected servers and plans accordingly.

### Multi-Tenant Agents (Preview)

Copilot Studio now supports [**multi-tenant agents**](https://learn.microsoft.com/en-us/microsoft-copilot-studio/multi-tenant-overview) as a preview feature, allowing you to deploy a single agent across multiple Entra ID tenants. Combined with a remote MCP server like this one (hosted on Azure Container Apps with OBO auth), you can offer transcript-powered AI agents as a managed service to multiple organisations — each user authenticates with their own tenant and only sees their own meetings.

### Example: Multi-Server Agent Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Copilot Studio Agent                      │
│                                                             │
│  Connected MCP Servers:                                     │
│  ┌─────────────────────────┐  ┌──────────────────────────┐  │
│  │ Office 365 Outlook MCP  │  │ Transcripts MCP Server   │  │
│  │ (Built-in connector)    │  │ (This repo)              │  │
│  │                         │  │                          │  │
│  │ • List meetings         │  │ • list_recent_meetings   │  │
│  │ • Create events         │  │ • get_meeting_transcript │  │
│  │ • Send emails           │  │                          │  │
│  │ • Manage calendar       │  │                          │  │
│  └─────────────────────────┘  └──────────────────────────┘  │
│                                                             │
│  User: "What did we agree in the TredStone meeting?         │
│         Schedule a follow-up for next Tuesday."             │
│                                                             │
│  Agent plan:                                                │
│   1. get_meeting_transcript("TredStone") → Transcripts MCP  │
│   2. Summarise action items from transcript                 │
│   3. Create calendar event → Outlook MCP                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Architecture

```
┌──────────────────┐     HTTPS + Bearer Token     ┌─────────────────────────┐
│                  │ ──────────────────────────►   │  Azure Container Apps   │
│  Copilot Studio  │                               │  (MCP Server)           │
│  (MCP Client)    │  ◄──────────────────────────  │                         │
│                  │     JSON-RPC (MCP Protocol)   │  Express + Streamable   │
└──────────────────┘                               │  HTTP Transport         │
                                                   └────────────┬────────────┘
                                                                │
                                                    OBO Token   │  Graph Token
                                                    Exchange    │
                                                                ▼
                                                   ┌─────────────────────────┐
                                                   │  Microsoft Graph API    │
                                                   │                         │
                                                   │  /me/calendarView       │
                                                   │  /me/onlineMeetings     │
                                                   │    ?$filter=JoinWebUrl  │
                                                   │  /{id}/transcripts      │
                                                   │  /{tid}/content         │
                                                   └─────────────────────────┘
```

### Auth Flow

```
User in Copilot Studio
  │
  ├─1─► Sign in via OAuth 2.0 → gets token scoped to api://<client-id>/access_as_user
  │
  ├─2─► Copilot sends MCP request with Authorization: Bearer <user-token>
  │
  ├─3─► MCP Server extracts bearer token from request header
  │
  ├─4─► MSAL OBO flow exchanges user token → Microsoft Graph token (delegated)
  │
  └─5─► Graph API calls execute as the signed-in user (never app-level)
```

**Key design decision**: All Graph API permissions are **delegated** — the server only accesses meetings and transcripts the signed-in user has permission to see. There is no application-level access.

---

## How It Works — Internals

This section explains the internal workings of the server for contributors and anyone wanting to understand the design decisions.

### End-to-End Pipeline

When a user asks "*Get the transcript for the Design Review meeting*", the following chain executes:

```
User prompt
  │
  ▼
Copilot Studio (LLM) decides to call get_meeting_transcript(meetingName="Design Review")
  │
  ▼
MCP JSON-RPC POST to /mcp with Bearer token
  │
  ▼
┌─ server.ts ──────────────────────────────────────────────────────────────────┐
│  1. Extract bearer token from Authorization header                          │
│  2. MSAL OBO exchange → Microsoft Graph delegated token                     │
│  3. Create stateless MCP Server instance, wire tool handlers                │
│  4. Route to handleGetMeetingTranscript()                                   │
└──────────────────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ graph.ts ───────────────────────────────────────────────────────────────────┐
│  findMeetingsByName("Design Review")                                        │
│                                                                             │
│  5. GET /me/calendarView?startDateTime=...&endDateTime=...                  │
│     → Returns all calendar events in the date range (30 days back,          │
│       7 days forward by default)                                            │
│                                                                             │
│  6. Filter by subject name first (case-insensitive partial match)           │
│     → "Design Review" matches "Weekly Design Review" ✓                      │
│                                                                             │
│  7. Filter for events with a Teams join URL (onlineMeeting.joinUrl)         │
│                                                                             │
│  8. For ONLY matching events, resolve via:                                  │
│     GET /me/onlineMeetings?$filter=JoinWebUrl eq '<joinUrl>'                │
│     → Returns the onlineMeeting object with the meeting ID                  │
│     → Falls back to decoded URL if exact match fails                        │
│                                                                             │
│  9. GET /me/onlineMeetings/{meetingId}/transcripts                          │
│     → List available transcripts                                            │
│                                                                             │
│ 10. GET /me/onlineMeetings/{meetingId}/transcripts/{tid}/content?$format=   │
│     text/vtt → Download the raw WebVTT transcript                           │
└──────────────────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ vtt-parser.ts ──────────────────────────────────────────────────────────────┐
│ 11. Strip WEBVTT header, timestamps, cue IDs, NOTE blocks, HTML tags        │
│ 12. Convert <v Speaker Name>text</v> → "Speaker Name: text"                │
│ 13. Merge consecutive same-speaker lines into paragraphs                    │
└──────────────────────────────────────────────────────────────────────────────┘
  │
  ▼
Return to Copilot Studio as plain-text speaker-attributed dialogue:

  Meeting: Weekly Design Review
  Date: 2026-02-18T15:00:00Z
  ---

  Alice Smith: We need to finalise the mockups by Friday.
  Bob Jones: I've updated the Figma file. The navigation flow is ready for review.
  Alice Smith: Great, let's walk through it now...
```

This is 5 separate Graph API calls per transcript retrieval (calendarView → onlineMeetings → transcripts → content), but by filtering by name *before* resolving meetings, the server avoids unnecessary API calls for events the user didn't ask about.

### Meeting Discovery (Calendar API)

The server uses `/me/calendarView` instead of `/me/onlineMeetings` for meeting discovery. This was a deliberate architectural decision driven by **severe undocumented limitations** in the `/me/onlineMeetings` endpoint:

| What you'd expect to work | What actually happens |
|---------------------------|----------------------|
| `GET /me/onlineMeetings` (list all) | **400** — endpoint requires `$filter` |
| `$filter=startDateTime ge 2026-02-01` | **400** — `startDateTime` is not a filterable property |
| `$top=10&$orderby=startDateTime desc` | **400** — `$top` and `$orderby` not supported |
| `$filter=isOnlineMeeting eq true` on calendarView | **400** — `isOnlineMeeting` not filterable |

**The only supported filter** on `/me/onlineMeetings` is `JoinWebUrl eq '...'` — which requires you to already know the join URL.

**Solution**: Use the Calendar API (`/me/calendarView`) which supports date ranges natively, include `onlineMeeting` in `$select`, then filter client-side for events with a join URL. Resolve each join URL via `/me/onlineMeetings?$filter=JoinWebUrl eq '...'` to get the meeting ID needed for transcript access.

### Meeting Resolution (OnlineMeetings API)

Each calendar event with a Teams join URL must be resolved to an `onlineMeeting` object. This is handled by `resolveOnlineMeeting()`:

1. **Try exact match**: `$filter=JoinWebUrl eq '<joinUrl>'`
2. **Try decoded URL**: Some Graph tenants store the decoded form — `decodeURIComponent(joinUrl)` is tried if the exact match fails
3. **Non-throwing**: Resolution failures are logged (`[graph] GET failed:`) rather than silently swallowed, so cross-tenant meetings (403) or network issues are visible in container logs

**Cross-tenant meetings**: If the user's calendar contains meetings organised in a different Entra ID tenant, the `/me/onlineMeetings` endpoint returns 403. This is expected — the meeting object belongs to the organiser's tenant. The server logs these and continues to the next event.

### Transcript Download & Cleaning

Raw Teams transcripts are in WebVTT format and contain significant metadata:

```vtt
WEBVTT

617c22e3-ccc5-445a-b806-be21f6abb3be
00:00:00.000 --> 00:00:05.840
<v Graham Hosking>We need to discuss the Q4 roadmap.</v>

617c22e3-ccc5-445a-b806-be21f6abb3be
00:00:05.840 --> 00:00:08.120
<v Graham Hosking>First item is the timeline.</v>

a1b2c3d4-e5f6-7890-abcd-ef1234567890
00:00:08.120 --> 00:00:12.000
<v Sarah Chen>I've prepared the Gantt chart.</v>
```

The `cleanVttTranscript()` function in `vtt-parser.ts`:

1. **Strips**: WEBVTT header, all timestamp lines (`00:00:00.000 --> ...`), cue IDs (numeric and UUID), NOTE blocks, `<v>` and `</v>` HTML voice tags (converting to `Speaker: text` format), any remaining HTML tags
2. **Merges**: Consecutive lines from the same speaker into single paragraphs

Output:
```
Graham Hosking: We need to discuss the Q4 roadmap. First item is the timeline.
Sarah Chen: I've prepared the Gantt chart.
```

### MCP Transport

The server uses **Streamable HTTP** transport in **stateless mode**:

- **One `Server` instance per request**: A fresh MCP `Server` is created for every incoming `POST /mcp`, wired with the user's Graph token, and disposed after the response. No sessions are maintained.
- **`sessionIdGenerator: undefined`**: Disables MCP session management — each request is independent.
- **Why stateless**: Container Apps scales to zero when idle. Stateful sessions would break across cold starts and replica restarts. Copilot Studio sends every tool call as an independent HTTP request with its own bearer token, so session state is unnecessary.

> **Implementation note**: The server uses the low-level `Server` class from `@modelcontextprotocol/sdk`, not the higher-level `McpServer` class. This avoids a TypeScript `TS2589` (deep type instantiation) error triggered by Zod's optional schemas in the SDK's type inference. The low-level API works identically but requires manual `setRequestHandler()` wiring.

### Authentication Chain

```
Copilot Studio user signs in
  │
  ▼ (OAuth 2.0 Authorization Code flow)
Entra ID issues token scoped to: api://<client-id>/access_as_user
  │
  ▼ (Copilot Studio sends to MCP server)
server.ts extracts Bearer token from Authorization header
  │
  ▼
auth.ts: MSAL ConfidentialClientApplication.acquireTokenOnBehalfOf()
  │
  ▼ (OBO flow — exchanges user token for Graph token)
Entra ID issues delegated Graph token with scopes:
  - User.Read
  - Calendars.Read
  - OnlineMeetings.Read
  - OnlineMeetingTranscript.Read.All
  │
  ▼
graph.ts uses delegated token for all API calls → runs as the signed-in user
```

**Security properties**:
- The server's client secret authenticates the app to Entra ID, but the *access* is always the user's
- If a user doesn't have access to a meeting or transcript, Graph will deny the request
- Tokens are never stored — each request does a fresh OBO exchange
- No application-level permissions are used

---

## Tools

### `list_recent_meetings`

Lists recent Microsoft Teams online meetings for the signed-in user.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string | No | Filter meetings to this date (YYYY-MM-DD) |
| `limit` | number | No | Maximum results to return (default: 10, max: 50) |

**Returns**: Meeting subject, start/end times, meeting ID, and whether a transcript is available.

### `get_meeting_transcript`

Retrieves and cleans the transcript for a specific Teams meeting.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `meetingName` | string | Yes | Meeting subject to search for (partial match, case-insensitive) |
| `meetingDate` | string | No | Date filter (YYYY-MM-DD) to narrow results |

**Returns**: Clean speaker-attributed text with all VTT metadata stripped. The output is ready for AI summarisation, action item extraction, or semantic search.

---

## Prerequisites

- **Azure Subscription** with Container Apps support
- **Azure Container Registry** (Basic SKU is sufficient)
- **Microsoft Entra ID** — ability to create App Registrations and grant admin consent
- **Node.js** ≥ 20 (for local development only)
- **Docker** (optional — ACR can build images remotely via `az acr build`)
- **Azure CLI** (`az`) installed and logged in
- A **Microsoft 365 licence** with Teams meetings and transcription enabled

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/<your-org>/TranscriptsMCP.git
cd TranscriptsMCP
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Azure App Registration credentials:
#   AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID

# 3. Build and run
npm run build
npm start
# → Server running on http://localhost:8080

# 4. Health check
curl http://localhost:8080/health
# → {"status":"ok","service":"transcripts-mcp-server"}
```

For production deployment to Azure, see [Deploy to Azure Container Apps](#deploy-to-azure-container-apps).

---

## Azure App Registration Setup

### 1. Register the Application

1. Go to [Azure Portal → Microsoft Entra ID → App registrations](https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/RegisteredApps)
2. Click **New registration**
   - **Name**: `Transcripts MCP Server`
   - **Supported account types**: Single tenant (your org only)
   - **Redirect URI**: Leave blank (added in step 5)
3. Note the **Application (client) ID** and **Directory (tenant) ID**

### 2. Create a Client Secret

1. Go to **Certificates & secrets** → **New client secret**
2. Description: `mcp-server-secret`, Expiry: 24 months
3. **Copy the secret value immediately** — it won't be shown again

### 3. Expose an API (Required for OBO)

This is the **critical step** that enables the On-Behalf-Of flow. Without it, the OBO token exchange will fail.

1. Go to **Expose an API**
2. Click **Set** next to "Application ID URI" → accept the default `api://<client-id>`
3. Click **Add a scope**:
   - **Scope name**: `access_as_user`
   - **Who can consent**: Admins and users
   - **Admin consent display name**: `Access Transcripts MCP as user`
   - **Admin consent description**: `Allows the app to access meeting transcripts on behalf of the signed-in user`
   - **User consent display name**: `Access your meeting transcripts`
   - **User consent description**: `Allows this app to read your Teams meeting transcripts`
   - **State**: Enabled
4. The full scope URI will be: `api://<client-id>/access_as_user`

### 4. Configure API Permissions

1. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**
2. Add these four permissions:

   | Permission | Purpose |
   |-----------|---------|
   | `User.Read` | Sign in and read user profile; enables `/me` endpoints |
   | `Calendars.Read` | Read calendar events via `/me/calendarView` to discover Teams meetings |
   | `OnlineMeetings.Read` | Look up online meeting details via `/me/onlineMeetings?$filter=JoinWebUrl eq '...'` |
   | `OnlineMeetingTranscript.Read.All` | Read transcript metadata and content |

3. Click **Grant admin consent for [your tenant]**

> **Important**: After granting admin consent, verify the consent grant includes **all four scopes**. If the grant was created before all permissions were added, you may need to update it. See [Troubleshooting → Verifying Admin Consent Grants](#verifying-admin-consent-grants).

### 5. Configure Authentication (Redirect URIs)

1. Go to **Authentication** → **Add a platform** → **Web**
2. Add the following redirect URIs:

   | URI | Purpose |
   |-----|---------|
   | `https://token.botframework.com/.auth/web/redirect` | Bot Framework / Power Platform auth |
   | `https://copilotstudio.microsoft.com/auth/callback` | Copilot Studio web callback |
   | `https://global.consent.azure-apim.net/redirect/<your-connector-id>` | Copilot Studio MCP connector (provided in the MCP wizard) |

3. Click **Save**

> **Note**: The third URI is specific to your Copilot Studio connector. When you set up the MCP connection in Copilot Studio, it will display the exact redirect URI you need to register. You **must** add it or you will get `AADSTS500113`.

### 6. Authorise Client Applications (Optional)

If Copilot Studio provides a client application ID:

1. Go to **Expose an API** → **Authorised client applications**
2. Add the Copilot Studio client application ID
3. Check the `access_as_user` scope

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AZURE_CLIENT_ID` | Yes | — | Application (client) ID from App Registration |
| `AZURE_CLIENT_SECRET` | Yes | — | Client secret value from App Registration |
| `AZURE_TENANT_ID` | Yes | — | Directory (tenant) ID |
| `PORT` | No | `8080` | HTTP server port |

---

## Local Development

```bash
# Clone and install
git clone https://github.com/<your-org>/TranscriptsMCP.git
cd TranscriptsMCP
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Azure App Registration credentials

# Build TypeScript
npm run build

# Start server
npm start
```

The server will start on `http://localhost:8080` (or the port specified in `.env`).

### Test Endpoints

```bash
# Health check (no auth required)
curl http://localhost:8080/health
# → {"status":"ok","service":"transcripts-mcp-server"}

# MCP endpoint without auth (should return 401)
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
# → 401 Unauthorized (expected — auth is enforced)
```

---

## Docker Build & Run

```bash
# Build locally
docker build -t transcripts-mcp-server .

# Run locally
docker run -p 8080:8080 \
  -e AZURE_CLIENT_ID=<your-client-id> \
  -e AZURE_CLIENT_SECRET=<your-client-secret> \
  -e AZURE_TENANT_ID=<your-tenant-id> \
  transcripts-mcp-server
```

The Dockerfile uses a **multi-stage build** (node:20-alpine) with a non-root user for security:

1. **Builder stage**: Installs all dependencies, compiles TypeScript
2. **Production stage**: Copies only compiled JS + production dependencies, runs as `mcpuser` (non-root)

---

## Deploy to Azure Container Apps

### Deploy from Scratch

```bash
# 1. Login and set subscription
az login
az account set --subscription <subscription-id>

# 2. Create resource group
az group create --name rg-transcripts-mcp --location <region>

# 3. Create Azure Container Registry
az acr create --resource-group rg-transcripts-mcp \
  --name <your-acr-name> --sku Basic --admin-enabled true --location <region>

# 4. Build image in ACR (no local Docker needed)
az acr build --registry <your-acr-name> \
  --image transcripts-mcp-server:latest --file Dockerfile .

# 5. Create Container Apps Environment
az containerapp env create \
  --resource-group rg-transcripts-mcp \
  --name cae-transcripts-mcp \
  --location <region>

# 6. Get ACR credentials
ACR_PWD=$(az acr credential show --name <your-acr-name> \
  --query 'passwords[0].value' -o tsv)

# 7. Create Container App
az containerapp create \
  --resource-group rg-transcripts-mcp \
  --name transcripts-mcp-server \
  --environment cae-transcripts-mcp \
  --image <your-acr-name>.azurecr.io/transcripts-mcp-server:latest \
  --registry-server <your-acr-name>.azurecr.io \
  --registry-username <your-acr-name> \
  --registry-password "$ACR_PWD" \
  --target-port 8080 \
  --ingress external \
  --min-replicas 0 --max-replicas 1 \
  --cpu 0.25 --memory 0.5Gi \
  --env-vars \
    AZURE_CLIENT_ID=<client-id> \
    AZURE_CLIENT_SECRET=<client-secret> \
    AZURE_TENANT_ID=<tenant-id> \
    PORT=8080

# 8. Get the FQDN
az containerapp show \
  --resource-group rg-transcripts-mcp \
  --name transcripts-mcp-server \
  --query 'properties.configuration.ingress.fqdn' -o tsv

# 9. Verify
curl https://<your-app-fqdn>/health
```

### Redeploy After Code Changes

```bash
# 1. Rebuild image in ACR
az acr build --registry <your-acr-name> \
  --image transcripts-mcp-server:<version-tag> \
  --file Dockerfile .

# 2. Update the container app
az containerapp update \
  --resource-group rg-transcripts-mcp \
  --name transcripts-mcp-server \
  --image <your-acr-name>.azurecr.io/transcripts-mcp-server:<version-tag>

# 3. Verify
curl https://<your-app-fqdn>/health
```

### View Container Logs

```bash
az containerapp logs show \
  --resource-group rg-transcripts-mcp \
  --name transcripts-mcp-server \
  --type console --tail 50
```

All Graph API operations are logged with `[graph]` prefixes, making it straightforward to trace the pipeline:

```
[graph] calendarView request: 2026-01-19T06:35:38Z → 2026-02-25T06:35:38Z
[graph] calendarView returned 8 events
[graph] 4 of 8 events have a Teams join URL
[graph] Resolved 3 online meetings
[graph] findMeetingsByName("Design Review"): 1 name matches out of 8 events
[graph] findMeetingsByName resolved 1 meetings
```

### Update Environment Variables

```bash
az containerapp update \
  --resource-group rg-transcripts-mcp \
  --name transcripts-mcp-server \
  --set-env-vars "AZURE_CLIENT_SECRET=<new-secret>"
```

---

## Copilot Studio Integration

### MCP Wizard Configuration

1. In Copilot Studio, open your agent → **Tools** → **Add a tool**
2. Select **MCP Server**
3. Enter the MCP server URL:
   - **URL**: `https://<your-app-fqdn>/mcp`
4. Select **Authentication**: OAuth 2.0
5. Fill in the OAuth 2.0 settings:

   | Field | Value |
   |-------|-------|
   | **Client ID** | Your Application (client) ID |
   | **Client Secret** | Your client secret value |
   | **Authorization URL** | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize` |
   | **Token URL** | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` |
   | **Refresh URL** | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` *(same as Token URL)* |
   | **Scope** | `api://<client-id>/access_as_user` |

6. **Copy the redirect URI** shown by the wizard (e.g., `https://global.consent.azure-apim.net/redirect/...`)
7. **Register the redirect URI** in the App Registration (see [Step 5](#5-configure-authentication-redirect-uris))
8. Test the connection — you should see both tools discovered:
   - `list_recent_meetings`
   - `get_meeting_transcript`

### Example Prompts

Once connected, users can ask the Copilot:

- *"What meetings do I have today?"*
- *"Show me my recent meetings"*
- *"Get the transcript from the Design Review meeting"*
- *"What did Sarah say in yesterday's standup?"*
- *"Summarise the TredStone meeting from Tuesday"*

### Example Output

**User**: *"Get the transcript for the TredStone meeting"*

**Copilot Studio** calls `get_meeting_transcript(meetingName="TredStone")`, which returns clean speaker-attributed text:

```
Meeting: TredStone - Meetings
Date: 2026-02-18T19:00:00Z
---

Graham Hosking: on optimising our Microsoft solutions to address some key
pain points and unlock new possibilities. We all know that navigating the
vast landscape of Microsoft can be challenging, from licencing to integration.
One significant pain point is ensuring seamless collaboration across different
departments...
```

Copilot Studio then automatically summarises the raw transcript into structured insights, action items, and highlights for the user.

---

## API Reference

### `GET /health`

Returns server health status. No authentication required.

**Response** (200):
```json
{ "status": "ok", "service": "transcripts-mcp-server" }
```

### `POST /mcp`

MCP protocol endpoint. Requires `Authorization: Bearer <token>` header.

**Request headers**:
- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`
- `Authorization: Bearer <user-access-token>`

**Supported MCP methods**:

| Method | Description |
|--------|-------------|
| `initialize` | MCP protocol handshake. Returns server capabilities and protocol version. |
| `tools/list` | Returns the list of available tools with their input schemas. |
| `tools/call` | Executes a tool and returns results. |

**Error responses**:

| Status | Meaning |
|--------|---------|
| 401 | Missing or invalid Authorization header |
| 403 | OBO token exchange failed (bad credentials or consent) |
| 405 | Wrong HTTP method (GET or DELETE to /mcp) |
| 500 | Internal server error |

### `GET /mcp` | `DELETE /mcp`

Returns `405 Method Not Allowed`. The MCP transport is Streamable HTTP (POST only, stateless).

---

## Project Structure

```
TranscriptsMCP/
├── src/
│   ├── server.ts        # Express app, MCP server setup, tool routing
│   ├── auth.ts          # MSAL ConfidentialClientApplication, OBO token exchange
│   ├── graph.ts         # Microsoft Graph API client (meetings, transcripts)
│   └── vtt-parser.ts    # WebVTT → clean text parser with speaker merge
├── dist/                # Compiled JavaScript output (generated by tsc)
├── Dockerfile           # Multi-stage Docker build (node:20-alpine, non-root)
├── package.json         # Dependencies and scripts
├── tsconfig.json        # TypeScript config: ES2022 target, CommonJS modules, strict
├── .env.example         # Template for environment variables
├── .gitignore           # Ignores node_modules, dist, .env, *.log
├── .dockerignore        # Excludes node_modules, dist, .env, .git from Docker context
└── README.md            # This file
```

### Module Details

| Module | Lines | Purpose | Key Exports |
|--------|-------|---------|-------------|
| `server.ts` | ~300 | Express HTTP server + MCP protocol wiring. Creates a new `Server` instance per request (stateless). Defines tool schemas and routes `tools/list` and `tools/call`. | Express app, `handleListRecentMeetings()`, `handleGetMeetingTranscript()` |
| `auth.ts` | ~80 | MSAL OBO token exchange. Creates `ConfidentialClientApplication` at startup, exchanges incoming bearer tokens for delegated Graph API tokens. | `getGraphTokenOBO(userAssertion)`, `extractBearerToken(authHeader)` |
| `graph.ts` | ~290 | Microsoft Graph REST client. Uses Calendar API for meeting discovery, resolves join URLs to online meeting IDs, fetches transcripts. Includes `graphGetSafe()` for non-throwing calls with logging. | `listMeetings()`, `findMeetingsByName()`, `listTranscripts()`, `getTranscriptContent()` |
| `vtt-parser.ts` | ~130 | Strips VTT metadata (headers, timestamps, cue IDs, NOTEs, HTML tags). Converts `<v Speaker>text</v>` to `Speaker: text`. Merges consecutive same-speaker lines. | `cleanVttTranscript(rawVtt)` |

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.12.1 | MCP server and Streamable HTTP transport |
| `@azure/msal-node` | ^2.16.2 | MSAL ConfidentialClientApplication for OBO flow |
| `express` | ^4.21.2 | HTTP framework |
| `zod` | ^3.24.2 | Schema validation (MCP SDK dependency) |

---

## Permissions Deep Dive

### Delegated Permissions (Microsoft Graph)

| Permission | Type | API Endpoint | Why Needed |
|-----------|------|-------------|------------|
| `User.Read` | Delegated | `/me` | Required for sign-in; enables all `/me` endpoints |
| `Calendars.Read` | Delegated | `/me/calendarView` | Discover Teams meetings from the user's calendar |
| `OnlineMeetings.Read` | Delegated | `/me/onlineMeetings?$filter=JoinWebUrl eq '...'` | Resolve calendar events to online meeting IDs |
| `OnlineMeetingTranscript.Read.All` | Delegated | `/me/onlineMeetings/{id}/transcripts` | List and download transcript content (VTT) |

### Custom Scope

| Scope | URI | Purpose |
|-------|-----|---------|
| `access_as_user` | `api://<client-id>/access_as_user` | Exposed by the App Registration to enable the OBO flow. Copilot Studio requests this scope when authenticating the user. |

> **Security note**: The server never accesses meetings with its own application identity. Every Graph API call uses a delegated token obtained via OBO, meaning it runs in the context of the signed-in user. If the user doesn't have access to a meeting or transcript, the Graph API will deny the request.

### Teams Admin Requirements

For transcripts to be available, the following must be true:
1. **Transcription must be enabled** in the Teams admin centre (or via policy)
2. A meeting organiser or participant must **start transcription** during the meeting
3. The signed-in user must be an **organiser or participant** of the meeting

---

## Troubleshooting

### Authentication Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `401 Unauthorized` | No bearer token in request | Ensure Copilot Studio is configured with OAuth 2.0 and sends the `Authorization: Bearer <token>` header. |
| `403 Authentication failed` | OBO token exchange failed | Check `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and `AZURE_TENANT_ID` env vars. Verify the `access_as_user` scope is configured. |
| `AADSTS500113: No reply address is registered` | Missing redirect URI | Add the redirect URI from the Copilot Studio MCP wizard to **Authentication → Web → Redirect URIs**. |
| `AADSTS65001: The user or administrator has not consented` | Admin consent not granted/incomplete | Click **Grant admin consent** in API permissions. Verify the grant includes all four scopes (see [below](#verifying-admin-consent-grants)). |
| `AADSTS700024: Client assertion contains an invalid signature` | Wrong client secret or tenant | Regenerate the client secret and update the env var. |
| `AADSTS50011: The redirect URI does not match` | Redirect URI mismatch | Check for trailing slashes and case sensitivity. |

### Token Expiry / Session Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `AADSTS500133: Assertion is not within its valid time range` | Copilot Studio cached an expired token | Fully refresh the browser, or disconnect and reconnect the MCP connection. Starting a "New conversation" alone is **not** sufficient. |
| `403` on cross-tenant meeting resolution | Calendar event is for a meeting in a different Entra ID tenant | Expected behaviour. Server logs these as `[graph] GET failed:` and continues. |

### Graph API Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No meetings found` | No Teams meetings in calendar within date range | Try without a date filter (shows last 30 days + 7 days forward). User must be organiser or invitee. |
| `Transcript not available` | No transcription was started during the meeting | Transcription must be **started during the meeting** by a participant. Check the transcription policy. |
| `Graph API 403: Forbidden` | Insufficient permissions | Verify all four scopes are in the admin consent grant. |
| `Graph API 404: Not Found` | Meeting or transcript ID invalid | Meeting may have been deleted. Try `list_recent_meetings` first. |

> **Graph API Gotchas Discovered During Development**:
>
> The `/me/onlineMeetings` endpoint has severe limitations not obvious from the documentation:
>
> 1. **Cannot list all meetings** — requires `$filter`, only supports `JoinWebUrl`, `joinMeetingIdSettings/joinMeetingId`, or `VideoTeleconferenceId`
> 2. **No `$top` or `$orderby` support** — rejected with `400`
> 3. **`isOnlineMeeting` not filterable** — on `/me/calendarView`, you must include `onlineMeeting` in `$select` and filter client-side
> 4. **DateTimeOffset values must be unquoted** — single quotes cause `400 BadRequest`

### Container / Deployment Errors

| Error | Cause | Solution |
|-------|-------|----------|
| Health endpoint times out | Container cold-starting (min replicas = 0) | Wait ~10 seconds and retry. Set `--min-replicas 1` to avoid (increases cost). |
| Container fails to start | Missing env vars or build error | Check logs: `az containerapp logs show --resource-group <rg> --name <app> --type console --tail 50` |
| `EACCES: permission denied` | Port conflict | Ensure `PORT` env var matches `--target-port` (both `8080`). |
| Image pull fails | ACR credentials expired | `az acr update --name <acr> --admin-enabled true`, then update registry credentials. |

### Copilot Studio Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "Unable to connect to MCP server" | Wrong URL or server down | Verify URL ends in `/mcp`. Check that `/health` responds. |
| Tools not discovered | MCP handshake fails | Verify `initialize` and `tools/list` work. Test locally first. |
| "Authentication failed" after signing in | OAuth misconfiguration | Check all OAuth fields. The Refresh URL is the same as the Token URL for Entra ID v2.0. |

### Verifying Admin Consent Grants

If you suspect the admin consent grant is incomplete:

```bash
# Get your app's service principal ID
SP_ID=$(az ad sp show --id <client-id> --query id -o tsv)

# List all permission grants
az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/oauth2PermissionGrants" \
  --query "value[].scope" -o tsv
```

Expected output: `User.Read Calendars.Read OnlineMeetings.Read OnlineMeetingTranscript.Read.All`

To fix a grant with missing scopes:

```bash
GRANT_ID=$(az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/oauth2PermissionGrants" \
  --query "value[0].id" -o tsv)

az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants/$GRANT_ID" \
  --headers "Content-Type=application/json" \
  --body '{"scope":"User.Read Calendars.Read OnlineMeetings.Read OnlineMeetingTranscript.Read.All"}'
```

---

## Development History

This project went through 9 iterations to arrive at a working architecture, primarily due to **undocumented limitations** in the Microsoft Graph `/me/onlineMeetings` API.

| Version | Changes |
|---------|---------|
| v1–v2 | Initial implementation using `/me/onlineMeetings` with `$top`, `$orderby`, `$filter` on `startDateTime`. Failed — endpoint rejects all these OData params. |
| v3 | Removed all OData query options. Failed — endpoint **requires** `$filter`. |
| v4 | Added `$filter=startDateTime ge ...`. Failed — `startDateTime` is not a supported filter property. |
| v5 | Removed single-quotes around `DateTimeOffset` values. Failed — `startDateTime` filter still not supported. |
| v6 | **Architecture change**: Switched to Calendar API (`/me/calendarView`) with `$filter=isOnlineMeeting eq true`. Failed — `isOnlineMeeting` not filterable. |
| v7 | **First working version**: Removed `$filter` from `calendarView`, added `onlineMeeting` to `$select`, filter client-side, resolve each join URL via `JoinWebUrl eq '...'`. |
| v8 | Extended date range to "30 days back → 7 days forward" to include upcoming meetings. |
| v9 | **Current version**: Comprehensive `[graph]` logging. Optimised `findMeetingsByName` to filter by subject *before* resolving. `graphGetSafe` for non-throwing calls. Decoded URL fallback. End-to-end verified with real transcripts via Copilot Studio. |

---

## License

MIT
