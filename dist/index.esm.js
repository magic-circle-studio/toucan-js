import { GLOBAL_OBJ, isError, isPlainObject, extractExceptionKeysForMessage, normalizeToSize, addExceptionTypeValue, addExceptionMechanism, isInstanceOf, resolvedSyncPromise, createStackParser, nodeStackLineParser, basename, rejectedSyncPromise, stackParserFromStackParserOptions } from '@sentry/utils';
import { BaseClient, createTransport, Hub, getIntegrationsToSetup } from '@sentry/core';

function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function isMechanism(value) {
    return (isObject(value) &&
        'handled' in value &&
        typeof value.handled === 'boolean' &&
        'type' in value &&
        typeof value.type === 'string');
}
function containsMechanism(value) {
    return (isObject(value) && 'mechanism' in value && isMechanism(value['mechanism']));
}
/**
 * Tries to find release in a global
 */
function getSentryRelease() {
    // Most of the plugins from https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/ inject SENTRY_RELEASE global to the bundle
    if (GLOBAL_OBJ.SENTRY_RELEASE && GLOBAL_OBJ.SENTRY_RELEASE.id) {
        return GLOBAL_OBJ.SENTRY_RELEASE.id;
    }
}
/**
 * Creates an entry on existing object and returns it, or creates a new object with the entry if it doesn't exist.
 *
 * @param target
 * @param entry
 * @returns Object with new entry.
 */
function setOnOptional(target, entry) {
    if (target !== undefined) {
        target[entry[0]] = entry[1];
        return target;
    }
    else {
        return { [entry[0]]: entry[1] };
    }
}

/**
 * Extracts stack frames from the error.stack string
 */
function parseStackFrames(stackParser, error) {
    return stackParser(error.stack || '', 1);
}
/**
 * There are cases where stacktrace.message is an Event object
 * https://github.com/getsentry/sentry-javascript/issues/1949
 * In this specific case we try to extract stacktrace.message.error.message
 */
function extractMessage(ex) {
    const message = ex && ex.message;
    if (!message) {
        return 'No error message';
    }
    if (message.error && typeof message.error.message === 'string') {
        return message.error.message;
    }
    return message;
}
/**
 * Extracts stack frames from the error and builds a Sentry Exception
 */
function exceptionFromError(stackParser, error) {
    const exception = {
        type: error.name || error.constructor.name,
        value: extractMessage(error),
    };
    const frames = parseStackFrames(stackParser, error);
    if (frames.length) {
        exception.stacktrace = { frames };
    }
    if (exception.type === undefined && exception.value === '') {
        exception.value = 'Unrecoverable error caught';
    }
    return exception;
}
/**
 * Builds and Event from a Exception
 */
function eventFromUnknownInput(sdk, stackParser, exception, hint) {
    let ex;
    const providedMechanism = hint && hint.data && containsMechanism(hint.data)
        ? hint.data.mechanism
        : undefined;
    const mechanism = providedMechanism ?? {
        handled: true,
        type: 'generic',
    };
    if (!isError(exception)) {
        if (isPlainObject(exception)) {
            // This will allow us to group events based on top-level keys
            // which is much better than creating new group when any key/value change
            const message = `Non-Error exception captured with keys: ${extractExceptionKeysForMessage(exception)}`;
            const client = sdk?.getClient();
            const normalizeDepth = client && client.getOptions().normalizeDepth;
            sdk?.configureScope((scope) => {
                scope.setExtra('__serialized__', normalizeToSize(exception, normalizeDepth));
            });
            ex = (hint && hint.syntheticException) || new Error(message);
            ex.message = message;
        }
        else {
            // This handles when someone does: `throw "something awesome";`
            // We use synthesized Error here so we can extract a (rough) stack trace.
            ex = (hint && hint.syntheticException) || new Error(exception);
            ex.message = exception;
        }
        mechanism.synthetic = true;
    }
    else {
        ex = exception;
    }
    const event = {
        exception: {
            values: [exceptionFromError(stackParser, ex)],
        },
    };
    addExceptionTypeValue(event, undefined, undefined);
    addExceptionMechanism(event, mechanism);
    return {
        ...event,
        event_id: hint && hint.event_id,
    };
}
/**
 * Builds and Event from a Message
 */
function eventFromMessage(stackParser, message, level = 'info', hint, attachStacktrace) {
    const event = {
        event_id: hint && hint.event_id,
        level,
        message,
    };
    if (attachStacktrace && hint && hint.syntheticException) {
        const frames = parseStackFrames(stackParser, hint.syntheticException);
        if (frames.length) {
            event.exception = {
                values: [
                    {
                        value: message,
                        stacktrace: { frames },
                    },
                ],
            };
        }
    }
    return event;
}

const DEFAULT_LIMIT = 5;
class LinkedErrors {
    static id = 'LinkedErrors';
    name = LinkedErrors.id;
    limit;
    constructor(options = {}) {
        this.limit = options.limit || DEFAULT_LIMIT;
    }
    setupOnce(addGlobalEventProcessor, getCurrentHub) {
        const client = getCurrentHub().getClient();
        if (!client) {
            return;
        }
        addGlobalEventProcessor((event, hint) => {
            const self = getCurrentHub().getIntegration(LinkedErrors);
            if (!self) {
                return event;
            }
            return handler(client.getOptions().stackParser, self.limit, event, hint);
        });
    }
}
function handler(parser, limit, event, hint) {
    if (!event.exception ||
        !event.exception.values ||
        !hint ||
        !isInstanceOf(hint.originalException, Error)) {
        return event;
    }
    const linkedErrors = walkErrorTree(parser, limit, hint.originalException);
    event.exception.values = [...linkedErrors, ...event.exception.values];
    return event;
}
function walkErrorTree(parser, limit, error, stack = []) {
    if (!isInstanceOf(error.cause, Error) || stack.length + 1 >= limit) {
        return stack;
    }
    const exception = exceptionFromError(parser, error.cause);
    return walkErrorTree(parser, limit, error.cause, [
        exception,
        ...stack,
    ]);
}

const defaultRequestDataOptions = {
    allowedHeaders: ['CF-RAY', 'CF-Worker'],
};
class RequestData {
    static id = 'RequestData';
    name = RequestData.id;
    #options;
    constructor(options = {}) {
        this.#options = { ...defaultRequestDataOptions, ...options };
    }
    setupOnce(addGlobalEventProcessor, getCurrentHub) {
        const client = getCurrentHub().getClient();
        if (!client) {
            return;
        }
        addGlobalEventProcessor((event) => {
            const { sdkProcessingMetadata } = event;
            const self = getCurrentHub().getIntegration(RequestData);
            if (!self || !sdkProcessingMetadata) {
                return event;
            }
            if ('request' in sdkProcessingMetadata &&
                sdkProcessingMetadata.request instanceof Request) {
                event.request = toEventRequest(sdkProcessingMetadata.request, this.#options);
                event.user = toEventUser(event.user ?? {}, sdkProcessingMetadata.request, this.#options);
            }
            if ('requestData' in sdkProcessingMetadata) {
                if (event.request) {
                    event.request.data = sdkProcessingMetadata.requestData;
                }
                else {
                    event.request = {
                        data: sdkProcessingMetadata.requestData,
                    };
                }
            }
            return event;
        });
    }
}
/**
 * Applies allowlists on existing user object.
 *
 * @param user
 * @param request
 * @param options
 * @returns New copy of user
 */
function toEventUser(user, request, options) {
    const ip_address = request.headers.get('CF-Connecting-IP');
    const { allowedIps } = options;
    const newUser = { ...user };
    if (!('ip_address' in user) && // If ip_address is already set from explicitly called setUser, we don't want to overwrite it
        ip_address &&
        allowedIps !== undefined &&
        testAllowlist(ip_address, allowedIps)) {
        newUser.ip_address = ip_address;
    }
    return Object.keys(newUser).length > 0 ? newUser : undefined;
}
/**
 * Converts data from fetch event's Request to Sentry Request used in Sentry Event
 *
 * @param request Native Request object
 * @param options Integration options
 * @returns Sentry Request object
 */
function toEventRequest(request, options) {
    // Build cookies
    const cookieString = request.headers.get('cookie');
    let cookies = undefined;
    if (cookieString) {
        try {
            cookies = parseCookie(cookieString);
        }
        catch (e) {
            // Cookie string failed to parse, no need to do anything
        }
    }
    const headers = {};
    // Build headers (omit cookie header, because we used it in the previous step)
    for (const [k, v] of request.headers.entries()) {
        if (k !== 'cookie') {
            headers[k] = v;
        }
    }
    const eventRequest = {
        method: request.method,
        cookies,
        headers,
    };
    try {
        const url = new URL(request.url);
        eventRequest.url = `${url.protocol}//${url.hostname}${url.pathname}`;
        eventRequest.query_string = url.search;
    }
    catch (e) {
        // `new URL` failed, let's try to split URL the primitive way
        const qi = request.url.indexOf('?');
        if (qi < 0) {
            // no query string
            eventRequest.url = request.url;
        }
        else {
            eventRequest.url = request.url.substr(0, qi);
            eventRequest.query_string = request.url.substr(qi + 1);
        }
    }
    // Let's try to remove sensitive data from incoming Request
    const { allowedHeaders, allowedCookies, allowedSearchParams } = options;
    if (allowedHeaders !== undefined && eventRequest.headers) {
        eventRequest.headers = applyAllowlistToObject(eventRequest.headers, allowedHeaders);
        if (Object.keys(eventRequest.headers).length === 0) {
            delete eventRequest.headers;
        }
    }
    else {
        delete eventRequest.headers;
    }
    if (allowedCookies !== undefined && eventRequest.cookies) {
        eventRequest.cookies = applyAllowlistToObject(eventRequest.cookies, allowedCookies);
        if (Object.keys(eventRequest.cookies).length === 0) {
            delete eventRequest.cookies;
        }
    }
    else {
        delete eventRequest.cookies;
    }
    if (allowedSearchParams !== undefined) {
        const params = Object.fromEntries(new URLSearchParams(eventRequest.query_string));
        const allowedParams = new URLSearchParams();
        Object.keys(applyAllowlistToObject(params, allowedSearchParams)).forEach((allowedKey) => {
            allowedParams.set(allowedKey, params[allowedKey]);
        });
        eventRequest.query_string = allowedParams.toString();
    }
    else {
        delete eventRequest.query_string;
    }
    return eventRequest;
}
/**
 * Helper function that tests 'allowlist' on string.
 *
 * @param target
 * @param allowlist
 * @returns True if target is allowed.
 */
function testAllowlist(target, allowlist) {
    if (typeof allowlist === 'boolean') {
        return allowlist;
    }
    else if (allowlist instanceof RegExp) {
        return allowlist.test(target);
    }
    else if (Array.isArray(allowlist)) {
        const allowlistLowercased = allowlist.map((item) => item.toLowerCase());
        return allowlistLowercased.includes(target);
    }
    else {
        return false;
    }
}
/**
 * Helper function that applies 'allowlist' to target's entries.
 *
 * @param target
 * @param allowlist
 * @returns New object with allowed keys.
 */
function applyAllowlistToObject(target, allowlist) {
    let predicate = () => false;
    if (typeof allowlist === 'boolean') {
        return allowlist ? target : {};
    }
    else if (allowlist instanceof RegExp) {
        predicate = (item) => allowlist.test(item);
    }
    else if (Array.isArray(allowlist)) {
        const allowlistLowercased = allowlist.map((item) => item.toLowerCase());
        predicate = (item) => allowlistLowercased.includes(item);
    }
    else {
        return {};
    }
    return Object.keys(target)
        .map((key) => key.toLowerCase())
        .filter((key) => predicate(key))
        .reduce((allowed, key) => {
        allowed[key] = target[key];
        return allowed;
    }, {});
}
/**
 * Converts cookie string to an object.
 *
 * @param cookieString
 * @returns Object of cookie entries, or empty object if something went wrong during the conversion.
 */
function parseCookie(cookieString) {
    if (typeof cookieString !== 'string') {
        return {};
    }
    try {
        return cookieString
            .split(';')
            .map((part) => part.split('='))
            .reduce((acc, [cookieKey, cookieValue]) => {
            acc[decodeURIComponent(cookieKey.trim())] = decodeURIComponent(cookieValue.trim());
            return acc;
        }, {});
    }
    catch {
        return {};
    }
}

/**
 * Installs integrations on the current scope.
 *
 * @param integrations array of integration instances
 */
function setupIntegrations(integrations, sdk) {
    const integrationIndex = {};
    integrations.forEach((integration) => {
        integrationIndex[integration.name] = integration;
        integration.setupOnce((callback) => {
            sdk.getScope()?.addEventProcessor(callback);
        }, () => sdk);
    });
    return integrationIndex;
}

/**
 * The Cloudflare Workers SDK Client.
 */
class ToucanClient extends BaseClient {
    /**
     * Some functions need to access the Hub (Toucan instance) this client is bound to,
     * but calling 'getCurrentHub()' is unsafe because it uses globals.
     * So we store a reference to the Hub after binding to it and provide it to methods that need it.
     */
    #sdk = null;
    /**
     * Creates a new Toucan SDK instance.
     * @param options Configuration options for this SDK.
     */
    constructor(options) {
        options._metadata = options._metadata || {};
        options._metadata.sdk = options._metadata.sdk || {
            name: 'toucan-js',
            packages: [
                {
                    name: 'npm:' + 'toucan-js',
                    version: '3.1.0',
                },
            ],
            version: '3.1.0',
        };
        super(options);
    }
    /**
     * By default, integrations are stored in a global. We want to store them in a local instance because they may have contextual data, such as event request.
     */
    setupIntegrations() {
        if (this._isEnabled() && !this._integrationsInitialized && this.#sdk) {
            this._integrations = setupIntegrations(this._options.integrations, this.#sdk);
            this._integrationsInitialized = true;
        }
    }
    eventFromException(exception, hint) {
        return resolvedSyncPromise(eventFromUnknownInput(this.#sdk, this._options.stackParser, exception, hint));
    }
    eventFromMessage(message, level = 'info', hint) {
        return resolvedSyncPromise(eventFromMessage(this._options.stackParser, message, level, hint, this._options.attachStacktrace));
    }
    _prepareEvent(event, hint, scope) {
        event.platform = event.platform || 'javascript';
        if (this.getOptions().request) {
            // Set 'request' on sdkProcessingMetadata to be later processed by RequestData integration
            event.sdkProcessingMetadata = setOnOptional(event.sdkProcessingMetadata, [
                'request',
                this.getOptions().request,
            ]);
        }
        if (this.getOptions().requestData) {
            // Set 'requestData' on sdkProcessingMetadata to be later processed by RequestData integration
            event.sdkProcessingMetadata = setOnOptional(event.sdkProcessingMetadata, [
                'requestData',
                this.getOptions().requestData,
            ]);
        }
        return super._prepareEvent(event, hint, scope);
    }
    getSdk() {
        return this.#sdk;
    }
    setSdk(sdk) {
        this.#sdk = sdk;
    }
    /**
     * Sets the request body context on all future events.
     *
     * @param body Request body.
     * @example
     * const body = await request.text();
     * toucan.setRequestBody(body);
     */
    setRequestBody(body) {
        this.getOptions().requestData = body;
    }
}

/**
 * Stack line parser for Cloudflare Workers.
 * This wraps node stack parser and adjusts root paths to match with source maps.
 *
 */
function workersStackLineParser(getModule) {
    const [arg1, arg2] = nodeStackLineParser(getModule);
    const fn = (line) => {
        const result = arg2(line);
        if (result) {
            const filename = result.filename;
            // Workers runtime runs a single bundled file that is always in a virtual root
            result.abs_path =
                filename !== undefined && !filename.startsWith('/')
                    ? `/${filename}`
                    : filename;
            // There is no way to tell what code is in_app and what comes from dependencies (node_modules), since we have one bundled file.
            // So everything is in_app, unless an error comes from runtime function (ie. JSON.parse), which is determined by the presence of filename.
            result.in_app = filename !== undefined;
        }
        return result;
    };
    return [arg1, fn];
}
/**
 * Gets the module from filename.
 *
 * @param filename
 * @returns Module name
 */
function getModule(filename) {
    if (!filename) {
        return;
    }
    // In Cloudflare Workers there is always only one bundled file
    return basename(filename, '.js');
}
/** Cloudflare Workers stack parser */
const defaultStackParser = createStackParser(workersStackLineParser(getModule));

/**
 * Creates a Transport that uses native fetch. This transport automatically extends the Workers lifetime with 'waitUntil'.
 */
function makeFetchTransport(options) {
    function makeRequest({ body, }) {
        try {
            const request = fetch(options.url, {
                method: 'POST',
                headers: options.headers,
                body,
            }).then((response) => {
                return {
                    statusCode: response.status,
                    headers: {
                        'retry-after': response.headers.get('Retry-After'),
                        'x-sentry-rate-limits': response.headers.get('X-Sentry-Rate-Limits'),
                    },
                };
            });
            /**
             * Call waitUntil to extend Workers Event lifetime
             */
            if (options.context) {
                options.context.waitUntil(request);
            }
            return request;
        }
        catch (e) {
            return rejectedSyncPromise(e);
        }
    }
    return createTransport(options, makeRequest);
}

/**
 * The Cloudflare Workers SDK.
 */
class Toucan extends Hub {
    constructor(options) {
        options.defaultIntegrations =
            options.defaultIntegrations === false
                ? []
                : [
                    ...(Array.isArray(options.defaultIntegrations)
                        ? options.defaultIntegrations
                        : [
                            new RequestData(options.requestDataOptions),
                            new LinkedErrors(),
                        ]),
                ];
        if (options.release === undefined) {
            const detectedRelease = getSentryRelease();
            if (detectedRelease !== undefined) {
                options.release = detectedRelease;
            }
        }
        const client = new ToucanClient({
            ...options,
            transport: makeFetchTransport,
            integrations: getIntegrationsToSetup(options),
            stackParser: stackParserFromStackParserOptions(options.stackParser || defaultStackParser),
            transportOptions: {
                ...options.transportOptions,
                context: options.context,
            },
        });
        super(client);
        client.setSdk(this);
        client.setupIntegrations();
    }
    /**
     * Sets the request body context on all future events.
     *
     * @param body Request body.
     * @example
     * const body = await request.text();
     * toucan.setRequestBody(body);
     */
    setRequestBody(body) {
        this.getClient()?.setRequestBody(body);
    }
}

export { LinkedErrors, RequestData, Toucan };
