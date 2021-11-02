/**
 * 每个请求的connection对象
 */
const url = require('url');
const assert = require('assert');
const Stream = require('stream');

const parse = require('parseurl');
const statuses = require('statuses');
const getType = require('cache-content-type');
const onFinish = require('on-finished');
const destroy = require('destroy');
const InterceptorFactory = require('./InterceptorFactory');

const stringify = url.format;
let id = 1;
const genId = () => id++;

module.exports = class Connection {
    constructor(req, res, isSSL = false, websocketConnect) {
        this._isSSL = isSSL;

        this._id = genId();
        this._blocking = true;
        this._protocol = isSSL ? 'https' : 'http';
        this.isWebSocket = !!websocketConnect;
        const request = createRequest(req, isSSL);
        this.request = request;

        this.timing = {
            start: Date.now()
        };
        if (this.isWebSocket) {
            this.websocket = createWebSocket(res, req);
        } else {
            this.response = createResponse(res, req);
        }
    }
    isBlockable() {
        return this._blocking === true;
    }
    setBlocking(blocking) {
        this._blocking = !!blocking;
    }

    getId() {
        return this._id;
    }
    getInterceptorFilter() {
        // 创建filter context
        const context = {
            url: this.request.url,
            path: this.request.path,
            method: this.request.method,
            host: this.request.host,
            headers: this.request.headers
        };
        const interceptorFilter = InterceptorFactory.createFilter(context);
        return interceptorFilter;
    }
    destroy() {
        this.request = null;
        this.response = null;
        this.timing = null;
    }
    getTiming() {
        return this.timing;
    }
    close() {
        this.destroy();
    }
};
function createWebSocket(ws) {
    return Object.call(null);
}
function createResponse(userRes, req) {
    const cloneRes = Object.create(null);
    cloneRes.headers = {};

    return Object.create({
        // =========readonly==========
        get res() {
            return userRes;
        },
        get headerSent() {
            return userRes.headerSent;
        },
        get finished() {
            if ('writableEnded' in userRes) {
                return userRes.writableEnded;
            }
            return userRes.finished;
        },
        // =========methods==========
        setHeader(name, value) {
            if (!name || !value) {
                return;
            }
            if (this.headerSent) {
                return;
            }

            if (typeof value !== 'string') {
                value = String(value);
            }
            cloneRes.headers[name.toLowerCase()] = value;
        },
        removeHeader(name) {
            cloneRes.headers[name] = null;
            delete cloneRes.headers[name];
        },
        getHeader(name) {
            return cloneRes.headers[name.toLowerCase()];
        },
        write(chunk) {
            userRes.write(chunk);
        },
        end(str) {
            userRes.end(str);
        },
        // =========write==========
        get body() {
            return cloneRes._body;
        },
        set body(val) {
            const original = cloneRes._body;
            cloneRes._body = val;

            // no content
            if (null == val) {
                if (!statuses.empty[this.statusCode]) {
                    this.statusCode = 204;
                }
                if (val === null) {
                    this._explicitNullBody = true;
                }
                this.removeHeader('Content-Type');
                this.removeHeader('Content-Length');
                this.removeHeader('Transfer-Encoding');
                return;
            }

            // set the status
            if (!this._explicitStatus) {
                this.statusCode = 200;
            }
            // set the content-type only if not yet set
            const setType = !this.getHeader('Content-Type');

            // string
            if ('string' === typeof val) {
                if (setType) {
                    this.type = /^\s*</.test(val) ? 'html' : 'text';
                }
                this.length = Buffer.byteLength(val);
                return;
            }

            // buffer
            if (Buffer.isBuffer(val)) {
                if (setType) {
                    this.type = 'bin';
                }
                this.length = val.length;
                return;
            }

            // stream
            if (val instanceof Stream) {
                onFinish(userRes, destroy.bind(null, val));
                if (original != val) {
                    // overwriting
                    if (null != original) {
                        this.removeHeader('Content-Length');
                    }
                }

                if (setType) {
                    this.type = 'bin';
                }
                return;
            }
        },
        get statusCode() {
            return cloneRes.statusCode;
        },
        set statusCode(code) {
            if (userRes.headerSent) {
                return;
            }

            assert(Number.isInteger(code), 'status code must be a number');
            assert(code >= 100 && code <= 999, `invalid status code: ${code}`);
            this._explicitStatus = true;
            cloneRes.statusCode = code;
            if (req.httpVersionMajor < 2) {
                cloneRes.statusMessage = statuses[code];
            }
            if (this.body && statuses.empty[code]) {
                this.body = null;
            }
        },
        get headers() {
            return cloneRes.headers;
        },
        set headers(val) {
            cloneRes.headers = val;
        },
        set length(n) {
            this.setHeader('Content-Length', n);
        },
        get length() {
            const length = this.getHeader('Content-Length');
            if (length) {
                return parseInt(length, 10) || 0;
            }

            const body = this.body;
            if (!body || body instanceof Stream) {
                return undefined;
            }
            if ('string' === typeof body) {
                return Buffer.byteLength(body);
            }
            if (Buffer.isBuffer(body)) {
                return body.length;
            }
            return Buffer.byteLength(JSON.stringify(body));
        },
        get type() {
            const type = this.getHeader('Content-Type');
            if (!type) {
                return '';
            }
            return type.split(';', 1)[0];
        },
        set type(type) {
            type = getType(type);
            if (type) {
                this.setHeader('Content-Type', type);
            } else {
                this.removeHeader('Content-Type');
            }
        }
    });
}
function createRequest(req, isSSL) {
    const clonedReq = Object.create(null);

    ['headers', 'url', 'method'].forEach(k => {
        clonedReq[k] = req[k];
    });
    const hostPort = parseHostAndPort(req, isSSL ? 443 : 80);
    clonedReq.host = hostPort.host;
    clonedReq.port = hostPort.port;

    return Object.create({
        // ========readonly========
        get req() {
            return req;
        },
        get originalUrl() {
            return req.url;
        },
        // ========writeable=====
        get port() {
            return clonedReq.port;
        },
        set port(port) {
            clonedReq.port = port;
        },
        get host() {
            return clonedReq.host;
        },
        set host(value) {
            clonedReq.host = value;
        },
        get headers() {
            return clonedReq.headers;
        },
        set headers(val) {
            clonedReq.headers = val;
        },
        get method() {
            return clonedReq.method;
        },
        set method(val) {
            clonedReq.method = val;
        },
        get url() {
            return clonedReq.url;
        },
        set url(val) {
            clonedReq.url = val;
        },
        get body() {
            return clonedReq.body;
        },
        set body(val) {
            clonedReq.body = val;
        },
        get path() {
            return parse(clonedReq).path;
        },
        set path(path) {
            const url = parse(clonedReq);
            if (url.path === path) {
                return;
            }

            url.path = path;
            this.url = stringify(url);
        },
        get pathname() {
            return parse(clonedReq).pathname;
        },
        set pathname(pathname) {
            const url = parse(clonedReq);
            if (url.pathname === pathname) {
                return;
            }

            url.pathname = pathname;

            this.url = stringify(url);
        },
        // ========methods=======
        setHeader(key, value) {
            if (!value || !key) {
                return;
            }
            if (typeof value !== 'string') {
                value = String(value);
            }
            clonedReq.headers[key.toLowerCase()] = value;
        },
        getHeader(key) {
            return clonedReq.headers[key.toLowerCase()];
        }
    });
}

function parseHostAndPort(req, defaultPort) {
    const m = req.url.match(/^http:\/\/([^\/]+)(.*)/);
    if (m) {
        req.url = m[2] || '/';
        return parseHost(m[1], defaultPort);
    } else if (req.headers.host) {
        return parseHost(req.headers.host, defaultPort);
    }
    return null;
}

function parseHost(hostString, defaultPort) {
    const m = hostString.match(/^http:\/\/(.*)/);
    if (m) {
        const parsedUrl = url.parse(hostString);
        return {
            host: parsedUrl.hostname,
            port: parsedUrl.port
        };
    }

    const hostPort = hostString.split(':');
    const host = hostPort[0];
    const port = hostPort.length === 2 ? +hostPort[1] : defaultPort;

    return {
        host: host,
        port: port
    };
}
