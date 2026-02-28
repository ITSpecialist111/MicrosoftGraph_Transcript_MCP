/**
 * Transcripts MCP Server
 *
 * A remote MCP server hosted on Azure App Service that provides
 * Microsoft Teams meeting transcript retrieval via Microsoft Graph API.
 *
 * Transport: Streamable HTTP (stateless - one Server per request)
 * Auth:      OAuth 2.0 On-Behalf-Of (OBO) delegated flow
 *
 * Tools exposed:
 *   - list_recent_meetings    -> Discovery of meetings with transcript/recording availability
 *   - get_meeting_transcript  -> Full multi-hop retrieval + VTT cleaning (with optional timestamps)
 *   - get_meeting_recording   -> Recording metadata + download URL for a meeting
 *   - get_meeting_insights    -> AI-generated summaries, action items, and mentions (Copilot)
 *   - get_adhoc_transcript    -> Transcript retrieval for ad hoc calls (PSTN, 1:1, group)
 *   - save_transcript         -> Retrieve + clean + upload to SharePoint
 */

import express, { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { extractBearerToken, getGraphTokenOBO } from './auth';
import {
  listMeetings,
  listTranscripts,
  getTranscriptContent,
  getTranscriptMetadataContent,
  findMeetingsByName,
  resolveSiteId,
  uploadToSharePoint,
  listRecordings,
  getRecordingContentUrl,
  getCurrentUserId,
  getMeetingAiInsights,
  listAdhocCallTranscripts,
  getAdhocTranscriptContent,
  getAdhocTranscriptMetadataContent,
} from './graph';
import {
  cleanVttTranscript,
  parseMetadataContent,
  formatMetadataAsTimestamped,
  formatMetadataAsPlain,
} from './vtt-parser';

// -- Tool Definitions -------------------------------------------------------

const TOOLS = [
  {
    name: 'list_recent_meetings',
    description:
      'List recent Microsoft Teams online meetings for the signed-in user. ' +
      'Optionally filter by date (ISO format: YYYY-MM-DD) and limit results. ' +
      'Returns meeting subject, start/end times, and whether transcripts and recordings are available.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'Filter meetings to this date (YYYY-MM-DD). If omitted, returns recent meetings across all dates.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of meetings to return (default: 10, max: 50).',
        },
      },
      required: [] as string[],
    },
  },
  {
    name: 'get_meeting_transcript',
    description:
      'Retrieve the cleaned transcript for a Microsoft Teams meeting. ' +
      'Searches by name (subject) and optionally by date, then downloads ' +
      'and pre-processes the transcript. ' +
      'Set includeTimestamps to true to get per-utterance ISO timestamps and spoken language. ' +
      'Returns plain-text speaker-attributed dialogue ready for AI analysis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        meetingName: {
          type: 'string',
          description: 'The name (subject) of the meeting to search for. Partial matches are supported.',
        },
        meetingDate: {
          type: 'string',
          description: 'Date of the meeting in YYYY-MM-DD format. Helps narrow results.',
        },
        includeTimestamps: {
          type: 'boolean',
          description: 'If true, returns timestamped utterances with ISO datetime and spoken language detection. Default: false.',
        },
      },
      required: ['meetingName'],
    },
  },
  {
    name: 'get_meeting_recording',
    description:
      'Get recording information for a Microsoft Teams meeting. ' +
      'Searches by name (subject) and optionally by date. ' +
      'Returns recording metadata including a content URL that can be used to download the .mp4 file, ' +
      'and the contentCorrelationId that links the recording to its corresponding transcript.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        meetingName: {
          type: 'string',
          description: 'The name (subject) of the meeting to search for. Partial matches are supported.',
        },
        meetingDate: {
          type: 'string',
          description: 'Date of the meeting in YYYY-MM-DD format. Helps narrow results.',
        },
      },
      required: ['meetingName'],
    },
  },
  {
    name: 'get_meeting_insights',
    description:
      'Get AI-generated meeting insights powered by Microsoft 365 Copilot. ' +
      'Returns structured meeting notes (summaries with subpoints), ' +
      'action items (with assigned owners), and participant mention events. ' +
      'Requires the signed-in user to have a Microsoft 365 Copilot license. ' +
      'Insights are available after the meeting ends (may take up to 4 hours).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        meetingName: {
          type: 'string',
          description: 'The name (subject) of the meeting to search for. Partial matches are supported.',
        },
        meetingDate: {
          type: 'string',
          description: 'Date of the meeting in YYYY-MM-DD format. Helps narrow results.',
        },
      },
      required: ['meetingName'],
    },
  },
  {
    name: 'get_adhoc_transcript',
    description:
      'Retrieve the transcript for an ad hoc call (PSTN, 1:1, or group call). ' +
      'Unlike scheduled meetings, ad hoc calls are not discoverable via calendar — ' +
      'you must provide the call ID directly. ' +
      'Set includeTimestamps to true for per-utterance ISO timestamps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        callId: {
          type: 'string',
          description: 'The unique identifier for the ad hoc call.',
        },
        includeTimestamps: {
          type: 'boolean',
          description: 'If true, returns timestamped utterances. Default: false.',
        },
      },
      required: ['callId'],
    },
  },
  {
    name: 'save_transcript',
    description:
      'Retrieve a meeting transcript and save it to a SharePoint document library. ' +
      'The transcript is cleaned (VTT metadata stripped) and uploaded as a Markdown file ' +
      'with speaker attribution, ready for RAG indexing, compliance archival, or further processing. ' +
      'Also returns the transcript text in the response for immediate use.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        meetingName: {
          type: 'string',
          description: 'The name (subject) of the meeting to search for. Partial matches are supported.',
        },
        meetingDate: {
          type: 'string',
          description: 'Date of the meeting in YYYY-MM-DD format. Helps narrow results.',
        },
        siteUrl: {
          type: 'string',
          description: 'SharePoint site URL (e.g. "contoso.sharepoint.com/sites/Meetings"). This should come from your agent instructions or the user\'s request.',
        },
        folderPath: {
          type: 'string',
          description: 'Folder path within the document library (e.g. "Meeting Transcripts/2026"). Defaults to "Meeting Transcripts" if not specified.',
        },
      },
      required: ['meetingName', 'siteUrl'],
    },
  },
];

// -- Tool Handlers -----------------------------------------------------------

async function handleListRecentMeetings(
  graphToken: string,
  args: Record<string, unknown>
) {
  const date = args.date as string | undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 10;
  const top = Math.min(limit, 50);

  const meetings = await listMeetings(graphToken, { top, filterDate: date });

  if (meetings.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: date ? 'No meetings found for ' + date + '.' : 'No recent meetings found.',
        },
      ],
    };
  }

  const results = await Promise.all(
    meetings.map(async (m) => {
      let hasTranscript = false;
      let hasRecording = false;
      try {
        const transcripts = await listTranscripts(graphToken, m.id);
        hasTranscript = transcripts.length > 0;
      } catch {
        // Transcript check failed
      }
      try {
        const recordings = await listRecordings(graphToken, m.id);
        hasRecording = recordings.length > 0;
      } catch {
        // Recording check failed
      }
      return {
        subject: m.subject || '(No subject)',
        startDateTime: m.startDateTime,
        endDateTime: m.endDateTime,
        meetingId: m.id,
        hasTranscript,
        hasRecording,
      };
    })
  );

  const text = results
    .map(
      (r, i) =>
        (i + 1) + '. **' + r.subject + '**\n' +
        '   Start: ' + r.startDateTime + '\n' +
        '   End: ' + r.endDateTime + '\n' +
        '   Transcript: ' + (r.hasTranscript ? 'Available' : 'Not available') + '\n' +
        '   Recording: ' + (r.hasRecording ? 'Available' : 'Not available') + '\n' +
        '   Meeting ID: ' + r.meetingId
    )
    .join('\n\n');

  return { content: [{ type: 'text' as const, text }] };
}

async function handleGetMeetingTranscript(
  graphToken: string,
  args: Record<string, unknown>
) {
  const meetingName = args.meetingName as string;
  const meetingDate = args.meetingDate as string | undefined;
  const includeTimestamps = args.includeTimestamps === true;

  if (!meetingName) {
    return {
      content: [{ type: 'text' as const, text: 'meetingName is required.' }],
      isError: true,
    };
  }

  const meetings = await findMeetingsByName(graphToken, meetingName, meetingDate);

  if (meetings.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'No meeting found matching "' + meetingName + '"' +
            (meetingDate ? ' on ' + meetingDate : '') +
            '. Try broadening your search term or checking the date.',
        },
      ],
    };
  }

  const meeting = meetings[0];

  const transcripts = await listTranscripts(graphToken, meeting.id);
  if (transcripts.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Meeting "' + meeting.subject + '" was found (' + meeting.startDateTime +
            ') but has no transcript available. Ensure transcription was enabled during the meeting.',
        },
      ],
    };
  }

  let cleanText: string;

  if (includeTimestamps) {
    // Use metadataContent for timestamped output with language detection
    try {
      const metadataJson = await getTranscriptMetadataContent(graphToken, meeting.id, transcripts[0].id);
      const utterances = parseMetadataContent(metadataJson);
      cleanText = formatMetadataAsTimestamped(utterances);
    } catch {
      // Fall back to standard VTT if metadataContent is unavailable
      const rawVtt = await getTranscriptContent(graphToken, meeting.id, transcripts[0].id);
      cleanText = cleanVttTranscript(rawVtt);
      cleanText = '(Note: timestamped metadata was unavailable; falling back to standard transcript.)\n\n' + cleanText;
    }
  } else {
    // Default: clean VTT with speaker attribution, no timestamps
    const rawVtt = await getTranscriptContent(graphToken, meeting.id, transcripts[0].id);
    cleanText = cleanVttTranscript(rawVtt);
  }

  const header = 'Meeting: ' + meeting.subject + '\nDate: ' + meeting.startDateTime + '\n' +
    'Transcript URL: ' + transcripts[0].transcriptContentUrl + '\n' +
    'Transcript created: ' + transcripts[0].createdDateTime + '\n' +
    '---\n\n';

  return { content: [{ type: 'text' as const, text: header + cleanText }] };
}

async function handleGetMeetingRecording(
  graphToken: string,
  args: Record<string, unknown>
) {
  const meetingName = args.meetingName as string;
  const meetingDate = args.meetingDate as string | undefined;

  if (!meetingName) {
    return {
      content: [{ type: 'text' as const, text: 'meetingName is required.' }],
      isError: true,
    };
  }

  const meetings = await findMeetingsByName(graphToken, meetingName, meetingDate);
  if (meetings.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'No meeting found matching "' + meetingName + '"' +
            (meetingDate ? ' on ' + meetingDate : '') + '.',
        },
      ],
    };
  }

  const meeting = meetings[0];
  const recordings = await listRecordings(graphToken, meeting.id);

  if (recordings.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Meeting "' + meeting.subject + '" was found (' + meeting.startDateTime +
            ') but has no recording available.',
        },
      ],
    };
  }

  const results = await Promise.all(
    recordings.map(async (rec) => {
      let contentUrl: string | null = null;
      try {
        contentUrl = await getRecordingContentUrl(graphToken, meeting.id, rec.id);
      } catch {
        // Content URL retrieval failed
      }
      return {
        id: rec.id,
        createdDateTime: rec.createdDateTime,
        endDateTime: rec.endDateTime,
        contentCorrelationId: rec.contentCorrelationId,
        contentUrl,
      };
    })
  );

  const text = 'Meeting: ' + meeting.subject + '\nDate: ' + meeting.startDateTime + '\n---\n\n' +
    results
      .map(
        (r, i) =>
          (i + 1) + '. **Recording ' + r.id + '**\n' +
          '   Created: ' + r.createdDateTime + '\n' +
          '   Ended: ' + (r.endDateTime || 'N/A') + '\n' +
          '   Correlation ID: ' + (r.contentCorrelationId || 'N/A') + '\n' +
          '   Content URL: ' + (r.contentUrl || 'Unavailable')
      )
      .join('\n\n');

  return { content: [{ type: 'text' as const, text }] };
}

async function handleGetMeetingInsights(
  graphToken: string,
  args: Record<string, unknown>
) {
  const meetingName = args.meetingName as string;
  const meetingDate = args.meetingDate as string | undefined;

  if (!meetingName) {
    return {
      content: [{ type: 'text' as const, text: 'meetingName is required.' }],
      isError: true,
    };
  }

  const meetings = await findMeetingsByName(graphToken, meetingName, meetingDate);
  if (meetings.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'No meeting found matching "' + meetingName + '"' +
            (meetingDate ? ' on ' + meetingDate : '') + '.',
        },
      ],
    };
  }

  const meeting = meetings[0];

  // AI Insights require the user's ID for the /copilot path
  const userId = await getCurrentUserId(graphToken);
  const insights = await getMeetingAiInsights(graphToken, userId, meeting.id);

  if (!insights) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'No AI insights available for "' + meeting.subject + '". ' +
            'This may mean the meeting is still processing, ended less than 4 hours ago, ' +
            'or the signed-in user does not have a Microsoft 365 Copilot license.',
        },
      ],
    };
  }

  let text = 'Meeting: ' + meeting.subject + '\nDate: ' + meeting.startDateTime + '\n---\n\n';

  // Meeting notes / summaries
  if (insights.meetingNotes && insights.meetingNotes.length > 0) {
    text += '## Meeting Notes\n\n';
    for (const note of insights.meetingNotes) {
      text += '- ' + note.title + '\n';
      if (note.subpoints && note.subpoints.length > 0) {
        for (const sub of note.subpoints) {
          text += '  - ' + sub + '\n';
        }
      }
    }
    text += '\n';
  }

  // Action items
  if (insights.actionItems && insights.actionItems.length > 0) {
    text += '## Action Items\n\n';
    for (const item of insights.actionItems) {
      text += '- [ ] ' + item.text;
      if (item.ownerDisplayName) {
        text += ' _(assigned to ' + item.ownerDisplayName + ')_';
      }
      text += '\n';
    }
    text += '\n';
  }

  // Mention events
  if (insights.viewpoint?.mentionEvents && insights.viewpoint.mentionEvents.length > 0) {
    text += '## You Were Mentioned\n\n';
    for (const mention of insights.viewpoint.mentionEvents) {
      const mentionedByName = mention.speaker?.user?.displayName || 'Unknown';
      text += '- Mentioned by ' + mentionedByName +
        ' at ' + (mention.eventDateTime || 'unknown time') + '\n';
    }
    text += '\n';
  }

  return { content: [{ type: 'text' as const, text }] };
}

async function handleGetAdhocTranscript(
  graphToken: string,
  args: Record<string, unknown>
) {
  const callId = args.callId as string;
  const includeTimestamps = args.includeTimestamps === true;

  if (!callId) {
    return {
      content: [{ type: 'text' as const, text: 'callId is required.' }],
      isError: true,
    };
  }

  const transcripts = await listAdhocCallTranscripts(graphToken, callId);
  if (transcripts.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'No transcript found for ad hoc call "' + callId + '". ' +
            'Ensure the call had transcription enabled and that the call ID is correct.',
        },
      ],
    };
  }

  const transcriptId = transcripts[0].id;
  let cleanText: string;

  if (includeTimestamps) {
    try {
      const metadataJson = await getAdhocTranscriptMetadataContent(graphToken, callId, transcriptId);
      const utterances = parseMetadataContent(metadataJson);
      cleanText = formatMetadataAsTimestamped(utterances);
    } catch {
      const rawVtt = await getAdhocTranscriptContent(graphToken, callId, transcriptId);
      cleanText = cleanVttTranscript(rawVtt);
      cleanText = '(Note: timestamped metadata was unavailable; falling back to standard transcript.)\n\n' + cleanText;
    }
  } else {
    const rawVtt = await getAdhocTranscriptContent(graphToken, callId, transcriptId);
    cleanText = cleanVttTranscript(rawVtt);
  }

  const header = 'Ad Hoc Call: ' + callId + '\n' +
    'Transcript created: ' + transcripts[0].createdDateTime + '\n' +
    '---\n\n';

  return { content: [{ type: 'text' as const, text: header + cleanText }] };
}

async function handleSaveTranscript(
  graphToken: string,
  args: Record<string, unknown>
) {
  const meetingName = args.meetingName as string;
  const meetingDate = args.meetingDate as string | undefined;
  const siteUrl = args.siteUrl as string;
  const folderPath = (args.folderPath as string) || 'Meeting Transcripts';

  if (!meetingName) {
    return {
      content: [{ type: 'text' as const, text: 'meetingName is required.' }],
      isError: true,
    };
  }

  if (!siteUrl) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'siteUrl is required. The agent instructions should specify the SharePoint site URL to save transcripts to.',
        },
      ],
      isError: true,
    };
  }

  // 1. Find the meeting
  const meetings = await findMeetingsByName(graphToken, meetingName, meetingDate);
  if (meetings.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'No meeting found matching "' + meetingName + '"' +
            (meetingDate ? ' on ' + meetingDate : '') +
            '. Try broadening your search term or checking the date.',
        },
      ],
    };
  }

  const meeting = meetings[0];

  // 2. Get the transcript
  const transcripts = await listTranscripts(graphToken, meeting.id);
  if (transcripts.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Meeting "' + meeting.subject + '" was found but has no transcript available.',
        },
      ],
    };
  }

  const rawVtt = await getTranscriptContent(graphToken, meeting.id, transcripts[0].id);
  const cleanText = cleanVttTranscript(rawVtt);

  // 3. Build the Markdown file content
  const meetingDateStr = meeting.startDateTime.split('T')[0];
  const mdContent =
    '# ' + meeting.subject + '\n\n' +
    '**Date:** ' + meeting.startDateTime + '\n\n' +
    '**Meeting ID:** ' + meeting.id + '\n\n' +
    '---\n\n' +
    cleanText;

  // 4. Generate filename: sanitise subject, add date
  const safeSubject = meeting.subject
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 80);
  const fileName = `${safeSubject}_${meetingDateStr}.md`;

  // 5. Resolve SharePoint site and upload
  const siteId = await resolveSiteId(graphToken, siteUrl);
  const webUrl = await uploadToSharePoint(graphToken, siteId, folderPath, fileName, mdContent);

  const header = 'Meeting: ' + meeting.subject + '\nDate: ' + meeting.startDateTime + '\n';
  const summary =
    '\n---\n\n' +
    '**Saved to SharePoint:** ' + webUrl + '\n' +
    '**File:** ' + fileName + '\n' +
    '**Folder:** ' + folderPath + '\n\n' +
    '---\n\n';

  return {
    content: [
      {
        type: 'text' as const,
        text: header + summary + cleanText,
      },
    ],
  };
}

// -- Express App -------------------------------------------------------------

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'transcripts-mcp-server' });
});

// -- MCP Endpoint ------------------------------------------------------------

app.post('/mcp', async (req: Request, res: Response) => {
  try {
    const userToken = extractBearerToken(req.headers.authorization);
    if (!userToken) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Missing or invalid Authorization header. Provide a Bearer token.' },
        id: null,
      });
      return;
    }

    let graphToken: string;
    try {
      graphToken = await getGraphTokenOBO(userToken);
    } catch (authErr: any) {
      console.error('[AUTH] OBO token exchange failed:', authErr.message);
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Authentication failed: ' + authErr.message },
        id: null,
      });
      return;
    }

    const server = new Server(
      { name: 'transcripts-mcp-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const toolArgs = (args ?? {}) as Record<string, unknown>;

      try {
        switch (name) {
          case 'list_recent_meetings':
            return await handleListRecentMeetings(graphToken, toolArgs);
          case 'get_meeting_transcript':
            return await handleGetMeetingTranscript(graphToken, toolArgs);
          case 'get_meeting_recording':
            return await handleGetMeetingRecording(graphToken, toolArgs);
          case 'get_meeting_insights':
            return await handleGetMeetingInsights(graphToken, toolArgs);
          case 'get_adhoc_transcript':
            return await handleGetAdhocTranscript(graphToken, toolArgs);
          case 'save_transcript':
            return await handleSaveTranscript(graphToken, toolArgs);
          default:
            return {
              content: [{ type: 'text' as const, text: 'Unknown tool: ' + name }],
              isError: true,
            };
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + err.message }],
          isError: true,
        };
      }
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    console.error('[MCP] Unhandled error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST.' },
    id: null,
  });
});

app.delete('/mcp', (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Sessions not supported.' },
    id: null,
  });
});

const PORT = parseInt(process.env.PORT || '8080', 10);

app.listen(PORT, () => {
  console.log('[MCP] Transcripts MCP Server running on port ' + PORT);
  console.log('[MCP] Endpoint: POST /mcp');
  console.log('[MCP] Health:   GET /health');
});
