// Netlify event-triggered function: fires on every form submission
// Creates a tentative Google Calendar event for booking requests
// Uses Web Crypto API to sign JWT — zero npm dependencies

const TIME_WINDOWS = {
  'morning': { start: '08:00', end: '10:00' },
  'late-morning': { start: '10:00', end: '12:00' },
  'afternoon': { start: '13:00', end: '15:00' },
  'late-afternoon': { start: '15:00', end: '17:00' },
};

function base64url(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncodeJSON(obj) {
  return base64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function getAccessToken(serviceEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceEmail,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = base64urlEncodeJSON(header);
  const payloadB64 = base64urlEncodeJSON(payload);
  const unsignedToken = headerB64 + '.' + payloadB64;

  // Import the private key
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const keyBuffer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const jwt = unsignedToken + '.' + base64url(signature);

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`);
  }

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

async function createCalendarEvent(accessToken, calendarId, event) {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Calendar API failed (${res.status}): ${errText}`);
  }

  return res.json();
}

export default async function handler(event) {
  const { payload } = JSON.parse(event.body);

  // Only handle the booking form
  if (payload.form_name !== 'booking') {
    return { statusCode: 200, body: 'Not a booking form — skipped' };
  }

  const data = payload.data;
  const preferredDate = data['preferred-date'];
  const timeWindow = data['time-window'];

  // Need both date and time window to create a calendar event
  if (!preferredDate || !timeWindow || !TIME_WINDOWS[timeWindow]) {
    console.log('Missing preferred-date or time-window, skipping calendar event');
    return { statusCode: 200, body: 'Missing date/time — skipped calendar event' };
  }

  const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  if (!serviceEmail || !privateKey || !calendarId) {
    console.log('Google Calendar env vars not configured — skipping calendar event');
    return { statusCode: 200, body: 'Calendar not configured' };
  }

  const window = TIME_WINDOWS[timeWindow];
  const name = data['full-name'] || 'Unknown';
  const email = data['email'] || '';
  const phone = data['phone'] || 'Not provided';
  const interestType = data['interest-type'] || 'Not specified';
  const budgetRange = data['budget-range'] || 'Not specified';
  const consultType = data['consult-type'] || 'discovery';
  const notes = data['notes'] || 'None';
  const timezone = data['timezone'] || '';
  const localTimeEquiv = data['local-time-equivalent'] || '';
  const location = data['location'] || 'Not provided';

  const consultLabels = {
    discovery: 'Free Discovery Call (30 min)',
    private: 'Private Session — $50 (60 min)',
    vip: 'VIP Membership — $9.99/mo',
  };

  const description = [
    `Consultation Request from ${name}`,
    '',
    `Email: ${email}`,
    `Phone: ${phone}`,
    `Location: ${location}`,
    '',
    `Interest: ${interestType}`,
    `Budget: ${budgetRange}`,
    `Consultation Type: ${consultLabels[consultType] || consultType}`,
    '',
    `Notes: ${notes}`,
    '',
    `Visitor Timezone: ${timezone}`,
    `Local Time Equivalent: ${localTimeEquiv}`,
    '',
    '---',
    'Auto-created by Aushe Properties website booking form',
  ].join('\n');

  const calendarEvent = {
    summary: `Consultation Request: ${name} — ${interestType}`,
    description,
    start: {
      dateTime: `${preferredDate}T${window.start}:00`,
      timeZone: 'America/Los_Angeles',
    },
    end: {
      dateTime: `${preferredDate}T${window.end}:00`,
      timeZone: 'America/Los_Angeles',
    },
    status: 'tentative',
    colorId: '6', // tangerine — stands out on the calendar
    attendees: email ? [{ email, responseStatus: 'needsAction' }] : [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60 },
        { method: 'popup', minutes: 30 },
      ],
    },
  };

  try {
    // Handle escaped newlines in the private key (Netlify env vars store \n literally)
    const cleanKey = privateKey.replace(/\\n/g, '\n');
    const accessToken = await getAccessToken(serviceEmail, cleanKey);
    const created = await createCalendarEvent(accessToken, calendarId, calendarEvent);
    console.log('Calendar event created:', created.id);
  } catch (err) {
    // Log but don't fail — the form submission is already saved by Netlify,
    // and email notification serves as a fallback
    console.error('Failed to create calendar event:', err.message);
  }

  return { statusCode: 200, body: 'OK' };
}
