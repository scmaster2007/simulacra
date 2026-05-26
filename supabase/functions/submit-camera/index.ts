// Supabase Edge Function — classifies a submitted photo with Claude vision
// and inserts the resulting camera row. Photos are NEVER stored.
//
// The browser sends the image as inline base64. We forward it to Claude,
// keep the classification (type/brand/model/confidence/reason), and discard
// the bytes. Nothing about the image persists in this service.
//
// Deploy: supabase functions deploy submit-camera --no-verify-jwt
// Secrets: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const PUBLISH_CONFIDENCE = 0.7;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
// 13 MB of base64 chars ≈ 9.75 MB raw image — generous for a phone photo
// after client-side resize to 1600px.
const MAX_BASE64_CHARS = 13 * 1024 * 1024;

const CLASSIFY_PROMPT = `You are analyzing a photograph submitted to a public surveillance-camera registry.

Respond with strict JSON only — no markdown fences, no commentary. Shape:

{
  "is_camera": boolean,
  "confidence": number between 0 and 1,
  "type": "dome" | "fixed" | "panning" | "alpr" | "other" | null,
  "brand": string | null,
  "model": string | null,
  "reason": string (one short sentence)
}

Definitions:
- is_camera: true if the photo's main subject is a surveillance/security camera or an automated license-plate reader. False for non-cameras, photos too dark/obscured to tell, or photos of people.
- confidence: your certainty about is_camera (0-1).
- type:
  - "dome"    — hemispherical/ceiling housing
  - "fixed"   — bullet/box camera, single direction
  - "panning" — PTZ with visible motor housing
  - "alpr"    — license-plate reader (Flock yellow box, Motorola Vigilant, narrow horizontal lens with IR ring)
  - "other"   — surveillance device that doesn't fit above
- brand: visible brand text on the device (Axis, Hikvision, Dahua, Flock, Motorola, etc.) — null if not legible.
- model: visible model number/identifier — null if not visible.
- reason: one short sentence describing what you saw. This is the only record of the photo that will be kept.`;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
};

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

interface Classification {
  is_camera: boolean;
  confidence: number;
  type: string | null;
  brand: string | null;
  model: string | null;
  reason: string;
}

function parseClassification(text: string): Classification {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const obj = JSON.parse(cleaned);
  const conf = typeof obj.confidence === 'number' ? obj.confidence : 0;
  return {
    is_camera: !!obj.is_camera,
    confidence: Math.max(0, Math.min(1, conf)),
    type: obj.type ?? null,
    brand: obj.brand ?? null,
    model: obj.model ?? null,
    reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 280) : '',
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return jsonRes({ error: 'method not allowed' }, 405);

  let payload: {
    imageBase64?: unknown;
    imageMimeType?: unknown;
    lng?: unknown;
    lat?: unknown;
    bearing?: unknown;
  };
  try {
    payload = await req.json();
  } catch {
    return jsonRes({ error: 'invalid json body' }, 400);
  }

  const { imageBase64, imageMimeType, lng, lat, bearing } = payload;

  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
    return jsonRes({ error: 'imageBase64 (string) is required' }, 400);
  }
  if (imageBase64.length > MAX_BASE64_CHARS) {
    return jsonRes(
      { error: `image too large (${imageBase64.length} chars > ${MAX_BASE64_CHARS})` },
      413,
    );
  }
  if (typeof imageMimeType !== 'string' || !ALLOWED_MIME.has(imageMimeType)) {
    return jsonRes(
      { error: `imageMimeType must be one of ${[...ALLOWED_MIME].join(', ')}` },
      400,
    );
  }
  if (typeof lng !== 'number' || typeof lat !== 'number') {
    return jsonRes({ error: 'lng and lat must be numbers' }, 400);
  }
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    return jsonRes({ error: 'coordinates out of range' }, 400);
  }
  const bearingNum =
    typeof bearing === 'number' && Number.isFinite(bearing)
      ? ((bearing % 360) + 360) % 360
      : null;

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return jsonRes({ error: 'server missing ANTHROPIC_API_KEY' }, 500);

  let classification: Classification;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 512,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: imageMimeType,
                  data: imageBase64,
                },
              },
              { type: 'text', text: CLASSIFY_PROMPT },
            ],
          },
        ],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return jsonRes({ error: 'claude api error', status: resp.status, detail }, 502);
    }
    const data = await resp.json();
    const text = data?.content?.[0]?.text ?? '';
    classification = parseClassification(text);
  } catch (err) {
    return jsonRes({ error: 'claude call failed', detail: String(err) }, 502);
  }

  const status =
    classification.is_camera && classification.confidence >= PUBLISH_CONFIDENCE
      ? 'published'
      : 'review';

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: rows, error } = await supabase.rpc('insert_user_camera', {
    _lng: lng,
    _lat: lat,
    _bearing: bearingNum,
    _type: classification.type,
    _brand: classification.brand,
    _model: classification.model,
    _ai_confidence: classification.confidence,
    _ai_reason: classification.reason,
    _status: status,
  });

  if (error) return jsonRes({ error: 'db insert failed', detail: error.message }, 500);

  return jsonRes({
    camera: Array.isArray(rows) ? rows[0] : rows,
    classification,
    published: status === 'published',
  });
});
