import { type ProviderName } from "@helicone-package/cost/models/providers";
import { removeFromCache, storeInCache } from "./clients/cloudflareKV";
import { ENVIRONMENT } from "./clients/constant";
import { HMACAuth } from "./hmacAuth";
import { type CreateProviderKeyRequest } from "../controllers/public/apiKeyController";

export const MAX_RETRIES = 3;


export async function setProviderKey(
  orgId: string,
  providerKey: CreateProviderKeyRequest,
  retries = MAX_RETRIES
) {
  try {
    const body = {
      providerName: providerKey.providerName,
      providerKey: providerKey.providerKey,
      providerSecretKey: providerKey.providerSecretKey,
      providerKeyName: providerKey.providerKeyName,
      config: providerKey.config,
      orgId,
      byokEnabled: providerKey.byokEnabled,
      authType: "key",
    };
    console.log("sending provider key to worker to set in cache", body);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const hmacAuth = new HMACAuth({ secret: process.env.HELICONE_SERVICE_HMAC_SECRET! });

    // Add HMAC authentication headers if configured
    const hmacHeaders = hmacAuth.createAuthHeaders(
      "POST",
      `/provider/key`,
      body
    );
    Object.assign(headers, hmacHeaders);

    const res = await fetch(
      `${process.env.HELICONE_WORKER_API}/provider/key`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      console.error(res);
      if (retries > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, 10_000 * (MAX_RETRIES - retries))
        );
        await setProviderKey(orgId, providerKey, retries - 1);
      }
    }
  } catch (e) {
    console.error(e);
  }
}

export async function setAPIKey(
  apiKeyHash: string,
  organizationId: string,
  softDelete: boolean
) {
  if (ENVIRONMENT === "production") {
    if (softDelete) {
      await removeFromCache(`api_keys_${apiKeyHash}`);
    } else {
      await storeInCache(`api_keys_${apiKeyHash}`, organizationId);
    }
  } else {
    await setAPIKeyDev(apiKeyHash, organizationId, softDelete);
  }
}

export async function setAPIKeyDev(
  apiKeyHash: string,
  organizationId: string,
  softDelete: boolean,
  retries = MAX_RETRIES
) {
  try {
    const res = await fetch(
      `${process.env.HELICONE_WORKER_API}/mock-set-api-key`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          apiKeyHash,
          organizationId,
          softDelete,
        }),
      }
    );
    if (!res.ok) {
      console.error(res);
      if (retries > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, 10_000 * (MAX_RETRIES - retries))
        );
        await setAPIKeyDev(apiKeyHash, organizationId, softDelete, retries - 1);
      }
    }
  } catch (e) {
    console.error(e);
  }
}

export async function deleteProviderKey(
  providerName: ProviderName,
  orgId: string
) {
  if (ENVIRONMENT === "production") {
    await removeFromCache(`provider_keys_${providerName}_${orgId}`);
  } else {
    try {
      const res = await fetch(
        `${process.env.HELICONE_WORKER_API}/delete-provider-key`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ providerName, orgId }),
        }
      );
    } catch (e) {
      console.error(e);
    }
  }
}
