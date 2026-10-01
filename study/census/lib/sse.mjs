// Incremental parser for Sourcegraph's streaming search API
// (text/event-stream: "event: <name>" then "data: <json>" lines). The answer
// for a whole frame is several megabytes, so it is parsed as it arrives.

export function sseParser(onEvent) {
  let buffer = "";
  let event = "message";
  let data = [];
  const flush = () => {
    if (data.length) {
      const text = data.join("\n");
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      onEvent(event, json, text);
    }
    event = "message";
    data = [];
  };
  const line = (l) => {
    if (l.endsWith("\r")) l = l.slice(0, -1);
    if (l === "") return flush();
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    const value = i < 0 ? "" : l.slice(i + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };
  return {
    push(chunk) {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    },
    end() {
      if (buffer) line(buffer);
      buffer = "";
      flush();
    },
  };
}

/** Read a streaming Response (or a Buffer/string) through the parser. */
export async function readStream(body, onEvent) {
  const p = sseParser(onEvent);
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    p.push(body.toString("utf8"));
    p.end();
    return;
  }
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of body.body) p.push(decoder.decode(chunk, { stream: true }));
  p.push(decoder.decode());
  p.end();
}
