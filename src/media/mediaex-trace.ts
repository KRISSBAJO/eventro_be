// Only these response fields are safe to record. Upload plans may contain signed URLs.
const assetId = /^ast_[a-z0-9]{6,20}$/;
const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function mediaexTrace(path: string, method: string, started: number, response?: Response, data?: unknown, error?: unknown) {
  const [, resource, id, operation, part] = path.split('/');
  const asset = (data as { asset?: { id?: unknown } } | null)?.asset?.id;
  const candidate = id ?? asset;
  const trace = response?.headers.get('x-mediaex-request-id');
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  const stage = resource === 'assets' ? 'status' : !id ? 'create' : operation === 'complete' ? 'complete'
    : operation !== 'parts' ? 'transfer' : part ? 'transfer-part' : method === 'POST' ? 'renew-parts' : 'list-parts';
  return {
    event: 'omoshow.mediaex', stage, method, status: response?.status ?? null,
    elapsedMs: Date.now() - started,
    ...(typeof candidate === 'string' && assetId.test(candidate) && { assetId: candidate }),
    ...(trace && requestId.test(trace) && { mediaexRequestId: trace }),
    ...(typeof code === 'string' && /^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]{1,32})$/.test(code) && { networkCode: code }),
  };
}
