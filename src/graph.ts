/**
 * Microsoft Graph API Client
 *
 * Implements the multi-hop chain for transcript retrieval:
 *   1. GET /me/calendarView             → find Teams calendar events
 *   2. GET /me/onlineMeetings?$filter=JoinWebUrl eq '...' → resolve meeting ID
 *   3. GET /me/onlineMeetings/{id}/transcripts  → find transcript IDs
 *   4. GET /me/onlineMeetings/{id}/transcripts/{tid}/content → download VTT
 *
 * All calls use the delegated Graph token obtained via OBO.
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ── Types ───────────────────────────────────────────────────────────

export interface OnlineMeeting {
  id: string;
  subject: string;
  startDateTime: string;
  endDateTime: string;
  joinWebUrl: string;
}

export interface TranscriptInfo {
  id: string;
  meetingId: string;
  createdDateTime: string;
}

interface CalendarEvent {
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isOnlineMeeting: boolean;
  onlineMeeting?: { joinUrl: string };
}

// ── Graph Helpers ───────────────────────────────────────────────────

async function graphGet(url: string, accessToken: string, accept?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: accept || 'application/json',
    Prefer: 'outlook.timezone="UTC"',
  };
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API ${res.status}: ${body}`);
  }
  return res;
}

/**
 * Resolve a Teams join URL to an onlineMeeting object.
 */
async function resolveOnlineMeeting(
  accessToken: string,
  joinUrl: string
): Promise<OnlineMeeting | null> {
  const filter = `JoinWebUrl eq '${joinUrl}'`;
  const url = `${GRAPH_BASE}/me/onlineMeetings?$filter=${encodeURIComponent(filter)}`;
  try {
    const res = await graphGet(url, accessToken);
    const data = await res.json() as { value: OnlineMeeting[] };
    return data.value?.[0] ?? null;
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * List the user's recent Teams meetings using the Calendar API.
 *
 * Uses /me/calendarView to find calendar events that are online meetings,
 * then resolves each to an onlineMeeting object to get the meeting ID
 * needed for transcript retrieval.
 */
export async function listMeetings(
  accessToken: string,
  options?: {
    top?: number;
    filterDate?: string; // ISO date string, e.g. "2026-02-17"
  }
): Promise<OnlineMeeting[]> {
  const limit = options?.top ?? 10;

  // Build calendarView date range
  let startDT: string;
  let endDT: string;
  if (options?.filterDate) {
    startDT = `${options.filterDate}T00:00:00Z`;
    endDT = `${options.filterDate}T23:59:59Z`;
  } else {
    const now = new Date();
    const since = new Date();
    since.setDate(since.getDate() - 30);
    startDT = since.toISOString();
    endDT = now.toISOString();
  }

  // calendarView supports $top, $orderby, $select — but NOT $filter on isOnlineMeeting
  const params = new URLSearchParams({
    startDateTime: startDT,
    endDateTime: endDT,
    $select: 'id,subject,start,end,onlineMeeting',
    $orderby: 'start/dateTime desc',
    $top: String(Math.min(limit * 3, 100)), // fetch extra to account for non-Teams meetings
  });

  const url = `${GRAPH_BASE}/me/calendarView?${params.toString()}`;
  const res = await graphGet(url, accessToken);
  const data = await res.json() as { value: CalendarEvent[] };

  // Filter client-side to events that have a Teams join URL
  const teamsMeetings = (data.value || []).filter(
    (e) => e.onlineMeeting?.joinUrl
  );

  // Resolve each calendar event to an onlineMeeting object (need the meeting ID for transcripts)
  const resolved: OnlineMeeting[] = [];
  for (const event of teamsMeetings) {
    if (resolved.length >= limit) break;
    const meeting = await resolveOnlineMeeting(accessToken, event.onlineMeeting!.joinUrl);
    if (meeting) {
      // Use the calendar event subject as it's more reliable
      meeting.subject = meeting.subject || event.subject;
      resolved.push(meeting);
    }
  }

  return resolved;
}

/**
 * List transcripts available for a specific online meeting.
 */
export async function listTranscripts(
  accessToken: string,
  meetingId: string
): Promise<TranscriptInfo[]> {
  const url = `${GRAPH_BASE}/me/onlineMeetings/${meetingId}/transcripts`;
  const res = await graphGet(url, accessToken);
  const data = await res.json() as { value: TranscriptInfo[] };
  return (data.value || []).map((t) => ({
    ...t,
    meetingId,
  }));
}

/**
 * Download the raw VTT content of a transcript.
 */
export async function getTranscriptContent(
  accessToken: string,
  meetingId: string,
  transcriptId: string
): Promise<string> {
  const url = `${GRAPH_BASE}/me/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=text/vtt`;
  const res = await graphGet(url, accessToken, 'text/vtt');
  return res.text();
}

/**
 * Find meetings whose subject matches a search term (case-insensitive).
 * Uses Calendar API to search through events, then resolves to online meetings.
 */
export async function findMeetingsByName(
  accessToken: string,
  meetingName: string,
  meetingDate?: string
): Promise<OnlineMeeting[]> {
  // Fetch a broader set to search through
  const meetings = await listMeetings(accessToken, {
    top: 50,
    filterDate: meetingDate,
  });

  const needle = meetingName.toLowerCase();
  return meetings.filter((m) =>
    m.subject?.toLowerCase().includes(needle)
  );
}
