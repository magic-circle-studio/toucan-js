import { Hub } from '@sentry/core';
import type { Options } from './types';
/**
 * The Cloudflare Workers SDK.
 */
export declare class Toucan extends Hub {
    constructor(options: Options);
    /**
     * Sets the request body context on all future events.
     *
     * @param body Request body.
     * @example
     * const body = await request.text();
     * toucan.setRequestBody(body);
     */
    setRequestBody(body: unknown): void;
}
//# sourceMappingURL=sdk.d.ts.map