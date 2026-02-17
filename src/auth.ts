/**
 * MSAL Authentication Module — On-Behalf-Of (OBO) Flow
 *
 * Exchanges an incoming user assertion token for a Microsoft Graph
 * access token using the OAuth 2.0 OBO flow. This ensures the MCP
 * server only accesses data the signed-in user is allowed to see
 * (delegated permissions, not application-level "god mode").
 */

import {
  ConfidentialClientApplication,
  Configuration,
  OnBehalfOfRequest,
} from '@azure/msal-node';

// ── Configuration ───────────────────────────────────────────────────
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || '';
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || '';
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || '';

if (!AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET || !AZURE_TENANT_ID) {
  console.warn(
    '[AUTH] Missing one or more required env vars: AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID'
  );
}

const msalConfig: Configuration = {
  auth: {
    clientId: AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${AZURE_TENANT_ID}`,
    clientSecret: AZURE_CLIENT_SECRET,
  },
};

const cca = new ConfidentialClientApplication(msalConfig);

// The Graph scopes we need for meeting transcript retrieval
const GRAPH_SCOPES = [
  'https://graph.microsoft.com/OnlineMeetings.Read',
  'https://graph.microsoft.com/OnlineMeetingTranscript.Read.All',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Calendars.Read',
];

// ── Public API ──────────────────────────────────────────────────────

/**
 * Exchange an incoming user assertion (bearer token from Copilot Studio)
 * for a Graph access token via the OBO flow.
 *
 * @param userAssertion - The bearer token received in the Authorization header
 * @returns A valid Microsoft Graph access token
 */
export async function getGraphTokenOBO(userAssertion: string): Promise<string> {
  const oboRequest: OnBehalfOfRequest = {
    oboAssertion: userAssertion,
    scopes: GRAPH_SCOPES,
  };

  const result = await cca.acquireTokenOnBehalfOf(oboRequest);

  if (!result || !result.accessToken) {
    throw new Error('OBO token exchange failed — no access token returned');
  }

  return result.accessToken;
}

/**
 * Extract bearer token from an Authorization header value.
 * Returns null if not present or malformed.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1];
  }
  return null;
}
