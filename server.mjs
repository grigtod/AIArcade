import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

loadDotEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const LIBRARY_DIR = path.join(DATA_DIR, 'library');
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const QUESTION_MODEL = process.env.OPENAI_QUESTION_MODEL || 'gpt-5.4-mini';
const GAME_MODEL = process.env.OPENAI_GAME_MODEL || 'gpt-5.4';
const HOST_BRIDGE_START = '<!-- AI_ARCADE_HOST_BRIDGE_START -->';
const HOST_BRIDGE_END = '<!-- AI_ARCADE_HOST_BRIDGE_END -->';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

const QUESTIONNAIRE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    intro: { type: 'string' },
    questions: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          prompt: { type: 'string' },
          answers: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                effect: { type: 'string' },
              },
              required: ['id', 'label', 'effect'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'prompt', 'answers'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'intro', 'questions'],
  additionalProperties: false,
};

const GAME_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    attract_text: { type: 'string' },
    html: { type: 'string' },
  },
  required: ['title', 'attract_text', 'html'],
  additionalProperties: false,
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApiRequest(req, res, url);
      return;
    }

    await serveStaticAsset(res, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : 'Unexpected server error.',
    });
  }
});

server.on('error', handleServerError);

server.listen(PORT, () => {
  console.log(`AI Arcade listening on http://localhost:${PORT}`);
  if (!OPENAI_API_KEY) {
    console.log('OPENAI_API_KEY is missing. The UI will load, but AI generation will fail until it is configured.');
  }
});

async function handleApiRequest(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      configured: Boolean(OPENAI_API_KEY),
      questionModel: QUESTION_MODEL,
      gameModel: GAME_MODEL,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/library') {
    const games = await listLibraryGames();
    sendJson(res, 200, { games });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/library/')) {
    const gameId = decodeURIComponent(url.pathname.split('/').at(-1) || '');
    if (!gameId) {
      sendJson(res, 400, { error: 'Missing library game id.' });
      return;
    }

    const game = await readLibraryGame(gameId);
    if (!game) {
      sendJson(res, 404, { error: 'Saved game not found.' });
      return;
    }

    sendJson(res, 200, game);
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/library/') && url.pathname.endsWith('/thumbnail')) {
    const segments = url.pathname.split('/');
    const gameId = decodeURIComponent(segments.at(-2) || '');
    if (!gameId) {
      sendJson(res, 400, { error: 'Missing library game id.' });
      return;
    }

    const body = await readJsonBody(req);
    const updated = await updateLibraryThumbnail(gameId, body?.thumbnailDataUrl);
    if (!updated) {
      sendJson(res, 404, { error: 'Saved game not found.' });
      return;
    }

    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/questions') {
    ensureApiKey();

    const seed = `${Date.now()}-${crypto.randomUUID()}`;
    const questionnaire = await generateQuestionnaire(seed);

    sendJson(res, 200, {
      sessionId: seed,
      ...questionnaire,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/games') {
    ensureApiKey();

    const body = await readJsonBody(req);
    const payload = normalizeGameRequest(body);
    const response = await createGameJob(payload);

    sendJson(res, 202, {
      jobId: response.id,
      status: response.status || 'queued',
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/games/')) {
    ensureApiKey();

    const responseId = decodeURIComponent(url.pathname.split('/').at(-1) || '');
    if (!responseId) {
      sendJson(res, 400, { error: 'Missing game job id.' });
      return;
    }

    const response = await openAiRequest('GET', `/responses/${responseId}`, undefined, 30000);
    sendJson(res, 200, await buildGameStatusPayload(response, responseId));
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/games/') && url.pathname.endsWith('/cancel')) {
    ensureApiKey();

    const segments = url.pathname.split('/');
    const responseId = decodeURIComponent(segments.at(-2) || '');
    if (!responseId) {
      sendJson(res, 400, { error: 'Missing game job id.' });
      return;
    }

    const response = await openAiRequest('POST', `/responses/${responseId}/cancel`, {}, 30000);
    sendJson(res, 200, {
      status: response.status || 'cancelled',
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
}

function ensureApiKey() {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured. Create a .env file or export the variable before starting the server.');
  }
}

async function generateQuestionnaire(seed) {
  const response = await openAiRequest(
    'POST',
    '/responses',
    buildCompatibleModelPayload({
      model: QUESTION_MODEL,
      temperature: 1.15,
      max_output_tokens: 1800,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                'You design surprising questionnaires that shape original arcade games.',
                'Every questionnaire must feel fresh, weird, and meaningfully different from previous runs.',
                'Do not bias toward any single genre or repeat the same question pattern every run.',
                'Return output that matches the provided JSON schema exactly.',
              ].join(' '),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `Session seed: ${seed}`,
                'Create exactly 4 questions for an arcade cabinet pre-production quiz.',
                'Each question must have exactly 2 answer choices.',
                'The 2 choices must point the later game in clearly different directions.',
                'Make the visible answer labels short and punchy, ideally 2 to 5 words.',
                'For each answer, include a hidden "effect" sentence that explains how that choice should influence the generated game.',
                'Make the questions concrete and game-specific, not abstract.',
                'Choose 4 concrete game-shaping topics from a broad pool such as genre, movement style, camera or viewpoint, hero theme, enemy style, pacing, level structure, win condition, interaction verbs, or risk-reward feel.',
                'Do not force the same categories every time. Across runs, vary the mix of topics so the resulting games can land in very different genres.',
                'Keep the questions broad enough that the final game could become a platformer, climber, maze game, action puzzle, shooter, racer, sports-like game, survival game, rhythm-like timing game, or something stranger that still fits one stick and two buttons.',
                'At least 3 of the 4 questions should look like things a player might answer before pitching an actual arcade game.',
                'Keep every question directly useful for generating a playable arcade concept.',
                'Do not use copyrighted characters, franchises, brands, or direct sequels.',
                'The title and intro should feel like an arcade attract mode, not a survey tool.',
              ].join('\n'),
            },
          ],
        },
      ],
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'arcade_questionnaire',
          strict: true,
          schema: QUESTIONNAIRE_SCHEMA,
        },
      },
    }),
    90000,
  );

  return parseStructuredResponse(response);
}

async function createGameJob(payload) {
  const creativeSeed = `${payload.sessionId}-${crypto.randomUUID()}`;
  const response = await openAiRequest(
    'POST',
    '/responses',
    buildCompatibleModelPayload({
      model: GAME_MODEL,
      background: true,
      store: true,
      temperature: 0.95,
      max_output_tokens: 7000,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                'You build varied, playful, production-ready arcade prototypes as single HTML files.',
                'Your games must be fun, readable, and runnable without external assets.',
                'The game must render a visible title or attract screen immediately on load, before any button is pressed.',
                'Do not bias toward a default house style or repeat the same genre across runs.',
                'Return output that matches the provided JSON schema exactly.',
              ].join(' '),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `Creative seed: ${creativeSeed}`,
                'Build one brand-new arcade game as a self-contained HTML document.',
                'The game will run inside an iframe on a local Raspberry Pi cabinet.',
                'Only the following controls exist:',
                '- window.arcadeInput.up',
                '- window.arcadeInput.down',
                '- window.arcadeInput.left',
                '- window.arcadeInput.right',
                '- window.arcadeInput.upPressed',
                '- window.arcadeInput.downPressed',
                '- window.arcadeInput.leftPressed',
                '- window.arcadeInput.rightPressed',
                '- window.arcadeInput.button1',
                '- window.arcadeInput.button2',
                '- window.arcadeInput.button1Pressed',
                '- window.arcadeInput.button2Pressed',
                'Do not use keyboard, mouse, touch, pointer, text input, or any other controls.',
                'Button 1 must be the primary action and start/select input.',
                'Button 2 must be the secondary action, dodge, alt-fire, or contextual input.',
                'Make the game understandable and fully playable with only one stick and two buttons.',
                'Any arcade-friendly genre is valid if it truly fits one stick and two buttons, including platformers, climbers, maze games, shooters, action puzzles, racers, sports-like games, survival games, timing games, or hybrids.',
                'Do not default to top-down dodge games, lane runners, endless runners, arena shooters, or brick-breaker-like layouts unless the selected design signals clearly point there.',
                'Use the selected design signals as real constraints that should materially shape the genre, movement, objectives, and feel.',
                'The title screen must always start on Button 1 from the real arcade controls on the very first obvious press.',
                'Do not require keyboard focus, mouse clicks, or a tiny one-frame-only timing window to begin.',
                'Read window.arcadeInput every frame and debounce your own start logic so Button 1 cannot be missed.',
                'If the game uses lanes, menus, or stepped movement, move exactly one lane or one slot per directional *Pressed* event and never continuously while a direction is held.',
                'For example, a 5-lane game must allow the player to occupy the middle lanes by requiring stick-neutral between lane changes.',
                'Design specifically for a 1:1 square playfield, not widescreen.',
                'Use a 960 by 960 logical play area or canvas and keep the entire game readable inside that square.',
                'If you use canvas, declare it explicitly as width="960" height="960".',
                'Keep all important gameplay, UI, enemies, bullets, and effects inside a visible safe margin so nothing important touches or disappears past the left or right edges.',
                'Use inline CSS and inline JavaScript only. No imports, no CDN assets, no network requests, no external fonts, no image files, and no module scripts.',
                'Prefer a single canvas and compact code over elaborate architecture.',
                'Include simple synthesized sound effects for jumps, shots, hits, pickups, and menu confirms using Web Audio or a similarly self-contained approach.',
                'If the browser blocks audio until interaction, unlock audio on the first valid button press and degrade gracefully without crashing.',
                'Do not use localStorage, sessionStorage, IndexedDB, WebGL, workers, eval, new Function, module scripts, browser permission APIs, or fullscreen APIs.',
                'The game must run inside a sandboxed iframe with scripts allowed and no same-origin privileges.',
                'The game should include a title screen, active play, clear failure or victory feedback, and a fast retry loop.',
                'Favor bold arcade energy and genuine variety over repeating familiar templates.',
                'Do not mention the questionnaire inside the game UI.',
                'Avoid copyrighted characters, brands, and franchise references.',
                payload.repairError
                  ? [
                      'The previous generated version failed or looked broken in the cabinet.',
                      `Previous failure details: ${payload.repairError}`,
                      'Return a corrected replacement. Simpler and sturdier is better than ambitious, but preserve the intended genre and core fantasy instead of collapsing into a generic dodge game.',
                    ].join('\n')
                  : '',
                'Selected design signals:',
                JSON.stringify(
                  {
                    sessionId: payload.sessionId,
                    title: payload.questionnaireTitle,
                    intro: payload.questionnaireIntro,
                    selections: payload.selections,
                  },
                  null,
                  2,
                ),
              ].join('\n\n'),
            },
          ],
        },
      ],
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'arcade_game',
          strict: true,
          schema: GAME_SCHEMA,
        },
      },
    }),
    90000,
  );

  return response;
}

async function buildGameStatusPayload(response, responseId) {
  const status = response.status || 'unknown';

  if (status === 'completed') {
    try {
      const parsed = parseStructuredResponse(response);
      validateGeneratedGameHtml(parsed.html);
      const savedGame = await saveLibraryGame({
        id: responseId,
        title: parsed.title,
        attractText: parsed.attract_text,
        html: parsed.html,
        createdAt: toIsoDate(response.created_at),
      });

      return {
        status: 'completed',
        result: {
          libraryId: savedGame.id,
          title: parsed.title,
          attractText: parsed.attract_text,
          html: normalizeHostedGameHtml(savedGame.html),
        },
      };
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Generated game failed validation.',
      };
    }
  }

  if (status === 'failed') {
    return {
      status: 'failed',
      error: response.error?.message || 'Game generation failed.',
    };
  }

  if (status === 'cancelled') {
    return {
      status: 'cancelled',
      error: 'Game generation was cancelled.',
    };
  }

  if (status === 'incomplete') {
    return {
      status: 'failed',
      error: response.incomplete_details?.reason || 'Game generation stopped before completion.',
    };
  }

  return { status };
}

function injectHostBridge(html) {
  const bridge = `
${HOST_BRIDGE_START}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>
window.arcadeInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  upPressed: false,
  downPressed: false,
  leftPressed: false,
  rightPressed: false,
  button1: false,
  button2: false,
  button1Pressed: false,
  button2Pressed: false,
  start: false,
  confirm: false,
  action: false,
  secondary: false,
  startPressed: false,
  confirmPressed: false,
  actionPressed: false,
  secondaryPressed: false
};

let previousCompatInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  button1: false,
  button2: false
};

function dispatchCompatKey(type, key, code) {
  try {
    const event = new KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
      cancelable: true
    });
    window.dispatchEvent(event);
    document.dispatchEvent(event);
    document.body?.dispatchEvent(event);
  } catch {}
}

function dispatchCompatPointerPress(button = 0) {
  try {
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight / 2);
    const target = document.elementFromPoint(x, y) || document.body || document.documentElement;

    const buttonMask = button === 2 ? 2 : 1;
    const sequence =
      button === 2
        ? ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'contextmenu', 'auxclick']
        : ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];

    sequence.forEach((type) => {
      const isPress = type === 'pointerdown' || type === 'mousedown';
      const eventInit = {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button,
        buttons: isPress ? buttonMask : 0
      };
      const event =
        type.startsWith('pointer') && typeof PointerEvent === 'function'
          ? new PointerEvent(type, {
              ...eventInit,
              pointerType: 'mouse',
              isPrimary: button !== 2
            })
          : new MouseEvent(type, eventInit);
      target?.dispatchEvent(event);
    });
  } catch {}
}

function withArcadeAliases(source) {
  const state = source || {};
  return {
    ...state,
    start: Boolean(state.button1),
    confirm: Boolean(state.button1),
    action: Boolean(state.button1),
    secondary: Boolean(state.button2),
    startPressed: Boolean(state.button1Pressed),
    confirmPressed: Boolean(state.button1Pressed),
    actionPressed: Boolean(state.button1Pressed),
    secondaryPressed: Boolean(state.button2Pressed)
  };
}

function applyCompatInput(nextState) {
  const mappings = [
    ['up', 'ArrowUp', 'ArrowUp'],
    ['down', 'ArrowDown', 'ArrowDown'],
    ['left', 'ArrowLeft', 'ArrowLeft'],
    ['right', 'ArrowRight', 'ArrowRight'],
    ['button1', 'Enter', 'Enter'],
    ['button2', 'Shift', 'ShiftLeft']
  ];

  for (const [field, key, code] of mappings) {
    const wasDown = Boolean(previousCompatInput[field]);
    const isDown = Boolean(nextState[field]);
    if (isDown && !wasDown) {
      dispatchCompatKey('keydown', key, code);
    }
    if (!isDown && wasDown) {
      dispatchCompatKey('keyup', key, code);
    }
  }

  if (nextState.button1Pressed) {
    dispatchCompatKey('keydown', ' ', 'Space');
    dispatchCompatKey('keyup', ' ', 'Space');
    dispatchCompatPointerPress(0);
  }

  if (nextState.button2Pressed) {
    dispatchCompatPointerPress(2);
  }

  previousCompatInput = {
    up: Boolean(nextState.up),
    down: Boolean(nextState.down),
    left: Boolean(nextState.left),
    right: Boolean(nextState.right),
    button1: Boolean(nextState.button1),
    button2: Boolean(nextState.button2)
  };
}

window.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') {
    return;
  }

  if (event.data.type === 'arcade-input') {
    const nextState = withArcadeAliases(event.data.state);
    applyCompatInput(nextState);
    window.arcadeInput = nextState;
    return;
  }

  if (event.data.type === 'arcade-capture-thumbnail') {
    captureArcadeThumbnail();
  }
});

function postHostMessage(type, extra) {
  try {
    window.parent.postMessage({ type, ...extra }, '*');
  } catch {}
}

const trackedFrameKeyCodes = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Enter',
  'ShiftLeft',
  'ShiftRight'
]);
const trackedFrameMouseButtons = new Set([0, 2]);
const frameKeys = new Set();
const frameMouseButtons = new Set();

function readCapturedFrameInput() {
  return {
    up: frameKeys.has('ArrowUp') || frameKeys.has('KeyW'),
    down: frameKeys.has('ArrowDown') || frameKeys.has('KeyS'),
    left: frameKeys.has('ArrowLeft') || frameKeys.has('KeyA'),
    right: frameKeys.has('ArrowRight') || frameKeys.has('KeyD'),
    button1: frameMouseButtons.has(0) || frameKeys.has('Enter'),
    button2: frameMouseButtons.has(2) || frameKeys.has('ShiftLeft') || frameKeys.has('ShiftRight')
  };
}

function postCapturedFrameInput() {
  postHostMessage('arcade-frame-input', { state: readCapturedFrameInput() });
}

function shouldCaptureFrameKey(event) {
  if (!event.isTrusted) {
    return false;
  }

  if (event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }

  return trackedFrameKeyCodes.has(event.code);
}

function setCapturedFrameKey(code, isDown) {
  if (isDown) {
    if (frameKeys.has(code)) {
      return;
    }

    frameKeys.add(code);
    postCapturedFrameInput();
    return;
  }

  if (frameKeys.delete(code)) {
    postCapturedFrameInput();
  }
}

function setCapturedFrameMouseButton(button, isDown) {
  if (isDown) {
    if (frameMouseButtons.has(button)) {
      return;
    }

    frameMouseButtons.add(button);
    postCapturedFrameInput();
    return;
  }

  if (frameMouseButtons.delete(button)) {
    postCapturedFrameInput();
  }
}

function clearCapturedFrameInput() {
  if (!frameKeys.size && !frameMouseButtons.size) {
    return;
  }

  frameKeys.clear();
  frameMouseButtons.clear();
  postCapturedFrameInput();
}

window.addEventListener(
  'keydown',
  (event) => {
    if (!shouldCaptureFrameKey(event)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    setCapturedFrameKey(event.code, true);
  },
  true,
);

window.addEventListener(
  'keyup',
  (event) => {
    if (!event.isTrusted || !trackedFrameKeyCodes.has(event.code)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    setCapturedFrameKey(event.code, false);
  },
  true,
);

window.addEventListener(
  'mousedown',
  (event) => {
    if (!event.isTrusted || !trackedFrameMouseButtons.has(event.button)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    setCapturedFrameMouseButton(event.button, true);
  },
  true,
);

window.addEventListener(
  'mouseup',
  (event) => {
    if (!event.isTrusted || !trackedFrameMouseButtons.has(event.button)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    setCapturedFrameMouseButton(event.button, false);
  },
  true,
);

window.addEventListener(
  'click',
  (event) => {
    if (event.isTrusted && event.button === 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true,
);

window.addEventListener(
  'auxclick',
  (event) => {
    if (event.isTrusted && trackedFrameMouseButtons.has(event.button)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true,
);

window.addEventListener(
  'contextmenu',
  (event) => {
    if (event.isTrusted) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true,
);

window.addEventListener('blur', clearCapturedFrameInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearCapturedFrameInput();
  }
});

function showArcadeFailure(message) {
  let overlay = document.getElementById('arcade-host-failure');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'arcade-host-failure';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '999999';
    overlay.style.display = 'grid';
    overlay.style.placeItems = 'center';
    overlay.style.padding = '24px';
    overlay.style.background = 'rgba(2, 5, 11, 0.92)';
    overlay.style.color = '#f2f4e8';
    overlay.style.fontFamily = 'Trebuchet MS, Segoe UI, sans-serif';
    overlay.style.textAlign = 'center';
    overlay.innerHTML =
      '<div style="max-width:36rem;border:1px solid rgba(89,255,216,0.35);border-radius:24px;padding:22px;background:rgba(6,15,27,0.92)">' +
      '<div style="color:#59ffd8;letter-spacing:0.16em;text-transform:uppercase;font-size:12px;margin-bottom:12px">Generated Game Error</div>' +
      '<div id="arcade-host-failure-text" style="font-size:18px;line-height:1.5;white-space:pre-wrap"></div>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  const text = overlay.querySelector('#arcade-host-failure-text');
  if (text) {
    text.textContent = message;
  }
}

function wrapThumbnailText(context, text, maxWidth) {
  const words = String(text || 'Arcade Game').split(/\\s+/).filter(Boolean);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const nextLine = currentLine ? currentLine + ' ' + word : word;
    if (context.measureText(nextLine).width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
      continue;
    }

    currentLine = nextLine;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.slice(0, 3);
}

function captureArcadeThumbnail() {
  try {
    const output = document.createElement('canvas');
    output.width = 320;
    output.height = 320;
    const context = output.getContext('2d');
    if (!context) {
      return;
    }

    context.fillStyle = '#09111a';
    context.fillRect(0, 0, output.width, output.height);

    const sourceCanvas = document.querySelector('canvas');
    if (sourceCanvas && sourceCanvas.width > 0 && sourceCanvas.height > 0) {
      const sourceSize = Math.min(sourceCanvas.width, sourceCanvas.height);
      const sx = Math.max(0, (sourceCanvas.width - sourceSize) / 2);
      const sy = Math.max(0, (sourceCanvas.height - sourceSize) / 2);
      context.imageSmoothingEnabled = false;
      context.drawImage(sourceCanvas, sx, sy, sourceSize, sourceSize, 0, 0, output.width, output.height);
    } else {
      const title =
        document.title ||
        document.querySelector('h1, h2, [data-title]')?.textContent ||
        'Arcade Game';

      context.fillStyle = '#11263a';
      context.fillRect(18, 18, 284, 284);
      context.strokeStyle = 'rgba(126, 225, 208, 0.45)';
      context.lineWidth = 2;
      context.strokeRect(18, 18, 284, 284);
      context.fillStyle = '#f2f4e8';
      context.font = 'bold 26px Trebuchet MS, Segoe UI, sans-serif';
      const lines = wrapThumbnailText(context, title, 220);
      lines.forEach((line, index) => {
        context.fillText(line, 34, 126 + index * 34);
      });
    }

    postHostMessage('arcade-thumbnail', {
      imageDataUrl: output.toDataURL('image/png'),
    });
  } catch {}
}

window.addEventListener('DOMContentLoaded', () => {
  try {
    document.body?.setAttribute('tabindex', '-1');
    document.body?.focus?.();
    window.focus?.();
  } catch {}
  postHostMessage('arcade-game-dom-ready', {});
});

window.addEventListener('error', (event) => {
  const message = event?.error?.stack || event?.message || 'Unknown game error.';
  showArcadeFailure(message);
  postHostMessage('arcade-game-error', { message });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason;
  const message =
    (reason && typeof reason === 'object' && reason.stack) ||
    (reason && typeof reason === 'object' && reason.message) ||
    String(reason || 'Unhandled promise rejection in generated game.');
  showArcadeFailure(message);
  postHostMessage('arcade-game-error', { message });
});
</script>
${HOST_BRIDGE_END}`;

  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n${bridge}\n`);
  }

  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (match) => `${match}\n<head>\n${bridge}\n</head>`);
  }

  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    bridge,
    '</head>',
    '<body style="margin:0;background:#02050b;">',
    html,
    '</body>',
    '</html>',
  ].join('\n');
}

function normalizeHostedGameHtml(html) {
  return injectHostBridge(stripInjectedHostBridge(html));
}

function stripInjectedHostBridge(html) {
  if (typeof html !== 'string') {
    return '';
  }

  let nextHtml = html;

  nextHtml = nextHtml.replace(
    /\s*<!-- AI_ARCADE_HOST_BRIDGE_START -->[\s\S]*?<!-- AI_ARCADE_HOST_BRIDGE_END -->\s*/giu,
    '\n',
  );

  nextHtml = nextHtml.replace(
    /\s*<meta charset=["']utf-8["']>\s*<meta name=["']viewport["'] content=["']width=device-width,\s*initial-scale=1["']>\s*<script>\s*window\.arcadeInput\s*=\s*\{[\s\S]*?window\.addEventListener\('unhandledrejection',\s*\(event\)\s*=>\s*\{[\s\S]*?postHostMessage\('arcade-game-error',\s*\{\s*message\s*\}\);\s*\}\);\s*<\/script>\s*/giu,
    '\n',
  );

  return nextHtml.trim();
}

function parseStructuredResponse(response) {
  if (response.status && response.status !== 'completed') {
    throw new Error(`Expected a completed response, received "${response.status}".`);
  }

  const text = extractOutputText(response);
  if (!text) {
    throw new Error('The model response did not include any output text.');
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`The model returned invalid JSON: ${error instanceof Error ? error.message : 'parse failure'}`);
  }
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const chunks = [];

  for (const item of response.output || []) {
    if (!Array.isArray(item.content)) {
      continue;
    }

    for (const part of item.content) {
      if (part.type === 'refusal' && typeof part.refusal === 'string') {
        throw new Error(`Model refusal: ${part.refusal}`);
      }

      if (part.type === 'output_text' && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join('\n').trim();
}

function normalizeGameRequest(body) {
  const selections = Array.isArray(body?.selections) ? body.selections : [];

  if (selections.length !== 4) {
    throw new Error('Expected 4 selected answers before generating a game.');
  }

  return {
    sessionId: String(body?.sessionId || crypto.randomUUID()),
    questionnaireTitle: String(body?.questionnaireTitle || 'Arcade Session'),
    questionnaireIntro: String(body?.questionnaireIntro || ''),
    repairError: typeof body?.repairError === 'string' ? body.repairError.slice(0, 1200) : '',
    selections: selections.map((selection, index) => ({
      questionId: String(selection?.questionId || `question-${index + 1}`),
      questionPrompt: String(selection?.questionPrompt || ''),
      answerId: String(selection?.answerId || `answer-${index + 1}`),
      answerLabel: String(selection?.answerLabel || ''),
      answerEffect: String(selection?.answerEffect || ''),
    })),
  };
}

function buildCompatibleModelPayload(payload) {
  const model = String(payload?.model || '').toLowerCase();
  const isGpt5Family = model.startsWith('gpt-5');
  const supportsTemperatureWithNone =
    model.startsWith('gpt-5.4') || model.startsWith('gpt-5.2');

  if (!isGpt5Family || payload.temperature === undefined) {
    return payload;
  }

  if (supportsTemperatureWithNone) {
    return payload.reasoning
      ? payload
      : {
          ...payload,
          reasoning: {
            effort: 'none',
          },
        };
  }

  const { temperature, ...rest } = payload;
  return rest;
}

async function saveLibraryGame(game) {
  await ensureLibraryDir();
  const safeId = normalizeLibraryId(game.id);
  const existing = await readLibraryGame(safeId, { raw: true });
  const record = {
    id: safeId,
    title: game.title,
    attractText: game.attractText,
    html: game.html,
    thumbnailDataUrl: existing?.thumbnailDataUrl || '',
    createdAt: existing?.createdAt || game.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await writeFile(getLibraryFilePath(safeId), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

async function listLibraryGames() {
  await ensureLibraryDir();
  const entries = await readdir(LIBRARY_DIR, { withFileTypes: true });
  const games = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    try {
      const raw = await readFile(path.join(LIBRARY_DIR, entry.name), 'utf8');
      const record = JSON.parse(raw);
      games.push({
        id: record.id,
        title: record.title,
        attractText: record.attractText,
        createdAt: record.createdAt,
        thumbnailDataUrl: record.thumbnailDataUrl || '',
      });
    } catch {
      // Ignore malformed library files.
    }
  }

  return games.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

async function readLibraryGame(gameId, options = {}) {
  try {
    const raw = await readFile(getLibraryFilePath(gameId), 'utf8');
    const record = JSON.parse(raw);
    if (options.raw) {
      return record;
    }

    return {
      ...record,
      html: normalizeHostedGameHtml(record.html),
    };
  } catch {
    return null;
  }
}

async function updateLibraryThumbnail(gameId, thumbnailDataUrl) {
  if (typeof thumbnailDataUrl !== 'string' || !thumbnailDataUrl.startsWith('data:image/')) {
    throw new Error('Thumbnail must be a data URL image.');
  }

  const game = await readLibraryGame(gameId, { raw: true });
  if (!game) {
    return null;
  }

  game.thumbnailDataUrl = thumbnailDataUrl;
  game.updatedAt = new Date().toISOString();
  await writeFile(getLibraryFilePath(gameId), JSON.stringify(game, null, 2), 'utf8');
  return game;
}

async function ensureLibraryDir() {
  await mkdir(LIBRARY_DIR, { recursive: true });
}

function getLibraryFilePath(gameId) {
  return path.join(LIBRARY_DIR, `${normalizeLibraryId(gameId)}.json`);
}

function normalizeLibraryId(gameId) {
  const id = String(gameId || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error('Library game id was invalid.');
  }
  return id;
}

function toIsoDate(createdAt) {
  if (typeof createdAt === 'number') {
    return new Date(createdAt * 1000).toISOString();
  }

  return new Date().toISOString();
}

function validateGeneratedGameHtml(html) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error('Generated game HTML was empty.');
  }

  const hasVisualRoot = /<(canvas|main|section|div)\b/i.test(html);
  if (!hasVisualRoot) {
    throw new Error('Generated game HTML did not include an obvious visible playfield.');
  }

  const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
    .map((match) => match[1].trim())
    .filter(Boolean);

  if (scripts.length === 0) {
    throw new Error('Generated game HTML did not include any JavaScript.');
  }

  const combinedScripts = scripts.join('\n');
  if (!/\barcadeInput\b/.test(combinedScripts)) {
    throw new Error('Generated game must read window.arcadeInput so the arcade controls always work.');
  }

  if (!/\bbutton1(?:Pressed)?\b/.test(combinedScripts)) {
    throw new Error('Generated game must use Button 1 for title-screen start and primary play.');
  }

  const canvasTag = html.match(/<canvas\b[^>]*>/i)?.[0] || '';
  const hasCanvas = Boolean(canvasTag);
  const widthMatch = canvasTag.match(/\bwidth=["']?(\d+)["']?/i);
  const heightMatch = canvasTag.match(/\bheight=["']?(\d+)["']?/i);

  if (hasCanvas && (!widthMatch || !heightMatch)) {
    throw new Error('Generated canvas games must declare explicit square width and height.');
  }

  if (widthMatch && heightMatch) {
    const width = Number.parseInt(widthMatch[1], 10);
    const height = Number.parseInt(heightMatch[1], 10);

    if (Number.isFinite(width) && Number.isFinite(height) && width !== height) {
      throw new Error(`Generated game canvas must be square, but received ${width}x${height}.`);
    }
  }

  for (const script of scripts) {
    try {
      new Function(script);
    } catch (error) {
      throw new Error(
        `Generated game JavaScript failed syntax validation: ${error instanceof Error ? error.message : 'parse error'}`,
      );
    }
  }
}

async function openAiRequest(method, requestPath, body, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${OPENAI_BASE_URL}${requestPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await response.text();
    const payload = rawText ? safeJsonParse(rawText) : null;

    if (!response.ok) {
      const message =
        payload?.error?.message ||
        payload?.message ||
        rawText ||
        `OpenAI request failed with status ${response.status}.`;
      throw new Error(message);
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`OpenAI request timed out after ${timeoutMs}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safeJsonParse(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    return { message: rawText };
  }
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body was not valid JSON.');
  }
}

async function serveStaticAsset(res, pathname) {
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requestPath}`);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  if (!fileStats.isFile()) {
    sendText(res, 404, 'Not found');
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES.get(extension) || 'application/octet-stream';
  const content = await readFile(filePath);

  res.writeHead(200, {
    'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=300',
    'Content-Type': contentType,
  });
  res.end(content);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end(text);
}

function handleServerError(error) {
  if (error && error.code === 'EADDRINUSE') {
    console.error(
      [
        `Port ${PORT} is already in use.`,
        `Another copy of AI Arcade may already be running at http://localhost:${PORT}.`,
        'Open that page in your browser, or stop the older server before starting a new one.',
        'If you want a different port, change PORT in .env.',
      ].join('\n'),
    );
    process.exit(1);
  }

  throw error;
}

function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    return;
  }

  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
