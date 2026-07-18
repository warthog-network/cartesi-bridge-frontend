const PROXY_URL = '/api/proxy';

function parseNodeResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.trim().slice(0, 120).replace(/\s+/g, ' ');
    const hint = preview.startsWith('<') || preview.startsWith('<!')
      ? 'Node returned HTML instead of JSON. Check the node URL and port (API paths like /chain/head should return JSON). HTTP nodes on the live HTTPS site are reached via the server proxy.'
      : `Node returned non-JSON: ${preview}`;
    throw new Error(hint);
  }
}

/**
 * Browser WarthogApi: direct fetch for loopback nodes on HTTP pages; JSON POST proxy otherwise.
 * Avoids putting http:// node URLs in query strings (WAF/HTML issues on some hosts).
 */
export function createBrowserWarthogApi(WarthogApi, baseUrl, { useProxy = false } = {}) {
  class BrowserWarthogApi extends WarthogApi {
    constructor(normalizedBase, proxy) {
      super(normalizedBase, { proxyUrl: null });
      this._useProxy = proxy;
    }

    async request(path, options = {}) {
      let nodePath = path.replace(/^\//, '');

      if (options.queryParams) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(options.queryParams)) {
          params.append(key, String(value));
        }
        const qs = params.toString();
        if (qs) {
          nodePath = `${nodePath}?${qs}`;
        }
      }

      const replacer = (_key, value) => (typeof value === 'bigint' ? Number(value) : value);

      let response;
      if (this._useProxy) {
        const envelope = {
          nodeBase: this.baseUrl,
          nodePath,
          method: options.method || 'GET',
        };
        if (options.body) {
          envelope.body = JSON.parse(JSON.stringify(options.body, replacer));
        }
        response = await fetch(PROXY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope),
        });
      } else {
        const url = nodePath ? `${this.baseUrl}/${nodePath}` : `${this.baseUrl}/`;
        const body = options.body ? JSON.stringify(options.body, replacer) : undefined;
        response = await fetch(url, {
          method: options.method || 'GET',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
      }

      const text = await response.text();
      const json = parseNodeResponse(text);

      if (json.code !== 0) {
        return {
          success: false,
          code: json.code,
          error: json.error || 'Unknown error',
        };
      }

      return { success: true, data: json.data };
    }
  }

  const normalized = baseUrl.replace(/\/+$/, '');
  return new BrowserWarthogApi(normalized, useProxy);
}