import crypto from "crypto";

export interface HMACAuthOptions {
  secret: string;
  algorithm?: string;
  headerName?: string;
}

export class HMACAuth {
  private secret: string;
  private algorithm: string;
  private headerName: string;

  constructor(options: HMACAuthOptions) {
    this.secret = options.secret;
    this.algorithm = options.algorithm || "sha256";
    this.headerName = options.headerName || "X-HMAC-Signature";
  }

  generateSignature(
    method: string,
    path: string,
    timestamp: number,
    body?: any
  ): string {
    const payload = this.createPayload(method, path, timestamp, body);
    const hmac = crypto.createHmac(this.algorithm, this.secret);
    hmac.update(payload);
    return hmac.digest("hex");
  }

  createPayload(
    method: string,
    path: string,
    timestamp: number,
    body?: any
  ): string {
    const bodyString = body ? JSON.stringify(body) : "";
    return `${method}:${path}:${timestamp}:${bodyString}`;
  }

  createAuthHeaders(
    method: string,
    path: string,
    body?: any
  ): Record<string, string> {
    const timestamp = Date.now();
    const signature = this.generateSignature(method, path, timestamp, body);
    
    return {
      [this.headerName]: signature,
      "X-Timestamp": timestamp.toString(),
    };
  }

  verifySignature(
    signature: string,
    method: string,
    path: string,
    timestamp: number,
    body?: any,
    maxAge: number = 300000 // 5 minutes default
  ): boolean {
    // Check if timestamp is within acceptable range
    const now = Date.now();
    if (Math.abs(now - timestamp) > maxAge) {
      return false;
    }

    const expectedSignature = this.generateSignature(
      method,
      path,
      timestamp,
      body
    );

    // Use timing-safe comparison
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }
}