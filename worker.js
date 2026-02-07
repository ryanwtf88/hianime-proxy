
import { connect } from 'cloudflare:sockets';

/**
 * A Transformer for ReadableStream to de-chunk HTTP/1.1 chunked encoding on the fly.
 * This ensures low memory usage and high speed for video segments.
 */
class DechunkingStream {
    constructor() {
        this.buffer = new Uint8Array(0);
        this.state = 'size'; // 'size', 'data', 'footer'
        this.chunkSize = 0;
        this.decoder = new TextDecoder();
    }

    transform(chunk, controller) {
        this.buffer = this.merge(this.buffer, chunk);

        while (this.buffer.length > 0) {
            if (this.state === 'size') {
                const lineEnd = this.buffer.indexOf(13); // \r
                if (lineEnd === -1) break;

                const sizeStr = this.decoder.decode(this.buffer.slice(0, lineEnd));
                this.chunkSize = parseInt(sizeStr, 16);
                this.buffer = this.buffer.slice(lineEnd + 2); // skip \r\n

                if (isNaN(this.chunkSize)) {
                    controller.error(new Error("Invalid chunk size: " + sizeStr));
                    return;
                }
                if (this.chunkSize === 0) {
                    this.state = 'footer';
                } else {
                    this.state = 'data';
                }
            } else if (this.state === 'data') {
                if (this.buffer.length < this.chunkSize) break;

                controller.enqueue(this.buffer.slice(0, this.chunkSize));
                this.buffer = this.buffer.slice(this.chunkSize + 2); // data + \r\n
                this.state = 'size';
            } else if (this.state === 'footer') {
                const lineEnd = this.buffer.indexOf(13);
                if (lineEnd === -1) break;
                this.buffer = this.buffer.slice(lineEnd + 2);
                if (lineEnd === 0) { // final \r\n
                    this.buffer = new Uint8Array(0);
                }
            }
        }
    }

    merge(a, b) {
        const res = new Uint8Array(a.length + b.length);
        res.set(a);
        res.set(b, a.length);
        return res;
    }
}

/**
 * Socket-based HTTP/1.1 client that supports streaming.
 */
async function socketFetch(url, options = {}) {
    const targetUrl = new URL(url);
    const host = targetUrl.hostname;
    const port = parseInt(targetUrl.port) || (targetUrl.protocol === 'https:' ? 443 : 80);
    const path = targetUrl.pathname + targetUrl.search;

    const socket = connect({ hostname: host, port: port }, { secureTransport: "on" });
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    const headers = options.headers || {};
    if (!headers['Host']) headers['Host'] = targetUrl.host;
    if (!headers['Connection']) headers['Connection'] = 'close';

    let requestStr = `GET ${path} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(headers)) {
        requestStr += `${key}: ${value}\r\n`;
    }
    requestStr += '\r\n';

    await writer.write(new TextEncoder().encode(requestStr));
    writer.releaseLock();

    let headLoaded = false;
    let leftover = new Uint8Array(0);
    let status = 200;
    let responseHeaders = {};

    // Read until headers are finished
    while (!headLoaded) {
        const { value, done } = await reader.read();
        if (done) break;
        leftover = new Uint8Array([...leftover, ...value]);
        const headEnd = new TextDecoder().decode(leftover, { stream: true }).indexOf('\r\n\r\n');

        if (headEnd !== -1) {
            headLoaded = true;
            const headText = new TextDecoder().decode(leftover, { stream: true }).substring(0, headEnd);
            const lines = headText.split('\r\n');
            status = parseInt(lines[0].split(' ')[1]) || 200;
            for (let i = 1; i < lines.length; i++) {
                const colon = lines[i].indexOf(':');
                if (colon !== -1) responseHeaders[lines[i].substring(0, colon).trim().toLowerCase()] = lines[i].substring(colon + 1).trim();
            }
            const headBytes = new TextEncoder().encode(headText + '\r\n\r\n');
            leftover = leftover.slice(headBytes.length);
        }
    }

    let bodyStream = new ReadableStream({
        async start(controller) {
            if (leftover.length > 0) controller.enqueue(leftover);
        },
        async pull(controller) {
            const { value, done } = await reader.read();
            if (done) {
                controller.close();
            } else {
                controller.enqueue(value);
            }
        },
        cancel() {
            reader.cancel();
        }
    });

    if (responseHeaders['transfer-encoding'] === 'chunked') {
        bodyStream = bodyStream.pipeThrough(new TransformStream(new DechunkingStream()));
        delete responseHeaders['transfer-encoding'];
    }

    return {
        status,
        headers: new Headers(responseHeaders),
        body: bodyStream
    };
}

export default {
    async fetch(request, env, ctx) {
        const urlObj = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, Accept-Encoding',
                    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Cache-Control',
                    'Access-Control-Max-Age': '86400',
                }
            });
        }

        const url = urlObj.searchParams.get('url');
        const referer = urlObj.searchParams.get('referer');

        if (!url) {
            return new Response('URL parameter is required', {
                status: 400,
                headers: { 'Access-Control-Allow-Origin': '*' }
            });
        }

        try {
            // Determine the correct referer
            let targetReferer = referer || 'https://megacloud.tv/';
            const targetUrl = new URL(url);
            
            // Special handling for cdn.dotstream.buzz (megaplay CDN)
            if (targetUrl.hostname === 'cdn.dotstream.buzz') {
                // For dotstream CDN, use megaplay.buzz as referer
                targetReferer = 'https://megaplay.buzz/';
            }
            // If referer is just megacloud domain, construct a full embed URL
            else if (targetReferer === 'https://megacloud.tv' || targetReferer === 'https://megacloud.tv/') {
                // Extract video ID from URL if possible
                const urlPath = targetUrl.pathname;
                const videoIdMatch = urlPath.match(/\/([a-f0-9]{64,})\//);
                if (videoIdMatch) {
                    targetReferer = `https://megacloud.tv/embed-2/e-1/${videoIdMatch[1]}`;
                } else {
                    targetReferer = 'https://megacloud.tv/embed-2/e-1/';
                }
            }
            
            const targetOrigin = new URL(targetReferer).origin;

            const headersMap = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
                'Referer': targetReferer,
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
            };

            const rangeHeader = request.headers.get('Range');
            if (rangeHeader) headersMap['Range'] = rangeHeader;

            // Forward other relevant headers if present
            const xRequestedWith = request.headers.get('X-Requested-With');
            if (xRequestedWith) headersMap['X-Requested-With'] = xRequestedWith;

            let response;
            const isNonStandardPort = url.includes(':2228');
            
            // List of CDNs that need special handling with socketFetch
            // These CDNs block Cloudflare Worker IPs, so we use raw socket connections
            const needsSocketFetch = isNonStandardPort || 
                targetUrl.hostname.includes('haildrop') ||
                targetUrl.hostname.includes('douvid') ||
                targetUrl.hostname.includes('lightningspark') ||
                targetUrl.hostname.includes('sunburst') ||
                targetUrl.hostname.includes('sunshinerays') ||
                targetUrl.hostname.includes('rainveil') ||
                targetUrl.hostname.includes('fogtwist') ||
                targetUrl.hostname.includes('stormshade') ||
                targetUrl.hostname.includes('netmagcdn');

            if (needsSocketFetch) {
                const sRes = await socketFetch(url, { headers: headersMap });
                response = {
                    status: sRes.status,
                    headers: sRes.headers,
                    ok: sRes.status >= 200 && sRes.status < 300 || sRes.status === 206,
                    body: sRes.body,
                };
            } else {
                const res = await fetch(url, {
                    method: 'GET',
                    headers: new Headers(headersMap),
                    redirect: 'follow'
                });
                response = {
                    status: res.status,
                    headers: res.headers,
                    ok: res.ok,
                    body: res.body,
                };
            }

            const responseHeaders = new Headers(response.headers);
            responseHeaders.set('Access-Control-Allow-Origin', '*');
            responseHeaders.set('X-Proxy-Version', '1.2.1-no-origin');

            if (!response.ok && response.status !== 206) {
                return new Response("Upstream error " + response.status, {
                    status: response.status,
                    headers: responseHeaders
                });
            }

            responseHeaders.delete('Content-Security-Policy');
            responseHeaders.delete('X-Frame-Options');

            const contentType = responseHeaders.get('content-type') || '';

            // HLS manifest rewriting still requires buffering
            if (contentType.includes('mpegurl') || url.includes('.m3u8')) {
                // Buffer the entire manifest
                const manifestText = await new Response(response.body).text();
                const basePath = url.substring(0, url.lastIndexOf('/') + 1);
                const workerUrl = `${urlObj.origin}${urlObj.pathname}`;

                const proxyLine = (line) => {
                    let fullUrl = line;
                    if (!line.startsWith('http')) {
                        if (line.startsWith('/')) {
                            fullUrl = new URL(url).origin + line;
                        } else {
                            fullUrl = basePath + line;
                        }
                    }
                    return `${workerUrl}?url=${encodeURIComponent(fullUrl)}&referer=${encodeURIComponent(targetReferer)}`;
                };

                const lines = manifestText.split('\n');
                const newLines = lines.map(line => {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) return line;
                    if (trimmedLine.startsWith('#')) {
                        return trimmedLine.replace(/URI=["']([^"']+)["']/, (match, uri) => {
                            return `URI="${proxyLine(uri)}"`;
                        });
                    }
                    return proxyLine(trimmedLine);
                });

                return new Response(newLines.join('\n'), {
                    status: response.status,
                    headers: responseHeaders
                });
            }

            // For segments or other binary data, stream it directly for speed and memory efficiency
            return new Response(response.body, {
                status: response.status,
                headers: responseHeaders
            });

        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }
    }
};
