
// Load modules

var Url = require('url');
var Http = require('http');
var Https = require('https');
var Stream = require('stream');
var Hoek = require('hoek');
var Boom = require('boom');
var Payload = require('./payload');
var Recorder = require('./recorder');
var Tap = require('./tap');


// Declare internals

var internals = {};


exports.agents = {
    https: new Https.Agent({ maxSockets: Infinity }),
    http: new Http.Agent({ maxSockets: Infinity }),
    httpsAllowUnauthorized: new Https.Agent({ maxSockets: Infinity, rejectUnauthorized: false })
};


exports.request = function (method, url, options, callback, _trace) {

    options = options || {};

    Hoek.assert(options.payload === null || options.payload === undefined || typeof options.payload === 'string' ||
        options.payload instanceof Stream || Buffer.isBuffer(options.payload),
        'options.payload must be a string, a Buffer, or a Stream');

    Hoek.assert((options.agent === undefined || options.agent === null) || (typeof options.rejectUnauthorized !== 'boolean'),
        'options.agent cannot be set to an Agent at the same time as options.rejectUnauthorized is set');

    // Setup request

    var uri = Url.parse(url);
    var timeoutId;
    uri.method = method.toUpperCase();
    uri.headers = options.headers;

    var payloadSupported = (uri.method !== 'GET' && uri.method !== 'HEAD' && options.payload !== null && options.payload !== undefined);
    if (payloadSupported &&
        (typeof options.payload === 'string' || Buffer.isBuffer(options.payload))) {

        uri.headers = Hoek.clone(uri.headers) || {};
        uri.headers['Content-Length'] = Buffer.isBuffer(options.payload) ? options.payload.length : Buffer.byteLength(options.payload);
    }

    var redirects = (options.hasOwnProperty('redirects') ? options.redirects : false);      // Needed to allow 0 as valid value when passed recursively

    _trace = (_trace || []);
    _trace.push({ method: uri.method, url: url });

    var client = (uri.protocol === 'https:' ? Https : Http);

    if (options.rejectUnauthorized !== undefined && uri.protocol === 'https:') {
        uri.agent = options.rejectUnauthorized ? exports.agents.https : exports.agents.httpsAllowUnauthorized;
    }
    else if (options.agent || options.agent === false) {
        uri.agent = options.agent;
    }
    else {
        uri.agent = uri.protocol === 'https:' ? exports.agents.https : exports.agents.http;
    }

    if (options.secureProtocol !== undefined) {
        uri.secureProtocol = options.secureProtocol;
    }

    var req = client.request(uri);

    var shadow = null;                                                                      // A copy of the streamed request payload when redirects are enabled

    // Register handlers

    var finish = function (err, res) {

        if (!callback || err) {
            if (res) {
                res.destroy();
            }

            req.abort();
        }

        req.removeListener('response', onResponse);
        req.removeListener('error', onError);
        req.on('error', Hoek.ignore);
        clearTimeout(timeoutId);

        if (callback) {
            return callback(err, res);
        }
    };

    finish = Hoek.once(finish);

    var onError = function (err) {

        err.trace = _trace;
        return finish(Boom.badGateway('Client request error', err));
    };

    req.once('error', onError);

    var onResponse = function (res) {

        // Pass-through response

        if (redirects === false ||
            [301, 302, 307, 308].indexOf(res.statusCode) === -1) {

            return finish(null, res);
        }

        // Redirection

        var redirectMethod = (res.statusCode === 301 || res.statusCode === 302 ? 'GET' : uri.method);
        var location = res.headers.location;

        res.destroy();

        if (redirects === 0) {
            return finish(Boom.badGateway('Maximum redirections reached', _trace));
        }

        if (!location) {
            return finish(Boom.badGateway('Received redirection without location', _trace));
        }

        if (!/^https?:/i.test(location)) {
            location = Url.resolve(uri.href, location);
        }

        var redirectOptions = {
            headers: options.headers,
            payload: shadow || options.payload,         // shadow must be ready at this point if set
            redirects: --redirects
        };

        return exports.request(redirectMethod, location, redirectOptions, finish, _trace);
    };

    req.once('response', onResponse);

    if (options.timeout) {
        timeoutId = setTimeout(function () {

            return finish(Boom.gatewayTimeout('Client request timeout'));
        }, options.timeout);
    }

    // Write payload

    if (payloadSupported) {
        if (options.payload instanceof Stream) {
            var stream = options.payload;

            if (redirects) {
                var collector = new Tap();
                collector.once('finish', function () {

                    shadow = collector.collect();
                });

                stream = options.payload.pipe(collector);
            }

            stream.pipe(req);
            return;
        }

        req.write(options.payload);
    }

    // Finalize request

    req.end();

    return req;
};


// read()

exports.read = function (res, options, callback) {

    options = options || {};

    // Set stream timeout

    var clientTimeout = options.timeout;
    var clientTimeoutId = null;

    if (clientTimeout &&
        clientTimeout > 0) {

        clientTimeoutId = setTimeout(function () {

            finish(Boom.clientTimeout());
        }, clientTimeout);
    }

    // Finish once

    var finish = function (err, buffer) {

        clearTimeout(clientTimeoutId);
        reader.removeListener('error', onReaderError);
        reader.removeListener('finish', onReaderFinish);
        res.removeListener('error', onResError);
        res.removeListener('close', onResClose);
        res.on('error', Hoek.ignore);

        if (err || !options.json) {
            return callback(err, buffer);
        }

        // Parse JSON

        var result;
        if (buffer.length === 0) {
            return callback(null, null);
        }

        if (options.json === 'force') {
            result = internals.tryParseBuffer(buffer);
            return callback(result.err, result.json);
        }

        // mode is "smart" or true

        var contentType = (res.headers && res.headers['content-type']) || '';
        var mime = contentType.split(';')[0].trim().toLowerCase();

        if (mime !== 'application/json') {
            return callback(null, buffer);
        }

        result = internals.tryParseBuffer(buffer);
        return callback(result.err, result.json);
    };

    finish = Hoek.once(finish);

    // Hander errors

    var onResError = function (err) {

        return finish(Boom.internal('Payload stream error', err));
    };

    var onResClose = function () {

        return finish(Boom.internal('Payload stream closed prematurely'));
    };

    res.once('error', onResError);
    res.once('close', onResClose);

    // Read payload

    var reader = new Recorder({ maxBytes: options.maxBytes });

    var onReaderError = function (err) {

        res.destroy();
        return finish(err);
    };

    reader.once('error', onReaderError);

    var onReaderFinish = function () {

        return finish(null, reader.collect());
    };

    reader.once('finish', onReaderFinish);

    res.pipe(reader);
};


// toReadableStream()

exports.toReadableStream = function (payload, encoding) {

    return new Payload(payload, encoding);
};


// parseCacheControl()

exports.parseCacheControl = function (field) {

    /*
        Cache-Control   = 1#cache-directive
        cache-directive = token [ "=" ( token / quoted-string ) ]
        token           = [^\x00-\x20\(\)<>@\,;\:\\"\/\[\]\?\=\{\}\x7F]+
        quoted-string   = "(?:[^"\\]|\\.)*"
    */

    //                             1: directive                                        =   2: token                                              3: quoted-string
    var regex = /(?:^|(?:\s*\,\s*))([^\x00-\x20\(\)<>@\,;\:\\"\/\[\]\?\=\{\}\x7F]+)(?:\=(?:([^\x00-\x20\(\)<>@\,;\:\\"\/\[\]\?\=\{\}\x7F]+)|(?:\"((?:[^"\\]|\\.)*)\")))?/g;

    var header = {};
    var err = field.replace(regex, function ($0, $1, $2, $3) {

        var value = $2 || $3;
        header[$1] = value ? value.toLowerCase() : true;
        return '';
    });

    if (header['max-age']) {
        try {
            var maxAge = parseInt(header['max-age'], 10);
            if (isNaN(maxAge)) {
                return null;
            }

            header['max-age'] = maxAge;
        }
        catch (err) { }
    }

    return (err ? null : header);
};


// Shortcuts

exports.get = function (uri, options, callback) {

    return internals.shortcutWrap('GET', uri, options, callback);
};


exports.post = function (uri, options, callback) {

    return internals.shortcutWrap('POST', uri, options, callback);
};


exports.put = function (uri, options, callback) {

    return internals.shortcutWrap('PUT', uri, options, callback);
};


exports.delete = function (uri, options, callback) {

    return internals.shortcutWrap('DELETE', uri, options, callback);
};


// Wrapper so that shortcut can be optimized with required params
internals.shortcutWrap = function (method, uri /* [options], callback */) {

    var options = (typeof arguments[2] === 'function' ? {} : arguments[2]);
    var callback = (typeof arguments[2] === 'function' ? arguments[2] : arguments[3]);

    return internals.shortcut(method, uri, options, callback);
};


internals.shortcut = function (method, uri, options, callback) {

    return exports.request(method, uri, options, function (err, res) {

        if (err) {
            return callback(err);
        }

        exports.read(res, options, function (err, payload) {

            if (payload instanceof Buffer) {
                payload = payload.toString();
            }

            return callback(err, res, payload);
        });
    });
};


internals.tryParseBuffer = function (buffer) {

    var result = {
        json: null,
        err: null
    };
    try {
        var json = JSON.parse(buffer.toString());
        result.json = json;
    }
    catch (err) {
        result.err = err;
    }
    return result;
};
