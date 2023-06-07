import { EventProcessor, Exception, ExtendedError, Integration, StackParser } from '@sentry/types';
import { Toucan } from '../sdk';
export type LinkedErrorsOptions = {
    limit: number;
};
export declare class LinkedErrors implements Integration {
    static id: string;
    readonly name: string;
    private readonly limit;
    constructor(options?: Partial<LinkedErrorsOptions>);
    setupOnce(addGlobalEventProcessor: (eventProcessor: EventProcessor) => void, getCurrentHub: () => Toucan): void;
}
export declare function walkErrorTree(parser: StackParser, limit: number, error: ExtendedError, stack?: Exception[]): Exception[];
//# sourceMappingURL=linkedErrors.d.ts.map