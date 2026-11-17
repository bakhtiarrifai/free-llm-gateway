// Server-sent events in both directions.

// Parses an SSE byte stream into {event, data} records. `data` is parsed JSON, or the raw string ("[DONE]").
export async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
      const rec = toRecord(raw);
      if (rec) yield rec;
    }
  }
  const rec = toRecord(buffer);
  if (rec) yield rec;
}

function toRecord(raw) {
  let event;
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  const text = data.join("\n");
  try {
    return { event, data: JSON.parse(text) };
  } catch {
    return { event, data: text };
  }
}

export function startSSE(res) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
}
export const writeData = (res, data) => res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
export const writeEvent = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
