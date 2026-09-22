import { z } from "zod";
import {
  ProfileImportError,
  type AgmAccount,
  type ImportedAgmCredential,
} from "./account-profiles.js";

// AGM's built-in installed-app OAuth configuration and refresh/userinfo protocol.
// Reference: lbjlaq/Antigravity-Manager@85e7f83, src-tauri/src/modules/oauth.rs.
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().optional(),
});
const userResponseSchema = z.object({ email: z.email().max(320) });

export async function refreshAgmAccount(account: AgmAccount, request: typeof fetch = fetch) {
  try {
    const response = await request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: account.refresh_token,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ProfileImportError("authenticationFailed");
    const token = tokenResponseSchema.parse(await response.json());
    const identity = await request("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!identity.ok) throw new ProfileImportError("authenticationFailed");
    const { email } = userResponseSchema.parse(await identity.json());
    if (email.toLowerCase() !== account.email.toLowerCase()) {
      throw new ProfileImportError("identityMismatch");
    }
    return {
      email,
      token: {
        access_token: token.access_token,
        token_type: token.token_type,
        refresh_token: token.refresh_token ?? account.refresh_token,
        expiry: new Date(Date.now() + token.expires_in * 1_000).toISOString(),
      },
      ...(token.id_token ? { idToken: token.id_token } : {}),
    };
  } catch (error) {
    if (error instanceof ProfileImportError) throw error;
    // Transport and provider errors may contain request/credential material.
    throw new ProfileImportError("authenticationFailed");
  }
}

export async function initializeAgmCredential(account: AgmAccount): Promise<ImportedAgmCredential> {
  const refreshed = await refreshAgmAccount(account);
  // CLI getOauthParams requires "consumer" to select the personal OAuth client.
  // Auth-mode inference in the language server does not replace this persisted discriminator.
  return {
    email: refreshed.email,
    serialized: JSON.stringify({
      auth_method: "consumer",
      token: refreshed.token,
      ...(refreshed.idToken ? { id_token: refreshed.idToken } : {}),
    }),
  };
}
