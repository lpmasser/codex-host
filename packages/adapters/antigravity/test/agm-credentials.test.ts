import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeAgmCredential, refreshAgmAccount } from "../src/agm-credentials.js";

afterEach(() => vi.unstubAllGlobals());

describe("AGM OAuth import protocol", () => {
  it("serializes the native StoredToken wrapper rather than a string or a bare OAuth token", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "synthetic",
          expires_in: 3600,
          token_type: "Bearer",
          id_token: "synthetic-id",
        }),
      )
      .mockResolvedValueOnce(Response.json({ email: "account@example.com" }));
    vi.stubGlobal("fetch", request);
    const credential = await initializeAgmCredential({
      email: "account@example.com",
      refresh_token: "synthetic-refresh",
    });
    const stored = JSON.parse(credential.serialized);
    expect(stored).toMatchObject({
      token: {
        access_token: "synthetic",
        token_type: "Bearer",
        refresh_token: "synthetic-refresh",
      },
      id_token: "synthetic-id",
    });
    expect(stored.access_token).toBeUndefined();
    expect(stored.auth_method).toBe("consumer");
    expect(stored.token.expiry).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("uses the Manager refresh grant, validates identity and retains an unrotated refresh token", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ access_token: "synthetic-access", expires_in: 3600, token_type: "Bearer" }),
      )
      .mockResolvedValueOnce(Response.json({ email: "account@example.com" }));
    const result = await refreshAgmAccount(
      { email: "Account@example.com", refresh_token: "synthetic-refresh" },
      request,
    );
    expect(request.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
    const body = request.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("synthetic-refresh");
    expect(body.get("client_id")).toBe(
      "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    );
    expect(request.mock.calls[1]?.[0]).toBe("https://www.googleapis.com/oauth2/v2/userinfo");
    expect(result.token.refresh_token).toBe("synthetic-refresh");
    expect(Date.parse(result.token.expiry)).toBeGreaterThan(Date.now() + 3_500_000);
    expect(result.email).toBe("account@example.com");
  });

  it("retains provider rotation and rejects a mismatched account", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "synthetic",
          expires_in: 3600,
          token_type: "Bearer",
          refresh_token: "rotated",
        }),
      )
      .mockResolvedValueOnce(Response.json({ email: "other@example.com" }));
    await expect(
      refreshAgmAccount({ email: "account@example.com", refresh_token: "original" }, request),
    ).rejects.toMatchObject({ reason: "identityMismatch" });
    request
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "synthetic",
          expires_in: 3600,
          token_type: "Bearer",
          refresh_token: "rotated",
        }),
      )
      .mockResolvedValueOnce(Response.json({ email: "account@example.com" }));
    expect(
      (
        await refreshAgmAccount(
          { email: "account@example.com", refresh_token: "original" },
          request,
        )
      ).token.refresh_token,
    ).toBe("rotated");
  });

  it("never exposes transport/provider credential text in errors", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("SECRET-REFRESH request failed"));
    await expect(
      refreshAgmAccount({ email: "account@example.com", refresh_token: "SECRET-REFRESH" }, request),
    ).rejects.toThrow("authenticationFailed");
    request.mockResolvedValue(Response.json({ error: "SECRET-REFRESH" }, { status: 400 }));
    await expect(
      refreshAgmAccount({ email: "account@example.com", refresh_token: "SECRET-REFRESH" }, request),
    ).rejects.toThrow("authenticationFailed");
  });
});
