# Power Automate Flow: Meeting Transcript Retrieval — "The Old Way"

> **Purpose**: A corrected Power Automate flow that replicates the core `get_meeting_transcript` functionality of the Transcripts MCP Server, for side-by-side demo comparison.

---

## Prerequisites

### Azure App Registration (Application Permissions)

Because Power Automate HTTP actions use **client credentials** (app-only auth), you need **application** permissions — not delegated:

| Permission                            | Type        | Why                              |
|---------------------------------------|-------------|----------------------------------|
| `OnlineMeetings.Read.All`             | Application | Find meetings by subject         |
| `OnlineMeetingTranscript.Read.All`    | Application | List & download transcripts      |

> **Security note**: Application permissions grant access to *all* users' meetings — unlike the MCP server which uses delegated OBO and can only access the signed-in user's data.

### Tenant Admin Consent

Application permissions require **admin consent** in the Azure portal.

---

## Flow Overview

```
Trigger: "When an agent calls the flow"
  Inputs: MeetingName, UserId, MeetingDate (all required)

  ┌─ Scope ─────────────────────────────────────────────────────┐
  │                                                             │
  │  Step 1: Find_the_Meeting_ID                                │
  │    GET /users/{UserId}/onlineMeetings?$filter=subject eq…   │
  │         ↓                                                   │
  │  Step 2: Get_the_Transcript_ID                              │
  │    GET /users/{UserId}/onlineMeetings/{meetingId}/transcripts│
  │         ↓                                                   │
  │  Step 3: Download_Transcript_Content                        │
  │    GET  …/transcripts/{transcriptId}/content?$format=…      │
  │         ↓                                                   │
  │  Step 4: Respond_to_the_agent                               │
  │    Return raw VTT text to Copilot Studio                    │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Corrections

### Step 1 — Find the Meeting ID

**Your original**: `GET /me/onlineMeetings?$filter=subject eq '{MeetingName}'`

**Problem**: `/me/` doesn't work with client credentials (app-only) auth in HTTP actions. You have a `UserId` input — use it.

**Corrected URI**:
```
https://graph.microsoft.com/v1.0/users/@{triggerBody()?['text_1']}/onlineMeetings?$filter=subject eq '@{triggerBody()?['text']}'
```

| Expression                      | Maps to     |
|---------------------------------|-------------|
| `triggerBody()?['text']`        | MeetingName |
| `triggerBody()?['text_1']`      | UserId      |

---

### Step 2 — Get the Transcript ID

**Your original**: `GET /users` (placeholder — wrong endpoint entirely)

**Corrected URI**:
```
https://graph.microsoft.com/v1.0/users/@{triggerBody()?['text_1']}/onlineMeetings/@{body('Find_the_Meeting_ID')?['value']?[0]?['id']}/transcripts
```

This extracts the meeting ID from the first result of Step 1, then lists available transcripts.

---

### Step 3 — Download the Transcript Content

**Your original**: `GET /` (placeholder)

**Corrected URI**:
```
https://graph.microsoft.com/v1.0/users/@{triggerBody()?['text_1']}/onlineMeetings/@{body('Find_the_Meeting_ID')?['value']?[0]?['id']}/transcripts/@{body('Get_the_Transcript_ID')?['value']?[0]?['id']}/content?$format=text/vtt
```

This chains the meeting ID (from Step 1) and transcript ID (from Step 2) to download the raw VTT file.

> **Note**: Add the header `Accept: text/vtt` in the HTTP action for reliability.

---

### Step 4 — Respond to the Agent

**Your original**: Referenced `body('Download_Content')` — update to match the renamed action.

**Corrected response body**:
```json
{
  "meetingtranscripttext": "@{body('Download_Transcript_Content')}"
}
```

---

### Removed: `Download_Content_2`

Your original flow had a fourth HTTP action (`Download_Content_2`) with a placeholder URI that ran after the transcript download but whose output was never used. This step has been removed — only three HTTP calls are needed.

---

## Corrected Scope JSON

Copy this into the Code View of your Power Automate flow, replacing the existing `Scope` action. Replace the `<placeholders>` with your Azure app registration values.

```json
{
  "type": "Scope",
  "actions": {
    "Find_the_Meeting_ID": {
      "type": "Http",
      "inputs": {
        "uri": "https://graph.microsoft.com/v1.0/users/@{triggerBody()?['text_1']}/onlineMeetings?$filter=subject eq '@{triggerBody()?['text']}'",
        "method": "GET",
        "authentication": {
          "type": "ActiveDirectoryOAuth",
          "authority": "https://login.microsoftonline.com/<your-tenant-id>",
          "tenant": "<your-tenant-id>",
          "audience": "https://graph.microsoft.com",
          "clientId": "<your-client-id>",
          "secret": "<your-client-secret>"
        }
      },
      "runtimeConfiguration": {
        "contentTransfer": { "transferMode": "Chunked" }
      },
      "metadata": {
        "operationMetadataId": "2003c779-d7b4-4326-bd70-ab8555312eef"
      }
    },
    "Get_the_Transcript_ID": {
      "type": "Http",
      "inputs": {
        "uri": "https://graph.microsoft.com/v1.0/users/@{triggerBody()?['text_1']}/onlineMeetings/@{body('Find_the_Meeting_ID')?['value']?[0]?['id']}/transcripts",
        "method": "GET",
        "authentication": {
          "type": "ActiveDirectoryOAuth",
          "authority": "https://login.microsoftonline.com/<your-tenant-id>",
          "tenant": "<your-tenant-id>",
          "audience": "https://graph.microsoft.com",
          "clientId": "<your-client-id>",
          "secret": "<your-client-secret>"
        }
      },
      "runAfter": {
        "Find_the_Meeting_ID": ["SUCCEEDED"]
      },
      "runtimeConfiguration": {
        "contentTransfer": { "transferMode": "Chunked" }
      },
      "metadata": {
        "operationMetadataId": "e6f9ae06-2de6-4e59-89c3-3746b5cfd9d1"
      }
    },
    "Download_Transcript_Content": {
      "type": "Http",
      "inputs": {
        "uri": "https://graph.microsoft.com/v1.0/users/@{triggerBody()?['text_1']}/onlineMeetings/@{body('Find_the_Meeting_ID')?['value']?[0]?['id']}/transcripts/@{body('Get_the_Transcript_ID')?['value']?[0]?['id']}/content?$format=text/vtt",
        "method": "GET",
        "headers": {
          "Accept": "text/vtt"
        },
        "authentication": {
          "type": "ActiveDirectoryOAuth",
          "authority": "https://login.microsoftonline.com/<your-tenant-id>",
          "tenant": "<your-tenant-id>",
          "audience": "https://graph.microsoft.com",
          "clientId": "<your-client-id>",
          "secret": "<your-client-secret>"
        }
      },
      "runAfter": {
        "Get_the_Transcript_ID": ["SUCCEEDED"]
      },
      "runtimeConfiguration": {
        "contentTransfer": { "transferMode": "Chunked" }
      },
      "metadata": {
        "operationMetadataId": "cadbf15b-d8a3-491a-91cb-b1627d646171"
      }
    },
    "Respond_to_the_agent": {
      "type": "Response",
      "kind": "Skills",
      "inputs": {
        "schema": {
          "type": "object",
          "properties": {
            "meetingtranscripttext": {
              "title": "MeetingTranscriptText",
              "x-ms-dynamically-added": true,
              "type": "string"
            }
          },
          "additionalProperties": {}
        },
        "statusCode": 200,
        "body": {
          "meetingtranscripttext": "@{body('Download_Transcript_Content')}"
        }
      },
      "runAfter": {
        "Download_Transcript_Content": ["SUCCEEDED"]
      },
      "metadata": {
        "operationMetadataId": "f83dbcf4-0a7d-438d-9255-0a687e6d1413"
      }
    }
  },
  "runAfter": {}
}
```

---

## Demo Talking Points — Power Automate vs MCP

Use these when walking the customer through the side-by-side comparison:

| Dimension                  | Power Automate Flow ("Old Way")                       | Transcripts MCP Server                              |
|----------------------------|-------------------------------------------------------|------------------------------------------------------|
| **Steps to get a transcript** | 3 sequential HTTP calls + JSON parsing + response step | 1 tool call: `get_meeting_transcript` |
| **Auth model**             | App-only (client credentials) — **admin must grant access to ALL users' meetings** | Delegated OBO — only the signed-in user's meetings |
| **Meeting search**         | Exact subject match only (`$filter=subject eq '...'`) | Fuzzy/partial match via calendar view + client-side filter |
| **Who can find meetings**  | Only the meeting **organiser's** meetings (Graph API limitation on `/onlineMeetings`) | Any **attendee** — uses calendarView which sees all meetings on the user's calendar |
| **Transcript output**      | Raw VTT with timestamps, cue IDs, HTML tags           | Clean, speaker-attributed paragraphs — ready for LLM analysis |
| **Error handling**         | Must add Condition/Try-Catch for every step manually   | Built into the server with meaningful error messages |
| **Date filtering**         | `MeetingDate` input exists but isn't used in the API call (not supported by onlineMeetings filter) | Narrows calendarView window to the specific date |
| **Maintenance**            | Flow definition must be updated if Graph API changes   | Single server update, all agents get the fix |
| **Security posture**       | Client secret stored in flow (visible to editors)      | Secret in Azure Key Vault / Container Apps env vars |
| **Premium licensing**      | Requires **Power Automate Premium** (HTTP connector is premium) | No Power Automate license needed |

### The Killer Demo Moment

Run both side by side with the same meeting name:

1. **Power Automate** returns something like:
   ```
   WEBVTT

   0f4a6e2b-1234-5678-9abc-def012345678
   00:00:00.000 --> 00:00:05.520
   <v Alice Smith>So I think we should go with option B for the new design.</v>

   00:00:05.520 --> 00:00:08.960
   <v Alice Smith>It aligns better with what the customer asked for.</v>
   ```

2. **MCP Server** returns:
   ```
   Alice Smith: So I think we should go with option B for the new design. It aligns better with what the customer asked for.
   ```

The MCP output is immediately usable by an LLM for summarisation, sentiment analysis, or action item extraction. The Power Automate output needs additional processing that would require *even more* flow steps or a custom connector.

---

## What This Flow Can't Do (Without Significant Extra Work)

These features are built into the MCP server but would require additional flow actions, variables, loops, and conditions:

1. **List meetings with transcript availability** — Would need a `For Each` loop + nested HTTP call per meeting
2. **Partial/fuzzy name matching** — Would need calendarView + Filter Array + For Each + Resolve loop (5+ extra actions)
3. **VTT cleaning** — Would need either an Azure Function or an extremely complex `compose` + `replace` chain
4. **Save to SharePoint** — Would need site resolution + upload actions (2+ extra HTTP calls)
5. **Graceful error messages** — Would need Condition blocks after every HTTP action

---

## Alternative: CalendarView Approach (More Reliable, More Complex)

The MCP server uses `/me/calendarView` instead of `/onlineMeetings?$filter` because the filter API is unreliable and only works for meeting organisers. To replicate that in Power Automate, you'd need:

```
Step 1: GET /users/{userId}/calendarView?startDateTime=...&endDateTime=...
Step 2: Filter Array — subject contains MeetingName AND has Teams join URL
Step 3: GET /users/{userId}/onlineMeetings?$filter=JoinWebUrl eq '{joinUrl}'
Step 4: GET .../transcripts
Step 5: GET .../transcripts/{id}/content
Step 6: Respond
```

That's **5 HTTP calls + 1 Filter Array** action — and you'd still get raw VTT output. This is the approach to show if the customer asks *"but what if I'm not the organiser?"*
