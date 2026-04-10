# Room Chat Website

A simple website for chatting in browser-based rooms without Google login.

## Features

- The same room code always opens the same saved room
- Discord-inspired dark chat layout
- Custom profile picture support saved in the browser
- Emoji picker and GIF sharing by URL
- Live room updates using Server-Sent Events
- Browser notifications for new messages when permission is granted
- Persistent message history stored in `data.json`

## Run it

1. Make sure Node.js is installed.
2. In this folder, run `node server.js`
3. Open `http://localhost:3000`

## How it works

- Enter your name and a room code like `best-friends`
- Share that room code or the invite link with your friend
- Anyone using the same code lands in the same room
