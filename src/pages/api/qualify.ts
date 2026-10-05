export const prerender = false;

import type { APIRoute } from 'astro';
import { upsertContact, addContactTags, addContactNote, lookupContactByEmail } from '../../lib/ghl';
import { validateEmail, sanitizeString } from '../../lib/validation';
import type { APIResponse } from '../../lib/types';

const MAX_REQUESTS_PER_MINUTE = 5;
const requestLog = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const timestamps = requestLog.get(ip) ?? [];
  const recent = timestamps.filter((t) => now - t < windowMs);
  recent.push(now);
  requestLog.set(ip, recent);
  if (requestLog.size > 10_000) {
    for (const [key, val] of requestLog) {
      const filtered = val.filter((t) => now - t < windowMs);
      if (filtered.length === 0) requestLog.delete(key);
      else requestLog.set(key, filtered);
    }
  }
  return recent.length > MAX_REQUESTS_PER_MINUTE;
}

function getClientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

const ALLOWED_ORIGINS = [
  // TODO: Add your production domain(s)
  // 'https://yourdomain.com',
  // 'https://www.yourdomain.com',
];

function getCorsOrigin(request: Request): string {
  const origin = request.headers.get('origin') ?? '';
  if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
    return origin;
  }
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin') ?? '';
  if (!origin) return false;
  if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
    return true;
  }
  return ALLOWED_ORIGINS.includes(origin);
}

const MAX_BODY_SIZE = 16 * 1024;

function formatNote(responses: Record<string, string>): string {
  const date = new Date().toISOString().split('T')[0];
  const lines = [`--- Qualification (${date}) ---`];
  for (const [key, value] of Object.entries(responses)) {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    lines.push(`${label}: ${sanitizeString(String(value))}`);
  }
  return lines.join('\n');
}

export const POST: APIRoute = async ({ request, locals }) => {
  const corsOrigin = getCorsOrigin(request);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    'Vary': 'Origin',
  };

  if (!isAllowedOrigin(request)) {
    return new Response(JSON.stringify({ success: false, message: 'Forbidden' } satisfies APIResponse), { status: 403, headers });
  }

  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp)) {
    return new Response(JSON.stringify({ success: false, message: 'Too many requests.' } satisfies APIResponse), { status: 429, headers });
  }

  const contentLength = parseInt(request.headers.get('content-length') ?? '0', 10);
  if (contentLength > MAX_BODY_SIZE) {
    return new Response(JSON.stringify({ success: false, message: 'Request too large' } satisfies APIResponse), { status: 413, headers });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return new Response(JSON.stringify({ success: false, message: 'Content-Type must be application/json' } satisfies APIResponse), { status: 415, headers });
  }

  try {
    const body = await request.json();
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const responses = body.responses as Record<string, unknown> | undefined;

    if (!email || !validateEmail(email)) {
      return new Response(JSON.stringify({ success: false, message: 'Valid email required' } satisfies APIResponse), { status: 400, headers });
    }

    if (!responses || typeof responses !== 'object' || Object.keys(responses).length === 0) {
      return new Response(JSON.stringify({ success: false, message: 'Responses required' } satisfies APIResponse), { status: 400, headers });
    }

    // Sanitize all response values
    const cleanResponses: Record<string, string> = {};
    for (const [key, value] of Object.entries(responses)) {
      if (typeof value === 'string' && value.trim() !== '') {
        const cleanKey = sanitizeString(key).slice(0, 50);
        cleanResponses[cleanKey] = sanitizeString(String(value)).slice(0, 500);
      }
    }

    if (Object.keys(cleanResponses).length === 0) {
      return new Response(JSON.stringify({ success: false, message: 'Responses required' } satisfies APIResponse), { status: 400, headers });
    }

    // Get env vars
    const runtime = (locals as Record<string, unknown>).runtime as { env: Record<string, string> } | undefined;
    const apiKey = runtime?.env?.GHL_API_KEY || import.meta.env.GHL_API_KEY;
    const locationId = runtime?.env?.GHL_LOCATION_ID || import.meta.env.GHL_LOCATION_ID;

    if (!apiKey || !locationId) {
      const missing = [!apiKey && 'GHL_API_KEY', !locationId && 'GHL_LOCATION_ID'].filter(Boolean).join(', ');
      console.error(`Missing GHL environment variables: ${missing}`);
      return new Response(JSON.stringify({ success: false, message: 'Server configuration error' } satisfies APIResponse), { status: 500, headers });
    }

    // Upsert first (requires contacts.write scope), fall back to lookup
    let contactId: string | undefined;
    const upsert = await upsertContact({ email, locationId, source: 'Website' }, apiKey);
    if (upsert.success) {
      contactId = upsert.contactId;
    } else if (upsert.statusCode === 401 || upsert.statusCode === 403) {
      console.error('GHL authorization error — check API key scopes. Required: contacts.write');
      return new Response(JSON.stringify({ success: false, message: 'Server configuration error' } satisfies APIResponse), { status: 502, headers });
    }
    if (!contactId) {
      const lookup = await lookupContactByEmail(email, locationId, apiKey);
      if (lookup.success) contactId = lookup.contactId;
    }

    if (!contactId) {
      return new Response(JSON.stringify({ success: false, message: 'Could not find contact' } satisfies APIResponse), { status: 500, headers });
    }

    // Add qualification tag
    await addContactTags(contactId, ['form_qualify'], apiKey);

    // Add responses as a note
    const noteBody = formatNote(cleanResponses);
    await addContactNote(contactId, noteBody, apiKey);

    return new Response(JSON.stringify({ success: true, message: 'Qualification saved' } satisfies APIResponse), { status: 200, headers });
  } catch (error) {
    console.error('Qualify API error:', error instanceof Error ? error.message : 'Unknown error');
    return new Response(JSON.stringify({ success: false, message: 'Invalid request' } satisfies APIResponse), { status: 400, headers });
  }
};

export const OPTIONS: APIRoute = async ({ request }) => {
  const corsOrigin = getCorsOrigin(request);
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    },
  });
};
