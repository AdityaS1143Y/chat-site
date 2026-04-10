const joinForm = document.getElementById("join-form");
const messageForm = document.getElementById("message-form");
const notifyButton = document.getElementById("notify-btn");
const copyLinkButton = document.getElementById("copy-link-btn");
const avatarInput = document.getElementById("avatar-input");
const avatarPreview = document.getElementById("avatar-preview");
const emojiButton = document.getElementById("emoji-btn");
const emojiPanel = document.getElementById("emoji-panel");
const gifButton = document.getElementById("gif-btn");
const gifInputWrap = document.getElementById("gif-input-wrap");
const gifUrlInput = document.getElementById("gif-url-input");
const gifPreview = document.getElementById("gif-preview");
const gifPreviewImage = document.getElementById("gif-preview-image");
const clearGifButton = document.getElementById("clear-gif-btn");
const replyBanner = document.getElementById("reply-banner");
const replyAuthor = document.getElementById("reply-author");
const replyText = document.getElementById("reply-text");
const cancelReplyButton = document.getElementById("cancel-reply-btn");
const roomView = document.getElementById("room-view");
const messagesContainer = document.getElementById("messages");
const roomTitle = document.getElementById("room-title");
const statusEl = document.getElementById("status");
const nameInput = document.getElementById("name");
const roomCodeInput = document.getElementById("room-code");
const messageInput = document.getElementById("message-input");

let currentRoomCode = "";
let currentName = "";
let currentAvatar = "";
let currentGifUrl = "";
let eventSource = null;
let currentReplyTarget = null;
let currentMessages = [];

const fallbackAvatar =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="32" fill="#5865f2"/>
      <circle cx="32" cy="24" r="12" fill="#ffffff"/>
      <path d="M14 54c2-11 12-18 18-18s16 7 18 18" fill="#ffffff"/>
    </svg>`
  );

const emojiOptions = [
  "\u{1F600}",
  "\u{1F602}",
  "\u{1F973}",
  "\u2764\uFE0F",
  "\u{1F525}",
  "\u{1F62D}",
  "\u{1F60E}",
  "\u{1F44D}",
  "\u{1F389}",
  "\u2728",
  "\u{1F440}",
  "\u{1F91D}"
];
const quickReactionOptions = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F62E}", "\u{1F525}"];

function slugifyRoomCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 40);
}

function formatTime(dateString) {
  return new Date(dateString).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function ensureAvatarPreview() {
  avatarPreview.src = currentAvatar || fallbackAvatar;
}

function autoResizeComposer() {
  messageInput.style.height = "0px";
  const nextHeight = Math.min(messageInput.scrollHeight, 260);
  messageInput.style.height = `${Math.max(nextHeight, 28)}px`;
}

function findMessageById(messageId) {
  return currentMessages.find((message) => message.id === messageId) || null;
}

function getReplySnippet(message) {
  if (!message) {
    return "";
  }

  if (message.text) {
    return message.text.slice(0, 80);
  }

  if (message.gifUrl) {
    return "GIF";
  }

  return "Message";
}

function setReplyTarget(message) {
  currentReplyTarget = message;
  if (!message) {
    replyBanner.classList.add("hidden");
    replyAuthor.textContent = "";
    replyText.textContent = "";
    return;
  }

  replyAuthor.textContent = `Replying to ${message.author}`;
  replyText.textContent = getReplySnippet(message);
  replyBanner.classList.remove("hidden");
}

function shouldGroupMessage(message, previousMessage) {
  if (!message || !previousMessage) {
    return false;
  }

  if (message.type !== "chat" || previousMessage.type !== "chat") {
    return false;
  }

  if (message.author !== previousMessage.author) {
    return false;
  }

  if (message.replyTo || previousMessage.replyTo) {
    return false;
  }

  const currentTime = new Date(message.createdAt).getTime();
  const previousTime = new Date(previousMessage.createdAt).getTime();
  return currentTime - previousTime < 5 * 60 * 1000;
}

function createEl(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function normalizeGifUrl(url) {
  const value = String(url || "").trim();
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    if (host.includes("giphy.com") && !host.includes("media.giphy.com")) {
      const parts = parsed.pathname.split("-").filter(Boolean);
      const id = parts[parts.length - 1];
      if (id) {
        return `https://media.giphy.com/media/${id}/giphy.gif`;
      }
    }

    return parsed.toString();
  } catch (error) {
    return value;
  }
}

async function resolveGifUrl(url) {
  const candidate = normalizeGifUrl(url);
  if (!candidate) {
    return "";
  }

  const response = await fetch(`/api/resolve-gif?url=${encodeURIComponent(candidate)}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not resolve GIF.");
  }

  return data.gifUrl || candidate;
}

function setGifPreview(url) {
  currentGifUrl = normalizeGifUrl(url);
  if (currentGifUrl) {
    gifPreviewImage.src = currentGifUrl;
    gifPreview.classList.remove("hidden");
  } else {
    gifPreviewImage.removeAttribute("src");
    gifPreview.classList.add("hidden");
  }
}

function renderReactionStrip(container, message) {
  container.innerHTML = "";
  const reactions = message.reactions || {};
  const entries = Object.entries(reactions).filter(([, users]) => Array.isArray(users) && users.length);

  if (entries.length === 0) {
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");
  for (const [reaction, users] of entries) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "reaction-chip";
    if (users.includes(currentName)) {
      chip.classList.add("active");
    }
    chip.textContent = `${reaction} ${users.length}`;
    chip.title = users.join(", ");
    chip.addEventListener("click", async () => {
      try {
        await toggleReaction(message.id, reaction);
      } catch (error) {
        statusEl.textContent = error.message;
      }
    });
    container.appendChild(chip);
  }
}

function renderMessageRow(message) {
  const row = createEl("div", "message-row");
  row.dataset.messageId = message.id;

  const rowTime = createEl("span", "row-time", formatTime(message.createdAt));
  row.appendChild(rowTime);

  if (message.replyTo) {
    const replyPreview = createEl("div", "reply-preview");
    replyPreview.appendChild(createEl("span", "reply-line"));
    replyPreview.appendChild(createEl("strong", "reply-author", message.replyTo.author));
    replyPreview.appendChild(createEl("span", "reply-text", getReplySnippet(message.replyTo)));
    row.appendChild(replyPreview);
  }

  if (message.text) {
    row.appendChild(createEl("p", "text", message.text));
  }

  if (message.gifUrl) {
    const gif = createEl("img", "gif");
    gif.alt = "Shared GIF";
    gif.src = message.gifUrl;
    row.appendChild(gif);
  }

  const actions = createEl("div", "message-actions");
  const replyButton = createEl("button", "action-btn reply-btn", "Reply");
  replyButton.type = "button";
  replyButton.addEventListener("click", () => {
    setReplyTarget(message);
    messageInput.focus();
  });
  actions.appendChild(replyButton);

  const reactButton = createEl("button", "action-btn react-btn", "+ React");
  reactButton.type = "button";
  actions.appendChild(reactButton);
  row.appendChild(actions);

  const quickReactions = createEl("div", "quick-reactions hidden");
  for (const reaction of quickReactionOptions) {
    const chip = createEl("button", "reaction-chip", reaction);
    chip.type = "button";
    chip.addEventListener("click", async () => {
      try {
        await toggleReaction(message.id, reaction);
      } catch (error) {
        statusEl.textContent = error.message;
      }
    });
    quickReactions.appendChild(chip);
  }
  row.appendChild(quickReactions);

  const reactionPicker = createEl("div", "reaction-picker hidden");
  const reactionInput = createEl("input", "reaction-input");
  reactionInput.maxLength = 16;
  reactionInput.placeholder = "Type any emoji";
  const addReactionButton = createEl("button", "action-btn add-reaction-btn", "Add");
  addReactionButton.type = "button";
  reactionPicker.append(reactionInput, addReactionButton);
  row.appendChild(reactionPicker);

  async function submitCustomReaction() {
    const reaction = reactionInput.value.trim();
    if (!reaction) {
      return;
    }

    try {
      await toggleReaction(message.id, reaction);
      reactionInput.value = "";
      reactionPicker.classList.add("hidden");
      quickReactions.classList.add("hidden");
    } catch (error) {
      statusEl.textContent = error.message;
    }
  }

  reactButton.addEventListener("click", () => {
    quickReactions.classList.toggle("hidden");
    reactionPicker.classList.toggle("hidden");
    if (!reactionPicker.classList.contains("hidden")) {
      reactionInput.focus();
    }
  });
  addReactionButton.addEventListener("click", submitCustomReaction);
  reactionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitCustomReaction();
    }
  });

  const reactionStrip = createEl("div", "reaction-strip");
  renderReactionStrip(reactionStrip, message);
  row.appendChild(reactionStrip);

  return row;
}

function buildMessageGroups(messages) {
  const groups = [];

  for (const message of messages) {
    const lastGroup = groups[groups.length - 1];
    const previousMessage = lastGroup ? lastGroup.messages[lastGroup.messages.length - 1] : null;

    if (
      lastGroup &&
      lastGroup.type === "chat" &&
      message.type === "chat" &&
      shouldGroupMessage(message, previousMessage)
    ) {
      lastGroup.messages.push(message);
      continue;
    }

    groups.push({
      type: message.type,
      author: message.author,
      authorAvatar: message.authorAvatar,
      createdAt: message.createdAt,
      messages: [message]
    });
  }

  return groups;
}

function renderMessages() {
  messagesContainer.innerHTML = "";

  const groups = buildMessageGroups(currentMessages);
  for (const group of groups) {
    if (group.type === "system") {
      const wrapper = createEl("article", "message-group system");
      wrapper.appendChild(createEl("div"));
      const body = createEl("div", "group-body");
      body.appendChild(createEl("p", "system-text", group.messages[0].text || ""));
      wrapper.appendChild(body);
      messagesContainer.appendChild(wrapper);
      continue;
    }

    const wrapper = createEl("article", "message-group");
    const avatar = createEl("img", "group-avatar");
    avatar.src = group.authorAvatar || fallbackAvatar;
    avatar.alt = `${group.author} avatar`;
    wrapper.appendChild(avatar);

    const body = createEl("div", "group-body");
    const header = createEl("div", "group-header");
    header.appendChild(createEl("strong", "author", group.author));
    header.appendChild(createEl("span", "time", formatTime(group.createdAt)));
    body.appendChild(header);

    for (const message of group.messages) {
      body.appendChild(renderMessageRow(message));
    }

    wrapper.appendChild(body);
    messagesContainer.appendChild(wrapper);
  }

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function upsertMessage(nextMessage) {
  const index = currentMessages.findIndex((message) => message.id === nextMessage.id);
  if (index >= 0) {
    currentMessages[index] = nextMessage;
  } else {
    currentMessages.push(nextMessage);
  }
}

function notifyForMessage(message) {
  const isOwnMessage = message.author === currentName;
  if (message.type !== "chat" || isOwnMessage) {
    return;
  }

  const previewText = message.text || "Sent a GIF";

  if (document.hidden) {
    document.title = `New message in ${currentRoomCode}`;
  }

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(`New message in ${currentRoomCode}`, {
      body: `${message.author}: ${previewText}`
    });
  }
}

async function fetchRoom(roomCode) {
  const response = await fetch(`/api/room?code=${encodeURIComponent(roomCode)}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to load room.");
  }
  return data.room;
}

async function joinRoom(roomCode, name) {
  const response = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomCode, name, avatar: currentAvatar })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to join room.");
  }
  return data.room;
}

async function sendMessage(roomCode, name, text, gifUrl) {
  const resolvedGifUrl = gifUrl ? await resolveGifUrl(gifUrl) : "";
  const response = await fetch("/api/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomCode,
      name,
      text,
      gifUrl: resolvedGifUrl,
      avatar: currentAvatar,
      replyTo: currentReplyTarget ? currentReplyTarget.id : ""
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to send message.");
  }
}

async function toggleReaction(messageId, reaction) {
  const response = await fetch("/api/react", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomCode: currentRoomCode,
      messageId,
      reaction,
      name: currentName
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to update reaction.");
  }
}

function connectStream(roomCode) {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(`/api/stream?code=${encodeURIComponent(roomCode)}`);
  eventSource.onopen = () => {
    statusEl.textContent = "Live updates connected.";
  };

  eventSource.onerror = () => {
    statusEl.textContent = "Trying to reconnect...";
  };

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.event === "message") {
      upsertMessage(data.message);
      renderMessages();
      notifyForMessage(data.message);
    }
    if (data.event === "reaction") {
      upsertMessage(data.message);
      renderMessages();
    }
  };
}

function updateUrl(roomCode, name) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomCode);
  url.searchParams.set("name", name);
  window.history.replaceState({}, "", url);
}

async function enterRoom(roomCode, name) {
  currentRoomCode = roomCode;
  currentName = name;

  roomTitle.textContent = `# ${roomCode}`;
  roomView.classList.remove("hidden");
  currentMessages = [];
  statusEl.textContent = "Loading room...";

  const existingRoom = await fetchRoom(roomCode);
  currentMessages = existingRoom.messages || [];
  renderMessages();

  connectStream(roomCode);
  await joinRoom(roomCode, name);
  updateUrl(roomCode, name);
}

emojiOptions.forEach((emoji) => {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = emoji;
  button.addEventListener("click", () => {
    const start = messageInput.selectionStart ?? messageInput.value.length;
    const end = messageInput.selectionEnd ?? messageInput.value.length;
    messageInput.value =
      messageInput.value.slice(0, start) + emoji + messageInput.value.slice(end);
    const caretPosition = start + emoji.length;
    messageInput.focus();
    messageInput.setSelectionRange(caretPosition, caretPosition);
  });
  emojiPanel.appendChild(button);
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const roomCode = slugifyRoomCode(roomCodeInput.value);
  const name = nameInput.value.trim().slice(0, 30);

  if (!roomCode || !name) {
    statusEl.textContent = "Please add your name and room code.";
    return;
  }

  roomCodeInput.value = roomCode;

  try {
    await enterRoom(roomCode, name);
  } catch (error) {
    statusEl.textContent = error.message;
  }
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  const gifUrl = gifUrlInput.value.trim();

  if (!text && !gifUrl) {
    return;
  }

  try {
    await sendMessage(currentRoomCode, currentName, text, gifUrl);
    messageInput.value = "";
    gifUrlInput.value = "";
    setGifPreview("");
    setReplyTarget(null);
    autoResizeComposer();
    messageInput.focus();
  } catch (error) {
    statusEl.textContent = error.message;
  }
});

notifyButton.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    statusEl.textContent = "This browser does not support notifications.";
    return;
  }

  const permission = await Notification.requestPermission();
  statusEl.textContent =
    permission === "granted"
      ? "Browser notifications enabled."
      : "Notifications were not enabled.";
});

copyLinkButton.addEventListener("click", async () => {
  if (!currentRoomCode) {
    return;
  }

  const inviteUrl = `${window.location.origin}?room=${encodeURIComponent(currentRoomCode)}`;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    statusEl.textContent = "Invite link copied.";
  } catch (error) {
    statusEl.textContent = `Share this link: ${inviteUrl}`;
  }
});

avatarInput.addEventListener("change", () => {
  const [file] = avatarInput.files || [];
  if (!file) {
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result !== "string") {
      return;
    }

    if (file.type === "image/gif") {
      currentAvatar = reader.result;
      localStorage.setItem("chat-avatar", currentAvatar);
      ensureAvatarPreview();
      statusEl.textContent = "Animated profile picture updated.";
      return;
    }

    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const size = 96;
      canvas.width = size;
      canvas.height = size;

      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      const scale = Math.max(size / image.width, size / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      const x = (size - width) / 2;
      const y = (size - height) / 2;

      context.clearRect(0, 0, size, size);
      context.drawImage(image, x, y, width, height);

      currentAvatar = canvas.toDataURL("image/jpeg", 0.82);
      localStorage.setItem("chat-avatar", currentAvatar);
      ensureAvatarPreview();
      statusEl.textContent = "Profile picture updated.";
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
});

emojiButton.addEventListener("click", () => {
  emojiPanel.classList.toggle("hidden");
  gifInputWrap.classList.add("hidden");
});

gifButton.addEventListener("click", () => {
  gifInputWrap.classList.toggle("hidden");
  emojiPanel.classList.add("hidden");
  gifUrlInput.focus();
});

gifUrlInput.addEventListener("input", () => {
  setGifPreview(gifUrlInput.value);
});

gifUrlInput.addEventListener("change", async () => {
  if (!gifUrlInput.value.trim()) {
    setGifPreview("");
    return;
  }

  statusEl.textContent = "Resolving GIF link...";
  try {
    const resolved = await resolveGifUrl(gifUrlInput.value);
    gifUrlInput.value = resolved;
    setGifPreview(resolved);
    statusEl.textContent = "GIF ready to send.";
  } catch (error) {
    statusEl.textContent = error.message;
  }
});

clearGifButton.addEventListener("click", () => {
  gifUrlInput.value = "";
  setGifPreview("");
});

cancelReplyButton.addEventListener("click", () => {
  setReplyTarget(null);
});

messageInput.addEventListener("input", () => {
  autoResizeComposer();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    document.title = "Room Chat";
  }
});

window.addEventListener("beforeunload", () => {
  if (eventSource) {
    eventSource.close();
  }
});

const params = new URLSearchParams(window.location.search);
const roomFromUrl = slugifyRoomCode(params.get("room"));
const nameFromUrl = params.get("name");
const savedAvatar = localStorage.getItem("chat-avatar");

if (savedAvatar) {
  currentAvatar = savedAvatar;
}

ensureAvatarPreview();
autoResizeComposer();

if (roomFromUrl) {
  roomCodeInput.value = roomFromUrl;
}

if (nameFromUrl) {
  nameInput.value = nameFromUrl;
}

if (roomFromUrl && nameFromUrl) {
  enterRoom(roomFromUrl, nameFromUrl).catch((error) => {
    statusEl.textContent = error.message;
  });
}
