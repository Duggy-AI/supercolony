import { createServer } from 'node:http';

export function sendJson(response, status, data, headers = {}) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

export async function startMock(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      const record = { method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers, body };
      requests.push(record);
      handler({ request, response, record, requests });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
