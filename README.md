# Transcripts MCP Server

A remote **Model Context Protocol (MCP)** server hosted on **Azure Container Apps** that retrieves Microsoft Teams meeting transcripts via Microsoft Graph API using delegated **OAuth 2.0 On-Behalf-Of (OBO)** authentication.

Designed for integration with **Microsoft Copilot Studio** via the MCP Wizard.

> **Build time**: This entire project — code, Docker image, Azure deployment (Container Registry, Container Apps, App Registration with OBO), Copilot Studio integration, and iterative Graph API debugging — was built and deployed in approximately **90 minutes**.

---

## Table of Contents

- [Architecture](#architecture)
- [Tools](#tools)
- [Prerequisites](#prerequisites)
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
- [License](#license)

---

## Architecture

```
┌──────────────────┐     HTTPS + Bearer Token     ┌─────────────────────────┐
│                  │ ──────────────────────────►   │  Azure Container Apps   │
│  Copilot Studio  │                               │  (transcripts-mcp-     │
│  (MCP Client)    │  ◄──────────────────────────  │   server)              │
│                  │     JSON-RPC (MCP Protocol)   │                        │
└──────────────────┘                               └────────────┬───────────┘
                                                                │
                                                    OBO Token   │  Graph Token
                                                    Exchange    │
                                                                ▼
                                                   ┌────────────────────────┐
                                                   │  Microsoft Graph API   │
                                                   │                        │
                                                   │  /me/calendarView      │
                                                   │  /me/onlineMeetings    │
                                                   │    ?$filter=JoinWebUrl │
                                                   │  /{id}/transcripts     │
                                                   │  /{tid}/content        │
                                                   └────────────────────────┘
```

### Auth Flow

```
User in Copilot Studio
  │
  ├─1─► Sign in via OAuth 2.0 → receives access token scoped to api://<client-id>/access_as_user
  │
  ├─2─► Copilot sends MCP request with Authorization: Bearer <user-token>
  │
  ├─3─► MCP Server extracts bearer token
  │
  ├─4─► MSAL OBO flow exchanges user token → Microsoft Graph token (delegated)
  │
  └─5─► Graph API calls execute in user context (never app-level "god mode")
```

**Key design decision**: All Graph API permissions are **delegated** — the server only accesses meetings and transcripts the signed-in user has permission to see. There is no application-level access.

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

**Returns**: Clean speaker-attributed text with all VTT metadata stripped. The output is ready for AI summarisation and analysis.

**Multi-hop process** (optimised in v9):
1. Queries `/me/calendarView` to find Teams calendar events in the date range (30 days back to 7 days forward by default)
2. Filters client-side by **subject name first** (case-insensitive partial match) — before any expensive API calls
3. Filters for events with a Teams join URL (`onlineMeeting.joinUrl`)
4. Resolves only matching join URLs to an `onlineMeeting` ID via `/me/onlineMeetings?$filter=JoinWebUrl eq '...'` (with decoded URL fallback)
5. Lists transcripts via `/me/onlineMeetings/{id}/transcripts`
6. Downloads raw VTT from `/me/onlineMeetings/{id}/transcripts/{tid}/content`
7. Strips WEBVTT headers, timestamps, cue IDs, NOTE blocks, HTML tags
8. Merges consecutive same-speaker lines into paragraphs

> **Logging**: All Graph API calls are traced to container logs (`[graph]` prefix) for debugging. Failed meeting resolutions are logged with the join URL and error details rather than silently swallowed.

---

## Prerequisites

- **Azure Subscription** with Container Apps support
- **Azure Container Registry** (Basic SKU is sufficient)
- **Microsoft Entra ID (Azure AD)** — ability to create App Registrations and grant admin consent
- **Node.js** ≥ 20 (for local development only)
- **Docker** (optional — ACR can build images remotely via `az acr build`)
- **Azure CLI** (`az`) installed and logged in
- A **Microsoft 365 licence** with Teams meetings and transcription enabled

---

## Azure App Registration Setup

### 1. Register the Application

1. Go to [Azure Portal → Microsoft Entra ID → App registrations](https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/RegisteredApps)
2. Click **New registration**
   - **Name**: `Transcripts MCP Server`
   - **Supported account types**: Single tenant (your org only)
   - **Redirect URI**: Leave blank (added in step 6)
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

> **Important**: After granting admin consent, verify the consent grant includes **all four scopes**. If the grant was created before all permissions were added, you may need to update it. See [Troubleshooting → AADSTS65001](#troubleshooting).

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

### 6. Authorize Client Applications (Optional)

If Copilot Studio provides a client application ID:

1. Go to **Expose an API** → **Authorized client applications**
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
git clone <repo-url>
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

The Dockerfile uses a **multi-stage build** (node:20-alpine) with a non-root user for security.

---

## Deploy to Azure Container Apps

### Current Deployment

| Resource | Name | Location |
|----------|------|----------|
| Subscription | `VS Sub No2` (`bfec7165-22d1-4917-89e7-efda8a9e85b4`) | — |
| Resource Group | `rg-transcripts-mcp` | UK South |
| Container Registry | `transcriptsmcpacr` (`transcriptsmcpacr.azurecr.io`) | UK South |
| Container Apps Environment | `cae-transcripts-mcp` | UK South |
| Container App | `transcripts-mcp-server` | UK South |
| App Registration | `Transcripts MCP Server` (`197e344d-14d6-49ea-accd-4725a1cb8230`) | — |

**Live Endpoints**:
- Health: `https://transcripts-mcp-server.gentleocean-42ff35ee.uksouth.azurecontainerapps.io/health`
- MCP: `https://transcripts-mcp-server.gentleocean-42ff35ee.uksouth.azurecontainerapps.io/mcp`

**Container config**: 0.25 vCPU, 0.5 GiB memory, scales to zero when idle, max 1 replica.

### Redeploy After Code Changes

```bash
# 1. Rebuild image in ACR (cloud build — no local Docker needed)
az acr build --registry transcriptsmcpacr \
  --image transcripts-mcp-server:latest \
  --file Dockerfile .

# 2. Update the container app to pull the new image
az containerapp update \
  --resource-group rg-transcripts-mcp \
  --name transcripts-mcp-server \
  --image transcriptsmcpacr.azurecr.io/transcripts-mcp-server:latest

# 3. Verify
curl https://transcripts-mcp-server.gentleocean-42ff35ee.uksouth.azurecontainerapps.io/health
```

### Deploy from Scratch

```bash
# 1. Login and set subscription
az login
az account set --subscription <subscription-id>

# 2. Create resource group
az group create --name rg-transcripts-mcp --location uksouth

# 3. Create Azure Container Registry
az acr create --resource-group rg-transcripts-mcp \
  --name transcriptsmcpacr --sku Basic --admin-enabled true --location uksouth

# 4. Build image in ACR (no local Docker needed)
az acr build --registry transcriptsmcpacr \
  --image transcripts-mcp-server:latest --file Dockerfile .

# 5. Create Container Apps Environment
az containerapp env create \
  --resource-group rg-transcripts-mcp \
  --name cae-transcripts-mcp \
  --location uksouth

# 6. Get ACR credentials
ACR_PWD=$(az acr credential show --name transcriptsmcpacr --query 'passwords[0].value' -o tsv)

# 7. Create Container App
az containerapp create \
  --resource-group rg-transcripts-mcp \
  --name transcripts-mcp-server \
  --environment cae-transcripts-mcp \
  --image transcriptsmcpacr.azurecr.io/transcripts-mcp-server:latest \
  --registry-server transcriptsmcpacr.azurecr.io \
  --registry-username transcriptsmcpacr \
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

# 8. Verify
curl https://<your-app-fqdn>/health
```

### View Container Logs

```bash
az containerapp logs show \
  --resource-group rg-transcripts-mcp \
  --name transcripts-mcp-server \
  --type console --tail 50
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
   - **URL**: `https://transcripts-mcp-server.gentleocean-42ff35ee.uksouth.azurecontainerapps.io/mcp`
4. Select **Authentication**: OAuth 2.0
5. Fill in the OAuth 2.0 settings:

   | Field | Value |
   |-------|-------|
   | **Client ID** | `197e344d-14d6-49ea-accd-4725a1cb8230` |
   | **Client Secret** | *(retrieve from App Registration → Certificates & secrets)* |
   | **Authorization URL** | `https://login.microsoftonline.com/b5c09a39-9df6-437a-a76e-19095fa6f20d/oauth2/v2.0/authorize` |
   | **Token URL** | `https://login.microsoftonline.com/b5c09a39-9df6-437a-a76e-19095fa6f20d/oauth2/v2.0/token` |
   | **Refresh URL** | `https://login.microsoftonline.com/b5c09a39-9df6-437a-a76e-19095fa6f20d/oauth2/v2.0/token` *(same as Token URL)* |
   | **Scope** | `api://197e344d-14d6-49ea-accd-4725a1cb8230/access_as_user` |

6. **Copy the redirect URI** shown by the wizard (e.g., `https://global.consent.azure-apim.net/redirect/...`)
7. **Register the redirect URI** in the App Registration (see [Step 5: Configure Authentication](#5-configure-authentication-redirect-uris))
8. Test the connection — you should see both tools discovered:
   - `list_recent_meetings`
   - `get_meeting_transcript`

### Example Prompts

Once connected, users can ask the Copilot:

- *"Show me my recent meetings"*
- *"What meetings did I have on 2026-02-14?"*
- *"Get the transcript from the Design Review meeting on Monday"*
- *"What did Sarah say in yesterday's standup?"*
- *"Summarize the transcript from the Q4 Planning session"*

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
├── package.json         # Dependencies: @modelcontextprotocol/sdk, @azure/msal-node, express, zod
├── tsconfig.json        # TypeScript config: ES2022 target, CommonJS modules, strict
├── .env.example         # Template for environment variables
├── .gitignore           # Ignores node_modules, dist, .env, *.log
├── .dockerignore        # Excludes node_modules, dist, .env, .git from Docker context
└── README.md            # This file
```

### Module Details

| Module | Purpose | Key exports |
|--------|---------|-------------|
| `server.ts` | Express HTTP server + MCP protocol wiring. Creates a new `Server` instance per request (stateless). Routes `tools/list` and `tools/call`. | Express app, listens on `PORT` |
| `auth.ts` | MSAL OBO token exchange. Extracts bearer token from headers, exchanges for Graph API token. | `getGraphTokenOBO(userAssertion)`, `extractBearerToken(authHeader)` |
| `graph.ts` | Microsoft Graph REST calls. Uses Calendar API (`/me/calendarView`) for meeting discovery, resolves join URLs to online meeting IDs, then fetches transcripts. | `listMeetings()`, `listTranscripts()`, `getTranscriptContent()`, `findMeetingsByName()` |
| `vtt-parser.ts` | Strips VTT metadata (headers, timestamps, cue IDs, NOTEs, HTML tags). Merges consecutive same-speaker lines. | `cleanVttTranscript(rawVtt)` |

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | 1.12.1 | MCP server and transport (Streamable HTTP) |
| `@azure/msal-node` | 2.16.2 | MSAL ConfidentialClientApplication for OBO flow |
| `express` | 4.21.2 | HTTP framework |
| `zod` | 3.24.3 | Schema validation (MCP SDK dependency) |

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
| `access_as_user` | `api://197e344d-14d6-49ea-accd-4725a1cb8230/access_as_user` | Exposed by the App Registration to enable the OBO flow. Copilot Studio requests this scope when authenticating the user. |

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
| `401 Unauthorized` | No bearer token in request | Ensure Copilot Studio is configured with OAuth 2.0 and sends the `Authorization: Bearer <token>` header with every request. |
| `403 Authentication failed` | OBO token exchange failed | Check that `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and `AZURE_TENANT_ID` environment variables are correct in the Container App. Verify the "Expose an API" scope (`access_as_user`) is configured. |
| `AADSTS500113: No reply address is registered` | Missing redirect URI | The redirect URI from Copilot Studio is not registered in the App Registration. Go to **Authentication → Web → Redirect URIs** and add the URI shown in the Copilot Studio MCP wizard. Typical URIs needed: `https://global.consent.azure-apim.net/redirect/<connector-id>`, `https://token.botframework.com/.auth/web/redirect`, `https://copilotstudio.microsoft.com/auth/callback`. |
| `AADSTS65001: The user or administrator has not consented` | Admin consent not granted or incomplete | Go to **App Registration → API permissions** and click **Grant admin consent**. If that button shows consent is already granted, the consent grant may be missing scopes. Verify with: `az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/<sp-id>/oauth2PermissionGrants"` and check the `scope` field includes all three permissions. To fix, PATCH the grant to add the missing scope. |
| `AADSTS700024: Client assertion contains an invalid signature` | Wrong client secret or tenant | Regenerate the client secret and update the `AZURE_CLIENT_SECRET` env var in the Container App. Double-check `AZURE_TENANT_ID`. |
| `AADSTS50011: The redirect URI does not match` | Redirect URI mismatch | The redirect URI in the OAuth request must exactly match one registered in the App Registration. Check for trailing slashes and case sensitivity. |

### Graph API Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No meetings found` | No Teams meetings in calendar within the date range | Try without a date filter to see all meetings from the last 30 days. The user must be an organiser or invitee of the meeting. |
| `Transcript not available` | Meeting had no transcription | Transcription must be **started during the meeting** by a participant. Check with your Teams admin that the transcription policy is enabled for the organisation. |
| `Graph API 403: Forbidden` | Insufficient permissions | Verify that all four scopes (`User.Read`, `Calendars.Read`, `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`) are in the admin consent grant. |
| `Graph API 404: Not Found` | Meeting or transcript ID invalid | The meeting may have been deleted or the user may not have access. Try `list_recent_meetings` first to find valid meeting IDs. |

> **Graph API Gotchas Discovered During Development**:
>
> The `/me/onlineMeetings` endpoint has severe limitations that are not immediately obvious from the documentation:
>
> 1. **Cannot list all meetings** — the endpoint **requires** `$filter` and only supports filtering by `JoinWebUrl`, `joinMeetingIdSettings/joinMeetingId`, or `VideoTeleconferenceId`. Date-based filters like `startDateTime ge ...` return `400 InvalidArgument`.
>
> 2. **No `$top` or `$orderby` support** — these OData parameters are rejected with `400` errors.
>
> 3. **`isOnlineMeeting` not filterable** — the `/me/calendarView` endpoint does not support `$filter=isOnlineMeeting eq true`. You must include `onlineMeeting` in `$select` and filter client-side.
>
> 4. **DateTimeOffset values must be unquoted** — if you do manage to use a date filter on an endpoint that supports it, the values must not be wrapped in single quotes or you get `400 BadRequest: incompatible types Edm.DateTimeOffset and Edm.String`.
>
> The solution (used in this project) is to use `/me/calendarView` for meeting discovery, then resolve each meeting's join URL via `/me/onlineMeetings?$filter=JoinWebUrl eq '...'` to get the meeting ID needed for transcript access.

### Token Expiry / Copilot Studio Session Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `AADSTS500133: Assertion is not within its valid time range` | Copilot Studio cached an expired user token across conversations | Fully refresh the browser, or disconnect and reconnect the MCP connection in Copilot Studio settings. Starting a "New conversation" is **not** sufficient — the cached token persists. |
| `403` on cross-tenant meeting resolution | The calendar event is for a meeting organised in a different Entra ID tenant | Expected behaviour. The user cannot resolve `onlineMeeting` objects they do not own. The server logs these as `[graph] GET failed:` with the join URL for diagnosis. |

### Container / Deployment Errors

| Error | Cause | Solution |
|-------|-------|----------|
| Health endpoint times out | Container is cold-starting (min replicas = 0) | Wait ~10 seconds and retry. The container scales from zero to one on first request. To avoid cold starts, set `--min-replicas 1` (increases cost). |
| Container fails to start | Missing env vars or build error | Check container logs: `az containerapp logs show --resource-group rg-transcripts-mcp --name transcripts-mcp-server --type console --tail 50` |
| `EACCES: permission denied` | Port conflict in container | Ensure the `PORT` env var matches the `--target-port` in the Container App config (both should be `8080`). |
| Image pull fails | ACR credentials expired or incorrect | Re-enable admin access: `az acr update --name transcriptsmcpacr --admin-enabled true`. Then update the Container App registry credentials. |

### Copilot Studio Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "Unable to connect to MCP server" | Server unreachable or wrong URL | Verify the URL ends in `/mcp` (not just the base domain). Check that the Container App has external ingress enabled and the health endpoint responds. |
| Tools not discovered | MCP handshake fails | Check that the server responds to `initialize` and `tools/list` methods. Test locally first by sending raw JSON-RPC requests. |
| "Authentication failed" after signing in | OAuth misconfiguration | Ensure all OAuth fields (Client ID, Client Secret, Auth URL, Token URL, Refresh URL, Scope) are correct. The Refresh URL is the same as the Token URL for Entra ID v2.0 endpoints. |

### Verifying Admin Consent Grants

If you suspect the admin consent grant is incomplete, run:

```bash
# Get your app's service principal ID
SP_ID=$(az ad sp show --id <client-id> --query id -o tsv)

# List all permission grants
az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/oauth2PermissionGrants" \
  --query "value[].scope" -o tsv
```

The output should include: `User.Read Calendars.Read OnlineMeetings.Read OnlineMeetingTranscript.Read.All`

To fix a grant with missing scopes:

```bash
# Get the grant ID
GRANT_ID=$(az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/oauth2PermissionGrants" \
  --query "value[0].id" -o tsv)

# Update the grant with all required scopes
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants/$GRANT_ID" \
  --headers "Content-Type=application/json" \
  --body '{"scope":"User.Read Calendars.Read OnlineMeetings.Read OnlineMeetingTranscript.Read.All"}'
```

---

## Version History

| Version | Tag | Changes |
|---------|-----|----------|
| v1–v2 | `v1`, `v2` | Initial implementation using `/me/onlineMeetings` with `$top`, `$orderby`, `$filter` on `startDateTime`. Failed — endpoint rejects all these OData params. |
| v3 | `v3` | Removed all OData query options from `/me/onlineMeetings` and fetched raw. Failed — endpoint **requires** `$filter`. |
| v4 | `v4` | Added `$filter=startDateTime ge ...` back. Failed — `startDateTime` is not a supported filter property. |
| v5 | `v5` | Removed single-quotes around `DateTimeOffset` values in `$filter`. Failed — `startDateTime` filter still not supported on this endpoint. |
| v6 | `v6` | **Architecture change**: Switched to Calendar API (`/me/calendarView`) for meeting discovery with `$filter=isOnlineMeeting eq true`. Failed — `isOnlineMeeting` does not support filtering. |
| v7 | `v7` | **Working version**: Removed `$filter` from `calendarView`, added `onlineMeeting` to `$select`, filter client-side for events with a join URL. Resolve each to an `onlineMeeting` ID via `JoinWebUrl eq '...'`. Added `Calendars.Read` permission. |
| v8 | `v8` | Extended calendarView date range from "30 days back → now" to "30 days back → 7 days forward" to include upcoming/future meetings. |
| v9 | `v9` | **Current production version**: Added comprehensive `[graph]` logging throughout. Optimised `findMeetingsByName` to filter calendar events by subject name *before* resolving (fewer API calls). Added `graphGetSafe` helper — errors logged instead of silently swallowed. `resolveOnlineMeeting` now tries decoded URL as fallback. Subject preference fixed to always prefer calendar event subject. End-to-end verified via Copilot Studio. |

---

## License

MIT
