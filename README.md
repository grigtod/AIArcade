# AI Arcade

Local Raspberry Pi web app that:

- asks OpenAI for a fresh set of 8 two-answer questions on startup
- lets the player answer with only a joystick and Button 1
- asks OpenAI for a brand-new arcade game based on those answers
- loads the returned single-file game directly in the browser
- supports a global reset combo: hold `UP + Button 1 + Button 2` for 4 seconds

## Stack

- Node.js built-in HTTP server
- vanilla HTML, CSS, and browser Gamepad API
- OpenAI Responses API from the local server so the API key never sits in the browser

## Setup

1. Use Node 20+.
2. Create a `.env` file in the project root.
3. Add at least:

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_QUESTION_MODEL=gpt-5.4-mini
OPENAI_GAME_MODEL=gpt-5.4
PORT=3000
```

4. Start the app:

```bash
npm start
```

5. Open `http://localhost:3000`.

## Raspberry Pi notes

- The browser UI is designed for controller-only use.
- The frontend reads the controller through the browser Gamepad API.
- By default, Button 1 is gamepad button index `0` and Button 2 is index `1`.
- The joystick uses either the left stick axes or standard d-pad button mapping if the controller exposes buttons `12-15`.
- Generated games receive controller state through a host-provided `window.arcadeInput` object inside the iframe.

## Verification

Without a live API key, you can still check the server syntax:

```bash
npm run check
```
