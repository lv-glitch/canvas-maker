// Cloudflare Turnstile token verification — called from /api/generate-image
// before doing any expensive fal.ai work.
//
// Behaviour:
//   - If TURNSTILE_SECRET is unset, verification is skipped (returns ok).
//     Useful for local dev and a graceful fallback if the secret rotates.
//     Production should always set it.
//   - Otherwise, POSTs the token to Cloudflare's siteverify endpoint and
//     returns the parsed result.
//
// The cost-of-failure is asymmetric: a missed bad-bot lets through one
// $0.06 fal.ai call. Blocking a real user prevents a paid signup. So we
// fail-OPEN if the secret is missing or Cloudflare itself errors.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(token, remoteIP) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) {
    console.warn("[turnstile] TURNSTILE_SECRET unset — skipping verification");
    return { ok: true, reason: "no-secret-set" };
  }
  if (!token || typeof token !== "string") {
    return { ok: false, reason: "missing-token" };
  }

  try {
    const params = new URLSearchParams();
    params.append("secret", secret);
    params.append("response", token);
    if (remoteIP) params.append("remoteip", remoteIP);

    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[turnstile] siteverify returned HTTP ${res.status} — failing open`);
      return { ok: true, reason: "siteverify-error" };
    }
    const data = await res.json();
    if (data.success) return { ok: true };
    const codes = (data["error-codes"] || []).join(",");
    return { ok: false, reason: codes || "unknown" };
  } catch (err) {
    // Cloudflare timeout or network error — fail open. Cost: a single
    // $0.06 fal.ai call slipping through if their endpoint is down.
    console.warn(`[turnstile] siteverify failed (${err.message}) — failing open`);
    return { ok: true, reason: "siteverify-exception" };
  }
}
