export async function readJsonBody(req: any): Promise<any> {
  // Vercel Node.js Serverless Functions sometimes don't pre-parse req.body.
  // Support: already-parsed object, string body, or raw IncomingMessage stream.
  const existing = (req as any)?.body;
  if (existing && typeof existing === "object") return existing;
  if (typeof existing === "string") {
    try {
      return JSON.parse(existing);
    } catch {
      throw new Error("Invalid JSON body");
    }
  }

  // Stream read
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    try {
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve());
      req.on("error", (e: any) => reject(e));
    } catch (e) {
      reject(e);
    }
  });
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}


