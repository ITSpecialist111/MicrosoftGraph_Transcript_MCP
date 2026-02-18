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
 * Non-throwing GET that returns the parsed JSON or null on error.
 */
async function graphGetSafe<T>(url: string, accessToken: string): Promise<T | null> {
  try {
    const res = await graphGet(url, accessToken);
    return (await res.json()) as T;
  } catch (err) {
    console.error('[graph] GET failed:', url.replace(/\?.*/, '?...'), String(err));
    return null;
  }
}

/**
 * Fetch the calendarView events for a date range.
 * Returns raw calendar events (before any filtering/resolution).
 */
async function fetchCalendarEvents(
  accessToken: string,
  startDT: string,
  endDT: string,
  maxEvents: number
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    startDateTime: startDT,
    endDateTime: endDT,
    $select: 'id,subject,start,end,isOnlineMeeting,onlineMeeting',
    $orderby: 'start/dateTime desc',
    $top: String(Math.min(maxEvents, 100)),
  });

  const url = `${GRAPH_BASE}/me/calendarView?${params.toString()}`;
  console.log('[graph] calendarView request:', startDT, '→', endDT);
  const data = await graphGetSafe<{ value: CalendarEvent[] }>(url, accessToken);
  const events = data?.value || [];
  console.log(`[graph] calendarView returned ${events.length} events`);
  return events;
}

/**
 * Build the calendarView date range from options.
 */
function buildDateRange(filterDate?: string): { startDT: string; endDT: string } {
  if (filterDate) {
    return {
      startDT: `${filterDate}T00:00:00Z`,
      endDT: `${filterDate}T23:59:59Z`,
    };
  }
  // Default: 30 days back and 7 days forward
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const ahead = new Date();
  ahead.setDate(ahead.getDate() + 7);
  return { startDT: since.toISOString(), endDT: ahead.toISOString() };
}

/**
 * Resolve a Teams join URL to an onlineMeeting object.
 * Tries the exact URL first, then the decoded variant.
 */
async function resolveOnlineMeeting(
  accessToken: string,
  joinUrl: string
): Promise<OnlineMeeting | null> {
  // Try with the URL as-is
  const result = await tryResolveByJoinUrl(accessToken, joinUrl);
  if (result) return result;

  // Some Graph tenants store the decoded URL; try decoding once
  const decoded = decodeURIComponent(joinUrl);
  if (decoded !== joinUrl) {
    const result2 = await tryResolveByJoinUrl(accessToken, decoded);
    if (result2) return result2;
  }

  console.warn(`[graph] Could not resolve onlineMeeting for joinUrl: ${joinUrl}`);
  return null;
}

async function tryResolveByJoinUrl(
  accessToken: string,
  joinUrl: string
): Promise<OnlineMeeting | null> {
  const filter = `JoinWebUrl eq '${joinUrl}'`;
  const url = `${GRAPH_BASE}/me/onlineMeetings?$filter=${encodeURIComponent(filter)}`;
  const data = await graphGetSafe<{ value: OnlineMeeting[] }>(url, accessToken);
  return data?.value?.[0] ?? null;
}

/**
 * Convert a CalendarEvent into an OnlineMeeting by resolving via the
 * onlineMeetings API. Returns null only if the event has no join URL.
 */
async function resolveCalendarEvent(
  accessToken: string,
  event: CalendarEvent
): Promise<OnlineMeeting | null> {
  const joinUrl = event.onlineMeeting?.joinUrl;
  if (!joinUrl) return null;

  const meeting = await resolveOnlineMeeting(accessToken, joinUrl);
  if (meeting) {
    // Always prefer the calendar event subject — it's what the user sees
    meeting.subject = event.subject || meeting.subject;
    return meeting;
  }

  // Resolution failed — log it but return null (no meeting ID = can't fetch transcripts)
  console.warn(`[graph] Resolution failed for "${event.subject}" (${joinUrl})`);
  return null;
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
  const { startDT, endDT } = buildDateRange(options?.filterDate);

  const events = await fetchCalendarEvents(
    accessToken, startDT, endDT,
    Math.min(limit * 3, 100)
  );

  // Filter client-side to events that have a Teams join URL
  const teamsMeetings = events.filter((e) => e.onlineMeeting?.joinUrl);
  console.log(`[graph] ${teamsMeetings.length} of ${events.length} events have a Teams join URL`);

  // Resolve each calendar event to an onlineMeeting object
  const resolved: OnlineMeeting[] = [];
  for (const event of teamsMeetings) {
    if (resolved.length >= limit) break;
    const meeting = await resolveCalendarEvent(accessToken, event);
    if (meeting) {
      resolved.push(meeting);
    }
  }

  console.log(`[graph] Resolved ${resolved.length} online meetings`);
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
 *
 * Optimised flow: fetches calendar events, filters by name FIRST (cheap),
 * then resolves only the matching events to online meetings (expensive).
 * This avoids calling resolveOnlineMeeting for irrelevant events.
 */
export async function findMeetingsByName(
  accessToken: string,
  meetingName: string,
  meetingDate?: string
): Promise<OnlineMeeting[]> {
  const { startDT, endDT } = buildDateRange(meetingDate);

  // Fetch a broad set of calendar events
  const events = await fetchCalendarEvents(accessToken, startDT, endDT, 100);

  // Filter by subject name first (before expensive onlineMeeting resolution)
  const needle = meetingName.toLowerCase();
  const nameMatches = events.filter(
    (e) => e.subject?.toLowerCase().includes(needle) && e.onlineMeeting?.joinUrl
  );

  console.log(
    `[graph] findMeetingsByName("${meetingName}"): ${nameMatches.length} name matches ` +
    `out of ${events.length} events (subjects: ${events.map(e => e.subject).join(', ')})`
  );

  if (nameMatches.length === 0) {
    // No name matches — log all event subjects for debugging
    console.warn(
      `[graph] No name match for "${meetingName}". Available subjects: ` +
      events.map((e) => `"${e.subject}"`).join(', ')
    );
    return [];
  }

  // Resolve only the matching events
  const resolved: OnlineMeeting[] = [];
  for (const event of nameMatches) {
    const meeting = await resolveCalendarEvent(accessToken, event);
    if (meeting) {
      resolved.push(meeting);
    }
  }

  console.log(`[graph] findMeetingsByName resolved ${resolved.length} meetings`);
  return resolved;
}
