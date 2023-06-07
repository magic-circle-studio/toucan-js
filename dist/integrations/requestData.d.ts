import { EventProcessor, Integration } from '@sentry/types';
import { Toucan } from '../sdk';
type Allowlist = string[] | RegExp | boolean;
export type RequestDataOptions = {
    allowedHeaders?: Allowlist;
    allowedCookies?: Allowlist;
    allowedSearchParams?: Allowlist;
    allowedIps?: Allowlist;
};
export declare class RequestData implements Integration {
    #private;
    static id: string;
    readonly name: string;
    constructor(options?: RequestDataOptions);
    setupOnce(addGlobalEventProcessor: (eventProcessor: EventProcessor) => void, getCurrentHub: () => Toucan): void;
}
export {};
//# sourceMappingURL=requestData.d.ts.map