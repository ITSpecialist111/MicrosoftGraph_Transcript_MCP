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
 *   - list_recent_meetings   -> Discovery of meetings with transcript availability
 *   - get_meeting_transcript -> Full multi-hop retrieval + VTT cleaning
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
  findMeetingsByName,
} from './graph';
import { cleanVttTranscript } from './vtt-parser';

// -- Tool Definitions -------------------------------------------------------

const TOOLS = [
  {
    name: 'list_recent_meetings',
    description:
      'List recent Microsoft Teams online meetings for the signed-in user. ' +
      'Optionally filter by date (ISO format: YYYY-MM-DD) and limit results. ' +
      'Returns meeting subject, start/end times, and whether transcripts are available.',
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
      'and pre-processes the VTT transcript, stripping all timestamps and metadata. ' +
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
      },
      required: ['meetingName'],
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
      try {
        const transcripts = await listTranscripts(graphToken, m.id);
        hasTranscript = transcripts.length > 0;
      } catch {
        // Transcript check failed
      }
      return {
        subject: m.subject || '(No subject)',
        startDateTime: m.startDateTime,
        endDateTime: m.endDateTime,
        meetingId: m.id,
        hasTranscript,
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

  const rawVtt = await getTranscriptContent(graphToken, meeting.id, transcripts[0].id);
  const cleanText = cleanVttTranscript(rawVtt);

  const header = 'Meeting: ' + meeting.subject + '\nDate: ' + meeting.startDateTime + '\n---\n\n';

  return { content: [{ type: 'text' as const, text: header + cleanText }] };
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
