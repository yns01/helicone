/* eslint-disable @typescript-eslint/no-explicit-any */
import { Provider } from "@helicone-package/llm-mapper/types";
import { createClient } from "@supabase/supabase-js";
import {
  checkRateLimit as checkRateLimitDO,
  updateRateLimitCounter as updateRateLimitCounterDO,
} from "../clients/DurableObjectRateLimiterClient";

import { HeliconeProducer } from "../clients/producers/HeliconeProducer";
import { checkPromptSecurity } from "../clients/PromptSecurityClient";
import { S3Client } from "../clients/S3Client";
import { ClickhouseClientWrapper } from "../db/ClickhouseWrapper";
import { DBWrapper } from "../db/DBWrapper";
import { RequestResponseStore } from "../db/RequestResponseStore";
import { Valhalla } from "../db/valhalla";
import { DBLoggable } from "../dbLogger/DBLoggable";
import { Moderator } from "../managers/ModerationManager";
import { RateLimitManager } from "../managers/RateLimitManager";
import { RequestResponseManager } from "../managers/RequestResponseManager";
import { SentryManager } from "../managers/SentryManager";
import {
  HeliconeProxyRequest,
  HeliconeProxyRequestMapper,
} from "../models/HeliconeProxyRequest";
import { RequestWrapper } from "../RequestWrapper";
import { ResponseBuilder } from "../ResponseBuilder";
import { getCachedResponse, saveToCache } from "../util/cache/cacheFunctions";
import { CacheSettings, getCacheSettings } from "../util/cache/cacheSettings";
import { DBQueryTimer } from "../util/loggers/DBQueryTimer";
import { Result } from "../util/results";
import {
  handleProxyRequest,
  handleThreatProxyRequest,
} from "./ProxyRequestHandler";
import { EscrowInfo } from "../util/aiGateway";
import {
  ALERT_ID,
  ALERT_THRESHOLD,
  SYNC_STALENESS_THRESHOLD,
} from "../durable-objects/Wallet";
import { SlackAlertManager } from "../managers/SlackAlertManager";
import { isError } from "../../../../packages/common/result";

export async function proxyForwarder(
  request: RequestWrapper,
  env: Env,
  ctx: ExecutionContext,
  provider: Provider,
  escrowInfo?: EscrowInfo
): Promise<Response> {
  const { data: proxyRequest, error: proxyRequestError } =
    await new HeliconeProxyRequestMapper(
      request,
      provider,
      env
    ).tryToProxyRequest();

  if (proxyRequestError !== null) {
    return new Response(proxyRequestError, {
      status: 500,
    });
  }
  const responseBuilder = new ResponseBuilder();

  const { data: cacheSettings, error: cacheError } = getCacheSettings(
    proxyRequest.requestWrapper.getHeaders()
  );

  if (cacheError !== null) {
    return responseBuilder.build({
      body: cacheError,
      status: 500,
    });
  }

  let rateLimited = false;
  if (cacheSettings.shouldReadFromCache) {
    const { data: auth, error: authError } = await request.auth();
    if (authError == null) {
      const db = new DBWrapper(env, auth);
      const { data: orgData, error: orgError } = await db.getAuthParams();

      if (orgError !== null || !orgData?.organizationId) {
        console.error("Error getting org", orgError);
      } else if (!orgData.accessDict.cache) {
        console.error(
          `Cache is disabled for this organization. ${orgData.organizationId}`
        );
      } else {
        try {
          const cachedResponse = await getCachedResponse(
            proxyRequest,
            cacheSettings.bucketSettings,
            env.CACHE_KV,
            cacheSettings.cacheSeed
          );
          if (cachedResponse) {
            const { data, error } = await handleProxyRequest(
              proxyRequest,
              cachedResponse // Pass the cached response directly
            );
            if (error !== null) {
              return responseBuilder.build({
                body: error,
                status: 500,
              });
            }
            const { loggable, response } = data;
            ctx.waitUntil(
              log(
                loggable,
                request,
                proxyRequest,
                env,
                ctx,
                rateLimited,
                "false", // S3_ENABLED
                cachedResponse,
                cacheSettings,
                escrowInfo
              )
            );

            return response;
          }
        } catch (error) {
          console.error("Error getting cached response", error);
        }
      }
    }
  }

  let finalRateLimitOptions = proxyRequest.rateLimitOptions;
  if (finalRateLimitOptions || proxyRequest.isRateLimitedKey) {
    const { data: auth, error: authError } = await request.auth();
    if (authError === null) {
      const db = new DBWrapper(env, auth);
      const { data: orgData, error: orgError } = await db.getAuthParams();
      if (orgError === null && orgData?.organizationId) {
        if (!finalRateLimitOptions && proxyRequest.isRateLimitedKey) {
          const rateLimitManager = new RateLimitManager();
          const result = await rateLimitManager.getRateLimitOptionsForKey(
            db,
            proxyRequest.userId,
            proxyRequest.heliconeProperties
          );

          if (!result.error && result.data) {
            finalRateLimitOptions = result.data;
          } else if (result.error) {
            console.error(`[RateLimit] Manager error: ${result.error}`);
          }
        }

        if (finalRateLimitOptions) {
          try {
            const rateLimitCheckResult = await checkRateLimitDO({
              organizationId: orgData.organizationId,
              heliconeProperties: proxyRequest.heliconeProperties,
              rateLimiterDO: env.RATE_LIMITER_SQL,
              rateLimitOptions: finalRateLimitOptions,
              userId: proxyRequest.userId,
              cost: 1,
            });
            responseBuilder.addRateLimitHeaders(
              rateLimitCheckResult,
              finalRateLimitOptions
            );

            if (rateLimitCheckResult.status === "rate_limited") {
              rateLimited = true;
              request.injectCustomProperty(
                "Helicone-Rate-Limit-Status",
                rateLimitCheckResult.status
              );
            }
          } catch (error) {
            console.error("Error checking rate limit", error);
          }
        }
      }
    }
  }

  if (
    proxyRequest.requestWrapper.heliconeHeaders.promptSecurityEnabled ===
      true &&
    provider === "OPENAI"
  ) {
    const { data: latestMsg, error: latestMsgErr } =
      parseLatestMessage(proxyRequest);
    if (latestMsgErr || !latestMsg) {
      return responseBuilder.build({
        body: latestMsgErr,
        status: 500,
      });
    }

    if (
      request.url.pathname.includes("chat/completions") &&
      latestMsg?.content &&
      latestMsg?.role === "user"
    ) {
      const requestStartTime = new Date();
      const threat = await checkPromptSecurity(
        latestMsg.content,
        env,
        proxyRequest.requestWrapper.heliconeHeaders.promptSecurityAdvanced
          ? true
          : false
      );

      proxyRequest.threat = threat;
      if (threat === true) {
        const { data, error } = await handleThreatProxyRequest(
          proxyRequest,
          requestStartTime
        );

        if (error !== null) {
          return responseBuilder.build({
            body: error,
            status: 500,
          });
        }
        const { loggable, response } = data;

        response.headers.forEach((value, key) => {
          responseBuilder.setHeader(key, value);
        });

        ctx.waitUntil(
          log(
            loggable,
            request,
            proxyRequest,
            env,
            ctx,
            rateLimited,
            undefined,
            undefined,
            undefined,
            escrowInfo
          )
        );

        const responseContent = {
          body: JSON.stringify({
            success: false,
            error: {
              code: "PROMPT_THREAT_DETECTED",
              message:
                "Prompt threat detected. Your request cannot be processed.",
              details: `See your Helicone request page for more info. https://helicone.ai/request/${proxyRequest.requestId}`,
            },
          }),
          inheritFrom: response,
          status: 400,
        };

        return responseBuilder
          .setHeader("content-type", "application/json")
          .build(responseContent);
      }
    }
  }

  if (
    proxyRequest.requestWrapper.heliconeHeaders.moderationsEnabled &&
    provider == "OPENAI"
  ) {
    const { data: latestMsg, error: latestMsgErr } =
      parseLatestMessage(proxyRequest);

    if (latestMsgErr || !latestMsg) {
      return responseBuilder.build({
        body: latestMsgErr,
        status: 500,
      });
    }

    if (
      request.url.pathname.includes("chat/completions") &&
      latestMsg?.content &&
      latestMsg?.role === "user"
    ) {
      const moderator = new Moderator(
        proxyRequest.requestWrapper.headers,
        env,
        provider
      );

      const { data: moderationRes, error: moderationErr } =
        await moderator.moderate(latestMsg.content);

      if (moderationErr || !moderationRes) {
        return responseBuilder.build({
          body: moderationErr,
          status: 500,
        });
      }

      ctx.waitUntil(
        log(
          moderationRes.loggable,
          request,
          proxyRequest,
          env,
          ctx,
          rateLimited,
          undefined,
          undefined,
          undefined,
          escrowInfo
        )
      );

      if (moderationRes.isModerated) {
        return moderationRes.response;
      }
      // Passed moderation...
    }
  }

  const { data, error } = await handleProxyRequest(
    proxyRequest,
    rateLimited ? responseBuilder.buildRateLimitedResponse() : undefined
  );
  if (error !== null) {
    return responseBuilder.build({
      body: error,
      status: 500,
    });
  }
  const { loggable, response } = data;

  if (cacheSettings.shouldSaveToCache && response.status === 200) {
    const { data: auth, error: authError } = await request.auth();
    if (authError == null) {
      const db = new DBWrapper(env, auth);
      const { data: orgData, error: orgError } = await db.getAuthParams();

      if (orgError !== null || !orgData?.organizationId) {
        console.error("Error getting org", orgError);
      } else {
        ctx.waitUntil(
          loggable.waitForResponse().then(async (responseBody) => {
            const status = await loggable.getStatus();
            if (status >= 200 && status < 300) {
              try {
                const success = await saveToCache({
                  request: proxyRequest,
                  response,
                  responseBody: responseBody.body,
                  cacheControl: cacheSettings.cacheControl,
                  settings: cacheSettings.bucketSettings,
                  responseLatencyMs:
                    responseBody.endTime.getTime() - loggable.getTimingStart(),
                  cacheKv: env.CACHE_KV,
                  cacheSeed: cacheSettings.cacheSeed ?? null,
                });
                if (!success) {
                  const sentryManager = new SentryManager(env);
                  await sentryManager.sendError(
                    "Failed to save to cache",
                    "all retries failed"
                  );
                }
              } catch (error) {
                const sentryManager = new SentryManager(env);
                await sentryManager.sendError(
                  "Failed to save to cache",
                  error instanceof Error
                    ? (error.stack ?? error.message)
                    : String(error)
                );
                console.error("Failed to save to cache:", error);
              }
            }
          })
        );
      }
    }
  }

  response.headers.forEach((value, key) => {
    responseBuilder.setHeader(key, value);
  });

  if (cacheSettings.shouldReadFromCache) {
    responseBuilder.setHeader("Helicone-Cache", "MISS");
  }

  if (
    request?.heliconeHeaders?.heliconeAuth ||
    request?.heliconeHeaders.heliconeAuthV2 ||
    request.heliconeProxyKeyId
  ) {
    ctx.waitUntil(
      log(
        loggable,
        request,
        proxyRequest,
        env,
        ctx,
        rateLimited,
        undefined,
        undefined,
        undefined,
        escrowInfo
      )
    );
  }

  return responseBuilder.build({
    body: response.body,
    inheritFrom: response,
    status: response.status,
  });
}

function parseLatestMessage(
  proxyRequest: HeliconeProxyRequest
): Result<LatestMessage, string> {
  try {
    return {
      error: null,
      data: JSON.parse(
        proxyRequest.bodyText ?? ""
      ).messages.pop() as LatestMessage,
    };
  } catch (error) {
    console.error("Error parsing latest message:", error);
    return {
      error: "Failed to parse the latest message.",
      data: null,
    };
  }
}

type LatestMessage = {
  role?: string;
  content?: string;
};

async function log(
  loggable: DBLoggable,
  request: RequestWrapper,
  proxyRequest: HeliconeProxyRequest,
  env: Env,
  ctx: ExecutionContext,
  rateLimited: boolean,
  S3_ENABLED?: Env["S3_ENABLED"],
  cachedResponse?: Response,
  cacheSettings?: CacheSettings,
  escrowInfo?: EscrowInfo
) {
  const { data: auth, error: authError } = await request.auth();

  if (authError !== null) {
    console.error("Error getting auth", authError);
    return;
  }
  const supabase = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY
  );
  const res = await loggable.log(
    {
      clickhouse: new ClickhouseClientWrapper(env),
      supabase: supabase,
      dbWrapper: new DBWrapper(env, auth),
      queue: new RequestResponseStore(
        createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
        new DBQueryTimer(ctx, {
          enabled: (env.DATADOG_ENABLED ?? "false") === "true",
          apiKey: env.DATADOG_API_KEY,
          endpoint: env.DATADOG_ENDPOINT,
        }),
        new Valhalla(env.VALHALLA_URL, auth),
        new ClickhouseClientWrapper(env),
        env.FALLBACK_QUEUE,
        env.REQUEST_AND_RESPONSE_QUEUE_KV
      ),
      requestResponseManager: new RequestResponseManager(
        new S3Client(
          env.S3_ACCESS_KEY ?? "",
          env.S3_SECRET_KEY ?? "",
          env.S3_ENDPOINT ?? "",
          env.S3_BUCKET_NAME ?? "",
          env.S3_REGION ?? "us-west-2"
        ),
        createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
      ),
      producer: new HeliconeProducer(env),
    },
    S3_ENABLED ?? env.S3_ENABLED ?? "true",
    proxyRequest?.requestWrapper.heliconeHeaders,
    cachedResponse ? cachedResponse.headers : undefined,
    cacheSettings ?? undefined
  );
  const finalRateLimitOptions = proxyRequest.rateLimitOptions;

  if (res.error !== null) {
    console.error("Error logging", res.error);
  }
  const db = new DBWrapper(env, auth);
  const { data: orgData, error: orgError } = await db.getAuthParams();
  if (!orgData) {
    console.error(
      "Could not get org data for request w/ id: ",
      proxyRequest.requestId
    );
    return;
  }
  const walletId = env.WALLET.idFromName(orgData.organizationId);
  const walletStub = env.WALLET.get(walletId);
  const passthroughBillingEnabled =
    proxyRequest?.requestWrapper.heliconeHeaders.passthroughBillingEnabled;
  if (passthroughBillingEnabled && res.data && escrowInfo) {
    const cost = res.data.cost;
    try {
      const { clickhouseLastCheckedAt } = await walletStub.finalizeEscrow(
        orgData.organizationId,
        escrowInfo.escrowId,
        cost
      );
      if (
        cost === 0 &&
        (cachedResponse === undefined || cachedResponse === null)
      ) {
        // if the cost is 0 and we're not using a cached response, we need to add the request to the disallow list
        // so that we guard against abuse
        await walletStub.addToDisallowList(
          proxyRequest.requestId,
          proxyRequest.provider,
          escrowInfo.model ?? "*"
        );
      }

      if (clickhouseLastCheckedAt > SYNC_STALENESS_THRESHOLD) {
        const rawAPIKey =
          proxyRequest.requestWrapper.getRawProviderAuthHeader();
        try {
          // get the totaldebit spent according to clickhouse
          const response = await fetch(
            `${env.VALHALLA_URL}/v1/credits/totalSpend`,
            {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${rawAPIKey}`,
              },
            }
          );
          const clickhouseResponse: Result<number, string> = await response.json();
          if (isError(clickhouseResponse)) {
            console.error("Error getting total spend", clickhouseResponse.error);
            throw new Error(clickhouseResponse.error);
          }
          const clickhouseTotalSpend = clickhouseResponse.data;
          const { totalDebits: walletTotalSpend, alertState } =
            await walletStub.getTotalDebits(orgData.organizationId);
          const delta = Math.abs(clickhouseTotalSpend - walletTotalSpend);
          
          // Update the ClickHouse values in the wallet
          await walletStub.updateClickhouseValues(
            orgData.organizationId,
            clickhouseTotalSpend
          );
          
          // if alert state is on, and the delta is less than the threshold, reset the state
          if (alertState && delta < ALERT_THRESHOLD) {
            await walletStub.setAlertState(ALERT_ID, false);
          } else if (!alertState && delta > ALERT_THRESHOLD) {
            // set the alert state to on
            await walletStub.setAlertState(ALERT_ID, true);
            const slackAlertManager = new SlackAlertManager(env);
            await slackAlertManager.sendSlackMessageToChannel(
              env.SLACK_ALERT_CHANNEL,
              `Total spend delta is greater than ${ALERT_THRESHOLD} USD. Current total spend: ${clickhouseTotalSpend} USD. Wallet total spend: ${walletTotalSpend} USD. Delta: ${delta} USD. Org ID: ${orgData.organizationId}`
            );
          }
        } catch (error) {
          console.error("Error getting total spend", error);
        }
      }
    } catch (error) {
      console.error(`Error finalizing escrow ${escrowInfo.escrowId}:`, error);
    }
  } else if (passthroughBillingEnabled && !escrowInfo) {
    console.error("No escrow info, could not finalize escrow");
  }

  // if not a cached response, incur rate limits
  if (
    (!rateLimited && cachedResponse === undefined) ||
    (!rateLimited && cachedResponse === null)
  ) {
    if (
      proxyRequest &&
      finalRateLimitOptions &&
      !orgError &&
      orgData?.organizationId
    ) {
      // better we rate limit too early than never at all
      const finalCost = res.data?.cost ?? 1;
      await updateRateLimitCounterDO({
        organizationId: orgData?.organizationId,
        heliconeProperties:
          proxyRequest.requestWrapper.heliconeHeaders.heliconeProperties,
        rateLimiterDO: env.RATE_LIMITER_SQL,
        rateLimitOptions: finalRateLimitOptions,
        userId: proxyRequest.userId,
        cost: finalCost,
      });
    }
  }
}
