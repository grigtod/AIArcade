![AI Arcade header](./public/media/readme-header-anim-2.gif)

# AI Arcade

Video: [link](https://youtu.be/POufp6P4Ed4)  
Photos: [link](https://drive.google.com/drive/folders/1iC8ZH85nRKsdP7ZhC_Qw-DQV113_aRHK)  

Local web app that:

- is designed for a joystick controller with two buttons, while also supporting keyboard fallback controls
- asks OpenAI for a fresh set of 4 two-answer questions on startup
- asks OpenAI for a brand-new arcade game based on those answers
- loads the returned single-file game directly in the browser
- can also run as a static GitHub Pages site for replaying saved games from the library

Try it without AI game generation on GitHub Pages: [AI Arcade demo](https://grigtod.github.io/AIArcade/)

This browser demo is for playing saved games only and does not include the AI game generation flow.

## Stack

- Node.js built-in HTTP server
- vanilla HTML, CSS, browser Gamepad API, and keyboard/mouse fallback bindings
- OpenAI Responses API from the local server so the API key never sits in the browser

## Setup

You can either run it on your own server with an OpenAI API key so you can generate new games, or try the saved games on GitHub Pages without game generation.

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

## Controls

- The browser UI is designed around a joystick controller with two buttons.
- Keyboard fallback is also supported: arrow keys or `WASD` move, `Enter` maps to Button 1, `Shift` maps to Button 2, `Esc` returns to the start menu, and mouse buttons `1` and `2` also map to Button 1 and Button 2.
- The frontend reads the controller through the browser Gamepad API and mirrors the same digital inputs to keyboard and mouse fallback bindings.
- By default, Button 1 is gamepad button index `0` and Button 2 is index `1`.
- The joystick uses either the left stick axes or standard d-pad button mapping if the controller exposes buttons `12-15`.
- Generated games receive controller state through a host-provided `window.arcadeInput` object inside the iframe.

## GitHub Pages

- The repo root now includes a static `index.html` entry point so GitHub Pages can serve the saved library without the local Node server.
- On GitHub Pages, game generation is disabled unless the app can reach a local API with an `OPENAI_API_KEY`, but saved games in `data/library/` remain playable in the browser.
- GitHub Pages demo: [AI Arcade on GitHub Pages](https://grigtod.github.io/AI-Arcade/)

## Contributing

If you run the app, generate a really cool game, and want to share it back, feel free to open a pull request and I will happily take a look and merge it in.

All help to expand the app further is welcome, whether that is new saved games, polish, fixes, or bigger feature ideas.

## License

This project is released under the MIT License. See [LICENSE](./LICENSE) for the full text.
