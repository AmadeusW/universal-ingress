const textEncoder = new TextEncoder();

/** Compares secrets in constant time so response timing doesn't reveal how much matched. */
export function constantTimeEquals(a: string, b: string): boolean {
  // An unset secret must never match, otherwise a missing header would authenticate.
  if (!a || !b) return false;

  const bytesA = textEncoder.encode(a);
  const bytesB = textEncoder.encode(b);

  // A length mismatch counts as a difference, and the loop still runs to the longer length.
  let differences = bytesA.length ^ bytesB.length;
  for (let i = 0; i < Math.max(bytesA.length, bytesB.length); i++) {
    differences |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  }
  return differences === 0;
}

/** True if the request carries `Authorization: Bearer <expectedToken>`. */
export function hasValidBearerToken(request: Request, expectedToken: string): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  return header.startsWith(prefix) && constantTimeEquals(header.slice(prefix.length), expectedToken);
}

/**
 * Verifies Twilio's X-Twilio-Signature header.
 * `url` must be exactly the URL Twilio was configured to call.
 */
export async function isValidTwilioSignature(args: {
  authToken: string;
  url: string;
  formFields: URLSearchParams;
  receivedSignature: string | null;
}): Promise<boolean> {
  if (!args.receivedSignature) return false;

  // Twilio signs the URL followed by each form field's name and value, with fields sorted by name.
  const fieldNames = [...new Set(args.formFields.keys())].sort();
  let signedText = args.url;
  for (const name of fieldNames) {
    signedText += name + (args.formFields.get(name) ?? "");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(args.authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, textEncoder.encode(signedText));
  const expectedSignature = btoa(String.fromCharCode(...new Uint8Array(mac)));

  return constantTimeEquals(expectedSignature, args.receivedSignature);
}
