const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DB_PATH = path.join(__dirname, "data.json");

const clientsByRoom = new Map();

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (error) {
    return { rooms: {} };
  }
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function sanitizeRoomCode(code) {
  return String(code || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 40);
}

function sanitizeName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 30);
}

function sanitizeMessage(message) {
  return String(message || "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, 1000);
}

function sanitizeMessageId(id) {
  return String(id || "")
    .trim()
    .replace(/[^a-zA-Z0-9-_]/g, "")
    .slice(0, 80);
}

function sanitizeReaction(value) {
  return String(value || "").trim().slice(0, 16);
}

function sanitizeAvatar(avatar) {
  const value = String(avatar || "").trim();
  if (!value) {
    return "";
  }

  const isDataImage = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=]+$/i.test(value);
  if (isDataImage && value.length <= 900000) {
    return value;
  }

  return "";
}

function sanitizeGifUrl(url) {
  const value = String(url || "").trim();
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }

    const host = parsed.hostname.toLowerCase();
    if (host.includes("giphy.com") && !host.includes("media.giphy.com")) {
      const parts = parsed.pathname.split("-").filter(Boolean);
      const id = parts[parts.length - 1];
      if (id) {
        return `https://media.giphy.com/media/${id}/giphy.gif`;
      }
    }

    return parsed.toString().slice(0, 500);
  } catch (error) {
    return "";
  }
}

function fetchText(targetUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("Too many redirects"));
      return;
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (error) {
      reject(new Error("Invalid URL"));
      return;
    }

    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.get(
      targetUrl,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 ChatAppResolver",
          Accept: "text/html,application/xhtml+xml"
        }
      },
      (response) => {
        const statusCode = response.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
          const nextUrl = new URL(response.headers.location, targetUrl).toString();
          response.resume();
          fetchText(nextUrl, redirects + 1).then(resolve).catch(reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`Failed to fetch URL (${statusCode})`));
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 2_000_000) {
            request.destroy(new Error("Response too large"));
          }
        });
        response.on("end", () => resolve(body));
      }
    );

    request.on("error", reject);
  });
}

function extractGifCandidate(html, pageUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      try {
        return new URL(match[1], pageUrl).toString();
      } catch (error) {
        return match[1];
      }
    }
  }

  return "";
}

async function resolveGifUrl(url) {
  const directUrl = sanitizeGifUrl(url);
  if (!directUrl) {
    return "";
  }

  if (/\.(gif|webp|png|jpg|jpeg)(\?|$)/i.test(directUrl)) {
    return directUrl;
  }

  try {
    const html = await fetchText(directUrl);
    return sanitizeGifUrl(extractGifCandidate(html, directUrl));
  } catch (error) {
    return directUrl;
  }
}

function ensureRoom(db, roomCode) {
  if (!db.rooms[roomCode]) {
    db.rooms[roomCode] = {
      code: roomCode,
      createdAt: new Date().toISOString(),
      messages: []
    };
  }

  return db.rooms[roomCode];
}

function normalizeRoom(room) {
  room.messages = (room.messages || []).map((message) => ({
    reactions: {},
    replyTo: null,
    ...message
  }));
  return room;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendEvent(roomCode, payload) {
  const roomClients = clientsByRoom.get(roomCode);
  if (!roomClients) {
    return;
  }

  const message = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of roomClients) {
    client.write(message);
  }
}

function addClient(roomCode, response) {
  if (!clientsByRoom.has(roomCode)) {
    clientsByRoom.set(roomCode, new Set());
  }

  clientsByRoom.get(roomCode).add(response);
}

function removeClient(roomCode, response) {
  const roomClients = clientsByRoom.get(roomCode);
  if (!roomClients) {
    return;
  }

  roomClients.delete(response);
  if (roomClients.size === 0) {
    clientsByRoom.delete(roomCode);
  }
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });

    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    request.on("error", reject);
  });
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };

  return types[extension] || "application/octet-stream";
}

function serveFile(requestPath, response) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, normalizedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    response.writeHead(200, {
      "Content-Type": getContentType(filePath)
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && requestUrl.pathname === "/api/room") {
    const roomCode = sanitizeRoomCode(requestUrl.searchParams.get("code"));
    if (!roomCode) {
      sendJson(response, 400, { error: "Room code is required." });
      return;
    }

    const db = readDb();
    const room = normalizeRoom(ensureRoom(db, roomCode));
    writeDb(db);
    sendJson(response, 200, { room });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/stream") {
    const roomCode = sanitizeRoomCode(requestUrl.searchParams.get("code"));
    if (!roomCode) {
      sendJson(response, 400, { error: "Room code is required." });
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.write("\n");

    addClient(roomCode, response);

    request.on("close", () => {
      removeClient(roomCode, response);
    });

    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/resolve-gif") {
    const rawUrl = requestUrl.searchParams.get("url");
    const gifUrl = await resolveGifUrl(rawUrl);

    if (!gifUrl) {
      sendJson(response, 400, { error: "Could not resolve GIF URL." });
      return;
    }

    sendJson(response, 200, { gifUrl });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/join") {
    try {
      const {
        roomCode: rawRoomCode,
        name: rawName,
        avatar: rawAvatar
      } = await parseBody(request);
      const roomCode = sanitizeRoomCode(rawRoomCode);
      const name = sanitizeName(rawName) || "Someone";
      const avatar = sanitizeAvatar(rawAvatar);

      if (!roomCode) {
        sendJson(response, 400, { error: "Room code is required." });
        return;
      }

      const db = readDb();
      const room = normalizeRoom(ensureRoom(db, roomCode));
      const systemMessage = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: "system",
        author: "System",
        authorAvatar: avatar,
        text: `${name} joined the room.`,
        createdAt: new Date().toISOString()
      };

      room.messages.push(systemMessage);
      room.messages = room.messages.slice(-200);
      writeDb(db);
      sendEvent(roomCode, { event: "message", message: systemMessage });
      sendJson(response, 200, { ok: true, room });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/message") {
    try {
      const {
        roomCode: rawRoomCode,
        name: rawName,
        text: rawText,
        avatar: rawAvatar,
        gifUrl: rawGifUrl,
        replyTo: rawReplyTo
      } = await parseBody(request);

      const roomCode = sanitizeRoomCode(rawRoomCode);
      const name = sanitizeName(rawName) || "Anonymous";
      const text = sanitizeMessage(rawText);
      const avatar = sanitizeAvatar(rawAvatar);
      const gifUrl = sanitizeGifUrl(rawGifUrl);
      const replyTo = sanitizeMessageId(rawReplyTo);

      if (!roomCode || (!text && !gifUrl)) {
        sendJson(response, 400, { error: "Room code and a message or GIF are required." });
        return;
      }

      const db = readDb();
      const room = normalizeRoom(ensureRoom(db, roomCode));
      const repliedMessage = replyTo
        ? room.messages.find((message) => message.id === replyTo) || null
        : null;
      const message = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: "chat",
        author: name,
        authorAvatar: avatar,
        text,
        gifUrl,
        replyTo: repliedMessage
          ? {
              id: repliedMessage.id,
              author: repliedMessage.author,
              text: repliedMessage.text,
              gifUrl: repliedMessage.gifUrl || ""
            }
          : null,
        reactions: {},
        createdAt: new Date().toISOString()
      };

      room.messages.push(message);
      room.messages = room.messages.slice(-200);
      writeDb(db);
      sendEvent(roomCode, { event: "message", message });
      sendJson(response, 200, { ok: true, message });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/react") {
    try {
      const {
        roomCode: rawRoomCode,
        messageId: rawMessageId,
        reaction: rawReaction,
        name: rawName
      } = await parseBody(request);

      const roomCode = sanitizeRoomCode(rawRoomCode);
      const messageId = sanitizeMessageId(rawMessageId);
      const reaction = sanitizeReaction(rawReaction);
      const name = sanitizeName(rawName) || "Anonymous";

      if (!roomCode || !messageId || !reaction) {
        sendJson(response, 400, { error: "Room, message, and reaction are required." });
        return;
      }

      const db = readDb();
      const room = normalizeRoom(ensureRoom(db, roomCode));
      const message = room.messages.find((entry) => entry.id === messageId);

      if (!message) {
        sendJson(response, 404, { error: "Message not found." });
        return;
      }

      message.reactions = message.reactions || {};
      message.reactions[reaction] = Array.isArray(message.reactions[reaction])
        ? message.reactions[reaction]
        : [];

      const existingIndex = message.reactions[reaction].indexOf(name);
      if (existingIndex >= 0) {
        message.reactions[reaction].splice(existingIndex, 1);
      } else {
        message.reactions[reaction].push(name);
      }

      if (message.reactions[reaction].length === 0) {
        delete message.reactions[reaction];
      }

      writeDb(db);
      sendEvent(roomCode, { event: "reaction", message });
      sendJson(response, 200, { ok: true, message });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "API route not found." });
    return;
  }

  serveFile(requestUrl.pathname, response);
});

server.listen(PORT, () => {
  console.log(`Chat app running at http://localhost:${PORT}`);
});
