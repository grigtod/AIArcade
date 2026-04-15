const app = document.querySelector('#app');
const assetRoot = normalizeBasePath(window.AI_ARCADE_ASSET_ROOT || './');
const staticLibraryRoot = normalizeBasePath(window.AI_ARCADE_STATIC_LIBRARY_ROOT || './data/library/');
const CLIENT_HOST_BRIDGE_START = '<!-- AI_ARCADE_HOST_BRIDGE_START -->';
const CLIENT_HOST_BRIDGE_END = '<!-- AI_ARCADE_HOST_BRIDGE_END -->';

const loadingSets = {
  questions: [
    'Genre Pass',
    'Hero Pass',
    'Rules Pass',
  ],
  game: [
    'World Pass',
    'Input Pass',
    'Audio Pass',
  ],
  library: ['Load List', 'Sort List', 'Pick Game'],
  reset: ['Home Screen', 'Fresh Start', 'Ready Soon'],
  repair: [
    'Patch Pass',
    'Input Pass',
    'Audio Pass',
  ],
};

const state = {
  phase: 'home',
  questionnaire: null,
  currentQuestionIndex: 0,
  highlightedIndex: 0,
  answers: [],
  error: '',
  controllerName: '',
  hasController: false,
  input: makeEmptyInput(),
  repeatAt: 0,
  resetHoldStartedAt: null,
  resetHoldLastSeenAt: null,
  resetLatched: false,
  requestToken: 0,
  loadingSet: 'questions',
  loadingIndex: 0,
  loadingTimer: null,
  gameJobId: '',
  gameResult: null,
  mountedGameHtml: '',
  lastGameRequestPayload: null,
  gameRecoveryCount: 0,
  repairingGame: false,
  loadingMiniGame: createLoadingMiniGame(),
  homeSelection: 0,
  libraryGames: [],
  librarySelection: 0,
  libraryPreviewRequestId: 0,
  frameInput: makeEmptyInput(),
  thumbnailCaptureTimer: null,
  thumbnailRequestedFor: '',
  thumbnailSavedFor: '',
  uiAudio: {
    context: null,
  },
  lastSafeGameInput: makeEmptyInput(),
  runtime: {
    apiReachable: false,
    generationAvailable: null,
  },
};

let dirty = true;
const trackedDirectionCodes = new Set([
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
  'ShiftRight',
  'Escape',
]);
const trackedMouseButtons = new Set([0, 2]);
const localBindings = {
  keys: new Set(),
  mouseButtons: new Set(),
};

window.addEventListener('gamepadconnected', () => markDirty());
window.addEventListener('gamepaddisconnected', () => markDirty());
window.addEventListener('message', handleWindowMessage);
window.addEventListener('keydown', handleTrackedKeyDown, { capture: true });
window.addEventListener('keyup', handleTrackedKeyUp, { capture: true });
window.addEventListener('mousedown', handleTrackedMouseDown, { capture: true });
window.addEventListener('mouseup', handleTrackedMouseUp, { capture: true });
window.addEventListener('click', handleTrackedMouseClick, { capture: true });
window.addEventListener('auxclick', handleTrackedAuxClick, { capture: true });
window.addEventListener('contextmenu', handleTrackedContextMenu, { capture: true });
window.addEventListener('blur', clearLocalBindings);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearLocalBindings();
  }
});
initializeRuntime().catch(() => {});
requestAnimationFrame(frame);

function makeEmptyInput() {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    button1: false,
    button2: false,
    escape: false,
    upPressed: false,
    downPressed: false,
    leftPressed: false,
    rightPressed: false,
    button1Pressed: false,
    button2Pressed: false,
    escapePressed: false,
  };
}

function normalizeBasePath(value) {
  const normalized = String(value || './').trim();
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function resolveAppUrl(path) {
  return new URL(path, window.location.href).toString();
}

function assetUrl(path) {
  return resolveAppUrl(`${assetRoot}${path}`);
}

function staticLibraryUrl(path) {
  return resolveAppUrl(`${staticLibraryRoot}${path}`);
}

function canGenerateGames() {
  return state.runtime.generationAvailable === true;
}

function syncHomeSelectionAvailability() {
  if (state.runtime.generationAvailable !== false) {
    return;
  }

  if (state.homeSelection !== 1) {
    state.homeSelection = 1;
    markDirty();
  }
}

async function initializeRuntime() {
  try {
    const health = await fetchJson(resolveAppUrl('./api/health'));
    state.runtime.apiReachable = true;
    state.runtime.generationAvailable = Boolean(health?.configured);
  } catch {
    state.runtime.apiReachable = false;
    state.runtime.generationAvailable = false;
  }

  syncHomeSelectionAvailability();
  markDirty();
}

function markDirty() {
  dirty = true;
}

function frame(now) {
  updateInputState();
  warmUiAudioFromInput();
  updateResetCombo(now);
  handlePhaseControls(now);
  maybeScheduleThumbnailCapture();
  updateLoadingMiniGame();
  flushRender();
  updateLiveResetMeter();
  pushInputToGame();
  drawLoadingMiniGame();
  requestAnimationFrame(frame);
}

function ensureUiAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return null;
  }

  if (!state.uiAudio.context) {
    state.uiAudio.context = new AudioContextClass();
  }

  if (state.uiAudio.context.state === 'suspended') {
    state.uiAudio.context.resume().catch(() => {});
  }

  return state.uiAudio.context;
}

function warmUiAudioFromInput() {
  if (
    !state.input.button1Pressed &&
    !state.input.button2Pressed &&
    !state.input.upPressed &&
    !state.input.downPressed &&
    !state.input.leftPressed &&
    !state.input.rightPressed
  ) {
    return;
  }

  ensureUiAudioContext();
}

function playUiTone(frequency, durationMs, type = 'square', volume = 0.028) {
  const context = ensureUiAudioContext();
  if (!context || context.state !== 'running') {
    return;
  }

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  const duration = durationMs / 1000;

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(volume, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + duration + 0.02);
}

function playUiMoveSound() {
  playUiTone(360, 70, 'triangle', 0.018);
}

function playUiConfirmSound() {
  playUiTone(520, 90, 'square', 0.03);
  playUiTone(760, 120, 'triangle', 0.016);
}

function playMiniGameJumpSound() {
  playUiTone(430, 110, 'square', 0.024);
}

function playMiniGameHitSound() {
  playUiTone(180, 160, 'sawtooth', 0.026);
}

function updateInputState() {
  const previous = state.input;
  const gamepads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
  const gamepad = gamepads[0];

  const next = mergeInputStates(
    readGamepadInput(gamepad),
    readLocalBindings(),
    state.phase === 'playing' ? state.frameInput : null,
  );

  next.upPressed = next.up && !previous.up;
  next.downPressed = next.down && !previous.down;
  next.leftPressed = next.left && !previous.left;
  next.rightPressed = next.right && !previous.right;
  next.button1Pressed = next.button1 && !previous.button1;
  next.button2Pressed = next.button2 && !previous.button2;
  next.escapePressed = next.escape && !previous.escape;

  const nextControllerName = gamepad ? gamepad.id || 'Arcade Controller' : '';
  const controllerChanged = state.hasController !== Boolean(gamepad) || state.controllerName !== nextControllerName;
  state.input = next;
  state.hasController = Boolean(gamepad);
  state.controllerName = nextControllerName;

  if (controllerChanged) {
    markDirty();
  }
}

function readGamepadInput(gamepad) {
  const next = makeEmptyInput();
  if (!gamepad) {
    return next;
  }

  const axisX = gamepad.axes?.[0] || 0;
  const axisY = gamepad.axes?.[1] || 0;

  next.up = axisY < -0.45 || readButton(gamepad, 12);
  next.down = axisY > 0.45 || readButton(gamepad, 13);
  next.left = axisX < -0.45 || readButton(gamepad, 14);
  next.right = axisX > 0.45 || readButton(gamepad, 15);
  next.button1 = readButton(gamepad, 0);
  next.button2 = readButton(gamepad, 1);
  return next;
}

function readButton(gamepad, index) {
  return Boolean(gamepad.buttons?.[index]?.pressed);
}

function readLocalBindings() {
  const next = makeEmptyInput();
  next.up = localBindings.keys.has('ArrowUp') || localBindings.keys.has('KeyW');
  next.down = localBindings.keys.has('ArrowDown') || localBindings.keys.has('KeyS');
  next.left = localBindings.keys.has('ArrowLeft') || localBindings.keys.has('KeyA');
  next.right = localBindings.keys.has('ArrowRight') || localBindings.keys.has('KeyD');
  next.button1 = localBindings.mouseButtons.has(0) || localBindings.keys.has('Enter');
  next.button2 =
    localBindings.mouseButtons.has(2) ||
    localBindings.keys.has('ShiftLeft') ||
    localBindings.keys.has('ShiftRight');
  next.escape = localBindings.keys.has('Escape');
  return next;
}

function mergeInputStates(...sources) {
  const next = makeEmptyInput();

  for (const source of sources) {
    if (!source) {
      continue;
    }

    next.up ||= Boolean(source.up);
    next.down ||= Boolean(source.down);
    next.left ||= Boolean(source.left);
    next.right ||= Boolean(source.right);
    next.button1 ||= Boolean(source.button1);
    next.button2 ||= Boolean(source.button2);
    next.escape ||= Boolean(source.escape);
  }

  return next;
}

function handleTrackedKeyDown(event) {
  if (!shouldTrackDirectionKey(event)) {
    return;
  }

  event.preventDefault();
  setTrackedKey(event.code, true);
}

function handleTrackedKeyUp(event) {
  if (!trackedDirectionCodes.has(event.code)) {
    return;
  }

  event.preventDefault();
  setTrackedKey(event.code, false);
}

function handleTrackedMouseDown(event) {
  if (!trackedMouseButtons.has(event.button)) {
    return;
  }

  event.preventDefault();
  setTrackedMouseButton(event.button, true);
}

function handleTrackedMouseUp(event) {
  if (!trackedMouseButtons.has(event.button)) {
    return;
  }

  event.preventDefault();
  setTrackedMouseButton(event.button, false);
}

function handleTrackedMouseClick(event) {
  if (event.button === 0) {
    event.preventDefault();
  }
}

function handleTrackedAuxClick(event) {
  if (trackedMouseButtons.has(event.button)) {
    event.preventDefault();
  }
}

function handleTrackedContextMenu(event) {
  event.preventDefault();
}

function shouldTrackDirectionKey(event) {
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }

  if (!trackedDirectionCodes.has(event.code)) {
    return false;
  }

  return !isEditableTarget(event.target);
}

function isEditableTarget(target) {
  return Boolean(
    target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)),
  );
}

function setTrackedKey(code, isDown) {
  if (isDown) {
    if (localBindings.keys.has(code)) {
      return;
    }

    localBindings.keys.add(code);
    return;
  }

  localBindings.keys.delete(code);
}

function setTrackedMouseButton(button, isDown) {
  if (isDown) {
    if (localBindings.mouseButtons.has(button)) {
      return;
    }

    localBindings.mouseButtons.add(button);
    return;
  }

  localBindings.mouseButtons.delete(button);
}

function clearLocalBindings() {
  localBindings.keys.clear();
  localBindings.mouseButtons.clear();
}

function sanitizeFrameInput(source) {
  const next = makeEmptyInput();
  next.up = Boolean(source?.up);
  next.down = Boolean(source?.down);
  next.left = Boolean(source?.left);
  next.right = Boolean(source?.right);
  next.button1 = Boolean(source?.button1);
  next.button2 = Boolean(source?.button2);
  next.escape = Boolean(source?.escape);
  return next;
}

function updateResetCombo(now) {
  const strictResetCombo = state.input.up && state.input.button1 && state.input.button2;
  const playFallbackResetCombo =
    state.phase === 'playing' &&
    state.input.button1 &&
    state.input.button2;
  const isHoldingReset = strictResetCombo || playFallbackResetCombo;
  const shouldRefreshUi = state.phase !== 'playing';
  const resetGraceMs = 260;

  if (!isHoldingReset) {
    const withinGrace =
      state.resetHoldStartedAt !== null &&
      state.resetHoldLastSeenAt !== null &&
      now - state.resetHoldLastSeenAt <= resetGraceMs;

    if (withinGrace) {
      return;
    }

    if (state.resetHoldStartedAt !== null || state.resetHoldLastSeenAt !== null || state.resetLatched) {
      state.resetHoldStartedAt = null;
      state.resetHoldLastSeenAt = null;
      state.resetLatched = false;
      if (shouldRefreshUi) {
        markDirty();
      }
    }
    return;
  }

  if (state.resetHoldStartedAt === null) {
    state.resetHoldStartedAt = now;
    state.resetHoldLastSeenAt = now;
    if (shouldRefreshUi) {
      markDirty();
    }
    return;
  }

  state.resetHoldLastSeenAt = now;

  if (!state.resetLatched && now - state.resetHoldStartedAt >= 4000) {
    state.resetLatched = true;
    resetExperience();
  } else if (shouldRefreshUi) {
    markDirty();
  }
}

function handlePhaseControls(now) {
  if (state.phase !== 'home' && state.input.escapePressed) {
    playUiConfirmSound();
    if (state.phase === 'loading-game' || state.gameJobId) {
      void resetExperience();
    } else {
      goHome();
    }
    return;
  }

  if (state.phase === 'home') {
    handleHomeControls(now);
    return;
  }

  if (state.phase === 'library') {
    handleLibraryControls(now);
    return;
  }

  if (state.phase === 'questionnaire') {
    handleQuestionnaireControls(now);
    return;
  }

  if (state.phase === 'error' && state.input.button1Pressed) {
    playUiConfirmSound();
    goHome();
  }
}

function handleHomeControls() {
  if (state.input.leftPressed || state.input.upPressed) {
    setHomeSelection(0);
  }

  if (state.input.rightPressed || state.input.downPressed) {
    setHomeSelection(1);
  }

  if (!state.input.button1Pressed) {
    return;
  }

  if (!canGenerateGames() && state.homeSelection === 0) {
    setHomeSelection(1);
    return;
  }

  playUiConfirmSound();
  if (state.homeSelection === 0) {
    startSession();
    return;
  }

  openLibrary();
}

function setHomeSelection(nextIndex) {
  const clampedIndex = Math.max(0, Math.min(1, nextIndex));
  const resolvedIndex = state.runtime.generationAvailable === false && clampedIndex === 0 ? 1 : clampedIndex;
  if (resolvedIndex !== state.homeSelection) {
    state.homeSelection = resolvedIndex;
    playUiMoveSound();
    syncHomeSelectionUi();
  }
}

function syncHomeSelectionUi() {
  if (state.phase !== 'home') {
    markDirty();
    return;
  }

  const options = document.querySelectorAll('.home-option');
  if (!options.length) {
    markDirty();
    return;
  }

  options.forEach((option, index) => {
    option.classList.toggle('active', index === state.homeSelection);
  });
}

function handleLibraryControls() {
  if (!state.libraryGames.length) {
    if (state.input.button1Pressed || state.input.button2Pressed) {
      playUiConfirmSound();
      goHome();
    }
    return;
  }

  if (state.input.upPressed) {
    setLibrarySelection(state.librarySelection - 1);
  }

  if (state.input.downPressed) {
    setLibrarySelection(state.librarySelection + 1);
  }

  if (state.input.leftPressed) {
    setLibrarySelection(state.librarySelection - 3);
  }

  if (state.input.rightPressed) {
    setLibrarySelection(state.librarySelection + 3);
  }

  if (state.input.button2Pressed) {
    playUiConfirmSound();
    goHome();
    return;
  }

  if (state.input.button1Pressed) {
    playUiConfirmSound();
    const selected = state.libraryGames[state.librarySelection];
    if (selected) {
      playSavedGame(selected.id);
    }
  }
}

function setLibrarySelection(nextIndex) {
  if (!state.libraryGames.length) {
    state.librarySelection = 0;
    return;
  }

  const clampedIndex = Math.max(0, Math.min(state.libraryGames.length - 1, nextIndex));
  if (clampedIndex !== state.librarySelection) {
    state.librarySelection = clampedIndex;
    playUiMoveSound();
    queueSelectedLibraryPreview();
    markDirty();
  }
}

function syncLibrarySelectionUi() {
  if (state.phase !== 'library') {
    return;
  }

  const list = document.querySelector('.library-list');
  const items = Array.from(document.querySelectorAll('.library-item'));
  if (!list || !items.length) {
    return;
  }

  items.forEach((item, index) => {
    item.classList.toggle('active', index === state.librarySelection);
  });

  const activeItem = items[state.librarySelection];
  if (!activeItem) {
    return;
  }

  const padding = 8;
  const itemTop = activeItem.offsetTop;
  const itemBottom = itemTop + activeItem.offsetHeight;
  const viewTop = list.scrollTop;
  const viewBottom = viewTop + list.clientHeight;

  if (itemTop - padding < viewTop) {
    list.scrollTop = Math.max(0, itemTop - padding);
    return;
  }

  if (itemBottom + padding > viewBottom) {
    list.scrollTop = itemBottom + padding - list.clientHeight;
  }
}

function handleQuestionnaireControls(now) {
  if (state.input.leftPressed || state.input.upPressed) {
    setHighlight(0);
  }

  if (state.input.rightPressed || state.input.downPressed) {
    setHighlight(1);
  }

  if (state.input.button1Pressed) {
    commitAnswer();
  }
}

function setHighlight(nextIndex) {
  const question = state.questionnaire?.questions?.[state.currentQuestionIndex];
  if (!question) {
    return;
  }

  const clampedIndex = Math.max(0, Math.min(question.answers.length - 1, nextIndex));
  if (clampedIndex !== state.highlightedIndex) {
    state.highlightedIndex = clampedIndex;
    playUiMoveSound();
    markDirty();
  }
}

function commitAnswer() {
  const question = state.questionnaire?.questions?.[state.currentQuestionIndex];
  if (!question) {
    return;
  }

  const answer = question.answers[state.highlightedIndex];
  state.answers[state.currentQuestionIndex] = {
    questionId: question.id,
    questionPrompt: question.prompt,
    answerId: answer.id,
    answerLabel: answer.label,
    answerEffect: answer.effect,
  };
  playUiConfirmSound();

  if (state.currentQuestionIndex === state.questionnaire.questions.length - 1) {
    startGameGeneration();
    return;
  }

  state.currentQuestionIndex += 1;
  state.highlightedIndex = 0;
  markDirty();
}

async function startSession() {
  if (!canGenerateGames()) {
    syncHomeSelectionAvailability();
    return;
  }

  const token = ++state.requestToken;
  clearGameState();
  state.phase = 'loading-questions';
  state.questionnaire = null;
  state.answers = [];
  state.currentQuestionIndex = 0;
  state.highlightedIndex = 0;
  state.error = '';
  state.gameRecoveryCount = 0;
  state.repairingGame = false;
  state.loadingMiniGame = createLoadingMiniGame();
  state.libraryGames = [];
  state.librarySelection = 0;
  startLoadingRotation('questions');
  markDirty();

  try {
    const questionnaire = await fetchJson(resolveAppUrl('./api/questions'), {
      method: 'POST',
    });

    if (token !== state.requestToken) {
      return;
    }

    state.questionnaire = questionnaire;
    state.phase = 'questionnaire';
    stopLoadingRotation();
    markDirty();
  } catch (error) {
    if (token !== state.requestToken) {
      return;
    }

    showError(error instanceof Error ? error.message : 'Unable to create the questionnaire.');
  }
}

async function startGameGeneration() {
  state.gameRecoveryCount = 0;
  state.repairingGame = false;
  state.lastGameRequestPayload = {
    sessionId: state.questionnaire.sessionId,
    questionnaireTitle: state.questionnaire.title,
    questionnaireIntro: state.questionnaire.intro,
    selections: state.answers,
  };

  await requestGameBuild(state.lastGameRequestPayload, 'game');
}

async function pollGameJob(token, jobId) {
  while (token === state.requestToken) {
    await delay(1500);

    const result = await fetchJson(resolveAppUrl(`./api/games/${encodeURIComponent(jobId)}`));
    if (token !== state.requestToken) {
      return;
    }

    if (result.status === 'completed') {
      state.phase = 'playing';
      state.gameResult = result.result;
      state.thumbnailRequestedFor = '';
      state.thumbnailSavedFor = result.result.thumbnailDataUrl ? result.result.libraryId || '' : '';
      state.repairingGame = false;
      stopLoadingRotation();
      markDirty();
      return;
    }

    if (result.status === 'failed' || result.status === 'cancelled') {
      if (await tryRepairGame(result.error || 'Game generation stopped unexpectedly.')) {
        return;
      }

      showError(result.error || 'Game generation stopped unexpectedly.');
      return;
    }
  }
}

async function resetExperience() {
  const oldJobId = state.gameJobId;
  ++state.requestToken;
  stopLoadingRotation();
  clearThumbnailCaptureTimer();
  state.phase = 'home';
  state.questionnaire = null;
  state.answers = [];
  state.currentQuestionIndex = 0;
  state.highlightedIndex = 0;
  state.error = '';
  state.gameJobId = '';
  state.gameResult = null;
  state.mountedGameHtml = '';
  state.lastGameRequestPayload = null;
  state.gameRecoveryCount = 0;
  state.repairingGame = false;
  state.loadingMiniGame = createLoadingMiniGame();
  state.homeSelection = canGenerateGames() ? 0 : 1;
  state.librarySelection = 0;
  markDirty();

  if (oldJobId) {
    fetch(resolveAppUrl(`./api/games/${encodeURIComponent(oldJobId)}/cancel`), { method: 'POST' }).catch(() => {});
  }

  state.resetHoldStartedAt = null;
  state.resetHoldLastSeenAt = null;
  state.resetLatched = false;
}

async function openLibrary() {
  const token = ++state.requestToken;
  clearGameState();
  state.phase = 'loading-library';
  state.error = '';
  startLoadingRotation('library');
  markDirty();

  try {
    const result = await loadLibraryGames();
    if (token !== state.requestToken) {
      return;
    }

    state.libraryGames = Array.isArray(result.games) ? result.games : [];
    state.librarySelection = 0;
    state.phase = 'library';
    stopLoadingRotation();
    queueSelectedLibraryPreview();
    markDirty();
  } catch (error) {
    if (token !== state.requestToken) {
      return;
    }

    showError(error instanceof Error ? error.message : 'Unable to load saved games.');
  }
}

async function playSavedGame(gameId) {
  const token = ++state.requestToken;
  stopLoadingRotation();
  clearThumbnailCaptureTimer();
  state.phase = 'loading-library';
  state.error = '';
  startLoadingRotation('library');
  markDirty();

  try {
    const savedGame = await loadSavedGame(gameId);
    if (token !== state.requestToken) {
      return;
    }

    stopLoadingRotation();
    state.phase = 'playing';
    state.gameJobId = '';
    state.gameResult = {
      libraryId: savedGame.id,
      title: savedGame.title,
      attractText: savedGame.attractText,
      html: normalizeHostedGameHtml(savedGame.html),
      thumbnailDataUrl: savedGame.thumbnailDataUrl || '',
    };
    state.thumbnailRequestedFor = '';
    state.thumbnailSavedFor = savedGame.thumbnailDataUrl ? savedGame.id : '';
    state.mountedGameHtml = '';
    markDirty();
  } catch (error) {
    if (token !== state.requestToken) {
      return;
    }

    showError(error instanceof Error ? error.message : 'Unable to load the saved game.');
  }
}

function goHome() {
  stopLoadingRotation();
  clearGameState();
  state.phase = 'home';
  state.questionnaire = null;
  state.answers = [];
  state.currentQuestionIndex = 0;
  state.highlightedIndex = 0;
  state.error = '';
  state.homeSelection = canGenerateGames() ? 0 : 1;
  state.resetHoldStartedAt = null;
  state.resetHoldLastSeenAt = null;
  state.resetLatched = false;
  markDirty();
}

function clearGameState() {
  clearThumbnailCaptureTimer();
  state.gameJobId = '';
  state.gameResult = null;
  state.mountedGameHtml = '';
  state.libraryPreviewRequestId += 1;
  state.frameInput = makeEmptyInput();
  state.lastGameRequestPayload = null;
  state.gameRecoveryCount = 0;
  state.repairingGame = false;
  state.loadingMiniGame = createLoadingMiniGame();
  state.thumbnailRequestedFor = '';
  state.thumbnailSavedFor = '';
  state.lastSafeGameInput = makeEmptyInput();
}

function clearThumbnailCaptureTimer() {
  if (!state.thumbnailCaptureTimer) {
    return;
  }

  window.clearTimeout(state.thumbnailCaptureTimer);
  state.thumbnailCaptureTimer = null;
}

function showError(message) {
  clearThumbnailCaptureTimer();
  stopLoadingRotation();
  state.phase = 'error';
  state.error = message;
  markDirty();
}

function startLoadingRotation(setName) {
  stopLoadingRotation();
  state.loadingSet = setName;
  state.loadingIndex = 0;
  state.loadingTimer = window.setInterval(() => {
    state.loadingIndex = (state.loadingIndex + 1) % loadingSets[state.loadingSet].length;
    markDirty();
  }, 1600);
}

function stopLoadingRotation() {
  if (state.loadingTimer) {
    window.clearInterval(state.loadingTimer);
    state.loadingTimer = null;
  }
}

function flushRender() {
  if (!dirty) {
    return;
  }

  dirty = false;
  app.innerHTML = renderApp();
  mountGameIfNeeded();
  syncLibrarySelectionUi();
}

function mountGameIfNeeded() {
  if (state.phase !== 'playing' || !state.gameResult?.html) {
    state.mountedGameHtml = '';
    return;
  }

  const iframe = document.querySelector('#game-frame');
  if (!iframe) {
    return;
  }

  if (iframe.srcdoc === state.gameResult.html && state.mountedGameHtml === state.gameResult.html) {
    return;
  }

  iframe.srcdoc = state.gameResult.html;
  state.mountedGameHtml = state.gameResult.html;
}

function handleWindowMessage(event) {
  const data = event.data;
  if (!data || typeof data !== 'object') {
    return;
  }

  if (data.type === 'arcade-frame-input') {
    state.frameInput = state.phase === 'playing' ? sanitizeFrameInput(data.state) : makeEmptyInput();
    return;
  }

  if (data.type === 'arcade-game-error' && state.phase === 'playing' && !state.repairingGame) {
    Promise.resolve(tryRepairGame(data.message || 'The generated game hit a runtime error.')).then((repaired) => {
      if (!repaired) {
        showError(data.message || 'The generated game hit a runtime error.');
      }
    });
    return;
  }

  if (data.type === 'arcade-thumbnail' && typeof data.imageDataUrl === 'string') {
    saveThumbnail(data.imageDataUrl);
  }
}

function pushInputToGame() {
  if (state.phase !== 'playing') {
    return;
  }

  const iframe = document.querySelector('#game-frame');
  if (!iframe?.contentWindow) {
    return;
  }

  const isResetCombo = state.input.up && state.input.button1 && state.input.button2;
  const liveGameInput = {
    up: state.input.up,
    down: state.input.down,
    left: state.input.left,
    right: state.input.right,
    upPressed: state.input.upPressed,
    downPressed: state.input.downPressed,
    leftPressed: state.input.leftPressed,
    rightPressed: state.input.rightPressed,
    button1: state.input.button1,
    button2: state.input.button2,
    button1Pressed: state.input.button1Pressed,
    button2Pressed: state.input.button2Pressed,
  };
  const gameInput = isResetCombo ? state.lastSafeGameInput : liveGameInput;

  if (!isResetCombo) {
    state.lastSafeGameInput = { ...liveGameInput };
  }

  iframe.contentWindow.postMessage(
    {
      type: 'arcade-input',
      state: gameInput,
    },
    '*',
  );
}

function maybeScheduleThumbnailCapture() {
  if (state.phase !== 'playing' || !state.input.button1Pressed) {
    return;
  }

  const libraryId = state.gameResult?.libraryId;
  if (!libraryId || state.thumbnailSavedFor === libraryId || state.thumbnailRequestedFor === libraryId) {
    return;
  }

  scheduleThumbnailCapture(libraryId);
}

function scheduleThumbnailCapture(libraryId) {
  clearThumbnailCaptureTimer();
  state.thumbnailRequestedFor = libraryId;
  state.thumbnailCaptureTimer = window.setTimeout(() => {
    state.thumbnailCaptureTimer = null;

    if (state.phase !== 'playing' || state.gameResult?.libraryId !== libraryId) {
      return;
    }

    const iframe = document.querySelector('#game-frame');
    if (!iframe?.contentWindow) {
      state.thumbnailRequestedFor = '';
      return;
    }

    iframe.contentWindow.postMessage({ type: 'arcade-capture-thumbnail' }, '*');
  }, 850);
}

async function saveThumbnail(imageDataUrl) {
  if (!state.runtime.apiReachable) {
    return;
  }

  const libraryId = state.gameResult?.libraryId;
  if (!libraryId || state.thumbnailSavedFor === libraryId) {
    return;
  }

  try {
    await fetchJson(resolveAppUrl(`./api/library/${encodeURIComponent(libraryId)}/thumbnail`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ thumbnailDataUrl: imageDataUrl }),
    });

    state.thumbnailSavedFor = libraryId;
    if (state.gameResult) {
      state.gameResult.thumbnailDataUrl = imageDataUrl;
    }

    const gameIndex = state.libraryGames.findIndex((game) => game.id === libraryId);
    if (gameIndex >= 0) {
      state.libraryGames[gameIndex] = {
        ...state.libraryGames[gameIndex],
        thumbnailDataUrl: imageDataUrl,
      };
    }

    markDirty();
  } catch {
    state.thumbnailRequestedFor = '';
  }
}

async function loadLibraryGames() {
  try {
    const result = await fetchJson(resolveAppUrl('./api/library'));
    return {
      games: (Array.isArray(result.games) ? result.games : []).map((game) => ({
        ...game,
        detailsLoaded: true,
      })),
    };
  } catch {
    const games = await fetchJson(staticLibraryUrl('index.json'));
    return {
      games: sortLibraryGames(Array.isArray(games) ? games : games.games).map((game) => ({
        ...game,
        detailsLoaded: false,
        thumbnailDataUrl: game.thumbnailDataUrl || '',
      })),
    };
  }
}

async function loadSavedGame(gameId) {
  try {
    return await fetchJson(resolveAppUrl(`./api/library/${encodeURIComponent(gameId)}`));
  } catch {
    return await fetchJson(staticLibraryUrl(`${encodeURIComponent(gameId)}.json`));
  }
}

function sortLibraryGames(games) {
  return [...(Array.isArray(games) ? games : [])].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

function queueSelectedLibraryPreview() {
  void ensureSelectedLibraryPreview();
}

async function ensureSelectedLibraryPreview() {
  if (state.phase !== 'library') {
    return;
  }

  const selected = state.libraryGames[state.librarySelection];
  if (!selected || selected.detailsLoaded) {
    return;
  }

  const requestId = ++state.libraryPreviewRequestId;

  try {
    const savedGame = await loadSavedGame(selected.id);
    if (state.phase !== 'library' || requestId !== state.libraryPreviewRequestId) {
      return;
    }

    const gameIndex = state.libraryGames.findIndex((game) => game.id === selected.id);
    if (gameIndex < 0) {
      return;
    }

    state.libraryGames[gameIndex] = {
      ...state.libraryGames[gameIndex],
      attractText: savedGame.attractText || state.libraryGames[gameIndex].attractText,
      thumbnailDataUrl: savedGame.thumbnailDataUrl || '',
      detailsLoaded: true,
    };
    markDirty();
  } catch {
    if (state.phase !== 'library' || requestId !== state.libraryPreviewRequestId) {
      return;
    }

    const gameIndex = state.libraryGames.findIndex((game) => game.id === selected.id);
    if (gameIndex >= 0) {
      state.libraryGames[gameIndex] = {
        ...state.libraryGames[gameIndex],
        detailsLoaded: true,
      };
      markDirty();
    }
  }
}

function normalizeHostedGameHtml(html) {
  return injectClientHostBridge(stripInjectedHostBridge(html));
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

function injectClientHostBridge(html) {
  const bridge = buildClientHostBridge();

  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n${bridge}\n`);
  }

  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (match) => `${match}\n<head>\n${bridge}\n</head>`);
  }

  return ['<!doctype html>', '<html>', '<head>', bridge, '</head>', '<body style="margin:0;background:#02050b;">', html, '</body>', '</html>'].join('\n');
}

function buildClientHostBridge() {
  return `
${CLIENT_HOST_BRIDGE_START}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>
window.arcadeInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  button1: false,
  button2: false,
  escape: false,
  upPressed: false,
  downPressed: false,
  leftPressed: false,
  rightPressed: false,
  button1Pressed: false,
  button2Pressed: false,
  escapePressed: false,
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
  'ShiftRight',
  'Escape'
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
    button2: frameMouseButtons.has(2) || frameKeys.has('ShiftLeft') || frameKeys.has('ShiftRight'),
    escape: frameKeys.has('Escape')
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
${CLIENT_HOST_BRIDGE_END}`.trim();
}

function renderApp() {
  if (state.phase === 'playing') {
    return `
      <section class="screen play-screen">
        ${renderGameStage()}
      </section>
    `;
  }

  const controllerLabel = state.hasController ? shortenControllerName(state.controllerName) : 'Waiting for joystick';
  const controllerClass = state.hasController ? 'status-pill live' : 'status-pill warn';
  const useCompactHeader = true;
  const hideFooter = state.phase === 'home' || state.phase === 'loading-game';
  const screenClasses = [
    'screen',
    state.phase === 'loading-game' ? 'build-screen' : '',
    state.phase === 'home' ? 'home-screen' : '',
    useCompactHeader ? 'compact-screen' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `
    <section class="${screenClasses}">
      <header class="top-bar">
        <div class="header-mark">AI Arcade</div>
        <div class="status-row">
          <div class="${controllerClass}">${escapeHtml(controllerLabel)}</div>
        </div>
      </header>
      ${renderContent()}
      ${hideFooter ? '' : renderFooter()}
    </section>
  `;
}

function renderContent() {
  if (state.phase === 'home') {
    return renderHome();
  }

  if (state.phase === 'library') {
    return renderLibrary();
  }

  if (state.phase === 'questionnaire') {
    return renderQuestionnaire();
  }

  if (state.phase === 'loading-questions' || state.phase === 'loading-library' || state.phase === 'loading-game') {
    return renderLoader();
  }

  if (state.phase === 'playing') {
    return renderGameStage();
  }

  return renderError();
}

function usingKeyboardMenuFallback() {
  return !state.hasController;
}

function menuMoveInstruction() {
  return usingKeyboardMenuFallback() ? 'Arrow keys move' : 'Stick moves';
}

function menuBrowseInstruction(hasGames) {
  if (!hasGames) {
    return 'No saved games yet';
  }

  return usingKeyboardMenuFallback() ? 'Arrow keys browse list' : 'Stick browses list';
}

function menuSelectInstruction() {
  return usingKeyboardMenuFallback() ? 'Enter selects' : 'Button 1 selects';
}

function menuPlayInstruction(hasGames) {
  return usingKeyboardMenuFallback()
    ? hasGames
      ? 'Enter plays'
      : 'Enter returns'
    : hasGames
      ? 'Button 1 plays'
      : 'Button 1 returns';
}

function menuConfirmInstruction() {
  return usingKeyboardMenuFallback() ? 'Enter confirms' : 'Button 1 confirms';
}

function menuBackInstruction() {
  return usingKeyboardMenuFallback() ? 'Shift returns home' : 'Button 2 returns home';
}

function menuReturnHomeInstruction() {
  return usingKeyboardMenuFallback() ? 'Press Enter or Shift to return home.' : 'Press Button 1 or Button 2 to return home.';
}

function menuSelectionHint(slot, active) {
  if (active) {
    return usingKeyboardMenuFallback() ? 'Press Enter to confirm' : 'Press Button 1 to confirm';
  }

  if (!usingKeyboardMenuFallback()) {
    return `Move stick ${slot.toLowerCase()} to select`;
  }

  return `Press ${slot === 'Left' ? 'Left' : 'Right'} arrow to select`;
}

function menuFlowInstruction(isLibrary) {
  if (usingKeyboardMenuFallback()) {
    return isLibrary
      ? 'When the list is ready, you can pick any saved game with the arrow keys and Enter.'
      : 'Once the questions arrive, the arrow keys and Enter handle the full 4-question run.';
  }

  return isLibrary
    ? 'When the list is ready, you can pick any saved game with the stick and Button 1.'
    : 'Once the questions arrive, the stick and Button 1 handle the full 4-question run.';
}

function resetInstructionText() {
  return usingKeyboardMenuFallback()
    ? 'Hold Up Arrow + Enter + Shift for 4 seconds to return to the home menu.'
    : 'Hold UP + Button 1 + Button 2 for 4 seconds to return to the home menu.';
}

function renderFooter() {
  if (state.phase === 'library') {
    const hasGames = state.libraryGames.length > 0;
    return `
      <footer class="bottom-bar">
        <div class="status-row">
          <div class="status-pill">${menuBrowseInstruction(hasGames)}</div>
          <div class="status-pill">${menuPlayInstruction(hasGames)}</div>
          <div class="status-pill">${menuBackInstruction()}</div>
        </div>
        <div class="status-pill">${state.libraryGames.length} saved ${state.libraryGames.length === 1 ? 'game' : 'games'}</div>
      </footer>
    `;
  }

  if (state.phase === 'error') {
    return `
      <footer class="bottom-bar">
        <div class="status-row">
          <div class="status-pill">${usingKeyboardMenuFallback() ? 'Enter returns home' : 'Button 1 returns home'}</div>
        </div>
        <div class="status-pill warn">Connection or generation issue</div>
      </footer>
    `;
  }

  if (state.phase === 'questionnaire') {
    return `
      <footer class="bottom-bar">
        <div class="status-row">
          <div class="status-pill">${usingKeyboardMenuFallback() ? 'Arrow keys pick answer' : 'Stick picks answer'}</div>
          <div class="status-pill">${menuConfirmInstruction()}</div>
          <div class="status-pill">4 questions total</div>
        </div>
        ${renderResetMeter()}
      </footer>
    `;
  }

  if (state.phase === 'loading-questions' || state.phase === 'loading-library') {
    return `
      <footer class="bottom-bar">
        <div class="status-row">
          <div class="status-pill">Cabinet is working</div>
          <div class="status-pill">Please wait</div>
        </div>
        ${renderResetMeter()}
      </footer>
    `;
  }

  return `
    <footer class="bottom-bar">
      <div class="status-row">
        <div class="status-pill">${menuMoveInstruction()}</div>
        <div class="status-pill">${menuSelectInstruction()}</div>
        <div class="status-pill">${usingKeyboardMenuFallback() ? 'Shift stays free' : 'Button 2 stays free'}</div>
      </div>
      ${renderResetMeter()}
    </footer>
  `;
}

function renderHome() {
  const generationUnavailable = state.runtime.generationAvailable === false;
  const options = [
    {
      title: 'Generate New Game',
      detail: 'Answer 4 quick arcade questions and let the cabinet build something brand new.',
      note: generationUnavailable ? 'Needs API key in .env to use.' : '',
      disabled: generationUnavailable,
    },
    {
      title: 'Play Old Games',
      detail: 'Browse the saved library on this cabinet and jump straight back into a previous build.',
      note: '',
      disabled: false,
    },
  ];

  return `
    <div class="content home-layout">
      <section class="panel home-hero">
        <div class="home-video-frame">
          <video
            class="home-video"
            src="${escapeHtml(assetUrl('media/home-preview.mp4'))}"
            autoplay
            muted
            loop
            playsinline
            preload="auto"
            aria-label="Arcade cabinet style preview video"
          ></video>
        </div>
      </section>
      <aside class="panel home-options">
        ${options
          .map(
            (option, index) => `
              <article class="home-option ${index === state.homeSelection ? 'active' : ''} ${option.disabled ? 'disabled' : ''}">
                <div>
                  <h3>${escapeHtml(option.title)}</h3>
                  <p>${escapeHtml(option.detail)}</p>
                  ${option.note ? `<p class="home-option-note">${escapeHtml(option.note)}</p>` : ''}
                </div>
              </article>
            `,
          )
          .join('')}
      </aside>
    </div>
  `;
}

function renderLibrary() {
  const selected = state.libraryGames[state.librarySelection];

  if (!selected) {
    return `
      <div class="content library-layout">
        <section class="panel library-preview">
          <span class="info-kicker">Saved Library</span>
          <h2 class="question-prompt">No saved games yet.</h2>
          <p class="screen-copy">Generate a new game first and this cabinet will keep it here with the newest builds at the top.</p>
        </section>
        <aside class="panel library-list-panel">
          <div class="library-list-header">
            <span class="tiny-label">Browse</span>
            <span class="library-count">0 games</span>
          </div>
          <p class="screen-copy">${escapeHtml(menuReturnHomeInstruction())}</p>
        </aside>
      </div>
    `;
  }

  return `
    <div class="content library-layout">
      <section class="panel library-preview">
        <div class="library-thumb-shell">
          ${
            selected.thumbnailDataUrl
              ? `<img class="library-thumb-image" src="${escapeHtml(selected.thumbnailDataUrl)}" alt="${escapeHtml(selected.title)} thumbnail">`
              : '<div class="library-thumb-placeholder">No Thumbnail Yet</div>'
          }
        </div>
        <div class="library-preview-meta">
          <span class="info-kicker">Selected Game</span>
          <h2 class="library-preview-title">${escapeHtml(selected.title)}</h2>
          <p class="screen-copy library-preview-copy">${escapeHtml(selected.attractText || 'A saved cabinet build ready to replay.')}</p>
          <div class="status-pill">${escapeHtml(formatLibraryDate(selected.createdAt))}</div>
        </div>
      </section>
      <aside class="panel library-list-panel">
        <div class="library-list-header">
          <span class="tiny-label">Saved Games</span>
          <span class="library-count">${state.libraryGames.length} total</span>
        </div>
        <div class="library-list">
          ${state.libraryGames
            .map(
              (game, index) => `
                <article class="library-item ${index === state.librarySelection ? 'active' : ''}">
                  <div class="library-item-title">${escapeHtml(game.title)}</div>
                  <div class="library-item-date">${escapeHtml(formatLibraryDate(game.createdAt))}</div>
                </article>
              `,
            )
            .join('')}
        </div>
      </aside>
    </div>
  `;
}

function renderQuestionnaire() {
  const question = state.questionnaire.questions[state.currentQuestionIndex];
  const progress = ((state.currentQuestionIndex + 1) / state.questionnaire.questions.length) * 100;

  return `
    <div class="question-layout">
      <section class="panel question-shell">
        <div class="question-count">Question ${state.currentQuestionIndex + 1} of ${state.questionnaire.questions.length}</div>
        <h2 class="question-prompt">${escapeHtml(question.prompt)}</h2>
        <div class="answer-split">
          ${question.answers
            .map((answer, index) => {
              const active = index === state.highlightedIndex;
              const slot = index === 0 ? 'Left' : 'Right';
              return `
                <article class="answer-choice ${active ? 'active' : ''}">
                  <div class="answer-slot">${slot}</div>
                  <div class="answer-choice-text">${escapeHtml(answer.label)}</div>
                  <div class="answer-choice-hint">${escapeHtml(menuSelectionHint(slot, active))}</div>
                </article>
              `;
            })
            .join('')}
        </div>
        <div class="progress-shell" aria-hidden="true">
          <div class="progress-fill" style="width:${progress}%"></div>
        </div>
      </section>
      <div class="question-note">
        <span class="info-kicker">${escapeHtml(state.questionnaire.title)}</span>
        <p>${escapeHtml(state.questionnaire.intro)}</p>
      </div>
    </div>
  `;
}

function renderLoader() {
  const lines = loadingSets[state.loadingSet];
  const loadingLine = lines[state.loadingIndex] || lines[0];
  const isGame = state.phase === 'loading-game';

  if (isGame) {
    return renderGenerationStage(loadingLine);
  }

  return `
    <div class="content">
      <section class="panel clean-loader">
        <span class="eyebrow">${state.phase === 'loading-library' ? 'Opening Library' : 'Generating Questions'}</span>
        <div class="loader-line short">${escapeHtml(loadingLine)}</div>
        <div class="loader-dots" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <p class="loader-subline">
          ${escapeHtml(
            state.phase === 'loading-library'
              ? 'The cabinet is gathering saved games and sorting the newest runs first.'
              : 'The cabinet is asking OpenAI for 4 sharp game-design questions that will shape the next arcade build.',
          )}
        </p>
      </section>
      <aside class="panel info-stack">
        <section class="info-card">
          <span class="info-kicker">What Happens Next</span>
          <p>${escapeHtml(menuFlowInstruction(state.phase === 'loading-library'))}</p>
        </section>
        <section class="info-card">
          <span class="info-kicker">Cabinet Controls</span>
          <p>${escapeHtml(resetInstructionText())}</p>
        </section>
      </aside>
    </div>
  `;
}

function renderGenerationStage(loadingLine) {
  return `
    <div class="generator-layout">
      <section class="panel generator-play-panel">
        <div class="generator-kicker">While The Real Game Is Building</div>
        <canvas
          id="loading-mini-game"
          class="loading-mini-game"
          width="720"
          height="720"
          aria-label="Mini-game while the real arcade game is generating"
        ></canvas>
      </section>
      <aside class="generator-side">
        <section class="panel generator-info-panel">
          <span class="info-kicker">Generating Your Actual Game</span>
          <div class="loader-line short">${escapeHtml(loadingLine)}</div>
          <p class="loader-subline">This mini-game is only here to entertain the player while OpenAI builds the real cabinet game from the chosen answers.</p>
        </section>
        <section class="panel generator-info-panel">
          <span class="info-kicker">Mini-Game Controls</span>
          <ul class="helper-list">
            <li>Press or hold <span class="control-emphasis">Button 1</span> or <span class="control-emphasis">UP</span> to jump higher.</li>
            <li>Hold <span class="control-emphasis">Button 2</span> to run the mini-game at <span class="control-emphasis">2x speed</span>.</li>
            <li>Hop over ground blocks and stay grounded under the overhead swoops.</li>
            <li>Hold <span class="control-emphasis">UP + Button 1 + Button 2</span> for 4 seconds to go home.</li>
          </ul>
        </section>
      </aside>
    </div>
  `;
}

function renderGameStage() {
  return `
    <div class="play-stage">
      <div class="play-frame-shell">
        <iframe
          id="game-frame"
          class="game-frame"
          title="Generated arcade game"
          sandbox="allow-scripts"
        ></iframe>
      </div>
      <div class="play-restart">
        <div class="tiny-label">${escapeHtml(state.gameResult.title)}</div>
        <p>Hold UP + Button 1 + Button 2 for 4 seconds to return to the home menu.</p>
        ${renderResetMeter()}
      </div>
    </div>
  `;
}

function renderError() {
  return `
    <div class="content">
      <section class="panel">
        <span class="eyebrow">Cabinet Fault</span>
        <h2 class="question-prompt">The run hit a snag.</h2>
        <p class="screen-copy error-copy">${escapeHtml(state.error)}</p>
        <p class="screen-copy">${escapeHtml(usingKeyboardMenuFallback() ? 'Press Enter to return to the home menu.' : 'Press Button 1 to return to the home menu.')}</p>
      </section>
      <aside class="panel">
        <span class="info-kicker">Most Common Cause</span>
        <div class="selected-list">
          <div class="selected-item">
            <strong>Missing OpenAI key</strong>
            The local server needs OPENAI_API_KEY in a .env file or exported environment variable.
          </div>
          <div class="selected-item">
            <strong>Network outage</strong>
            The cabinet can render locally, but it still needs internet access to ask OpenAI for questions and game code.
          </div>
        </div>
      </aside>
    </div>
  `;
}

function renderResetMeter() {
  const progress = getResetProgress();
  return `
    <div class="reset-meter">
      <div class="reset-label">
        <span>${escapeHtml(usingKeyboardMenuFallback() ? 'Hold Up Arrow + Enter + Shift to restart' : 'Hold UP + B1 + B2 to restart')}</span>
        <span class="reset-value">${Math.round(progress * 100)}%</span>
      </div>
      <div class="progress-shell" aria-hidden="true">
        <div class="progress-fill" style="width:${progress * 100}%"></div>
      </div>
    </div>
  `;
}

function getResetProgress() {
  if (state.resetHoldStartedAt === null) {
    return 0;
  }

  const elapsed = performance.now() - state.resetHoldStartedAt;
  return Math.max(0, Math.min(1, elapsed / 4000));
}

function updateLiveResetMeter() {
  const meter = document.querySelector('.reset-meter');
  if (!meter) {
    return;
  }

  const progress = getResetProgress();
  const fill = meter.querySelector('.progress-fill');
  const value = meter.querySelector('.reset-value');

  if (fill) {
    fill.style.width = `${progress * 100}%`;
  }

  if (value) {
    value.textContent = `${Math.round(progress * 100)}%`;
  }
}

function shortenControllerName(name) {
  return name.length > 34 ? `${name.slice(0, 31)}...` : name;
}

function formatLibraryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }

  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}.`);
  }

  return payload;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function requestGameBuild(payload, loadingSet) {
  const token = ++state.requestToken;
  state.phase = 'loading-game';
  state.error = '';
  state.gameJobId = '';
  state.gameResult = null;
  state.mountedGameHtml = '';
  state.loadingMiniGame = createLoadingMiniGame();
  startLoadingRotation(loadingSet);
  markDirty();

  try {
    const result = await fetchJson(resolveAppUrl('./api/games'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (token !== state.requestToken) {
      fetch(resolveAppUrl(`./api/games/${encodeURIComponent(result.jobId)}/cancel`), { method: 'POST' }).catch(() => {});
      return;
    }

    state.gameJobId = result.jobId;
    markDirty();
    await pollGameJob(token, result.jobId);
  } catch (error) {
    if (token !== state.requestToken) {
      return;
    }

    if (loadingSet === 'repair') {
      showError(error instanceof Error ? error.message : 'Unable to repair the generated game.');
      return;
    }

    showError(error instanceof Error ? error.message : 'Unable to start game generation.');
  }
}

async function tryRepairGame(message) {
  if (!state.lastGameRequestPayload || state.gameRecoveryCount >= 1 || state.repairingGame) {
    return false;
  }

  state.gameRecoveryCount += 1;
  state.repairingGame = true;

  const payload = {
    ...state.lastGameRequestPayload,
    repairError: String(message || 'The generated game failed.'),
  };

  await requestGameBuild(payload, 'repair');
  return true;
}

function createLoadingMiniGame() {
  return {
    started: false,
    x: 128,
    y: 590,
    vy: 0,
    gravity: 0.9,
    jumpPower: -16.4,
    groundY: 590,
    obstacles: [],
    score: 0,
    best: 0,
    frame: 0,
    spawnCooldown: 84,
    blink: 0,
    jumpBoostFrames: 0,
    bars: Array.from({ length: 8 }, (_, index) => ({
      x: 44 + index * 84,
      width: 42,
      baseHeight: 88 + (index % 3) * 42,
      swing: 18 + (index % 4) * 8,
      phase: index * 0.9,
    })),
  };
}

function updateLoadingMiniGame() {
  if (state.phase !== 'loading-game') {
    return;
  }

  const game = state.loadingMiniGame;
  const speedMultiplier = state.input.button2 ? 2 : 1;
  game.frame += speedMultiplier;
  game.blink += 1;

  if (!game.started) {
    if (state.input.button1Pressed || state.input.upPressed) {
      startLoadingMiniGameRound();
      playMiniGameJumpSound();
      markDirty();
    }
    return;
  }

  const jumpHeld = state.input.button1 || state.input.up;
  if ((state.input.button1Pressed || state.input.upPressed) && game.y >= game.groundY - 2) {
    game.vy = game.jumpPower;
    game.jumpBoostFrames = 8;
    playMiniGameJumpSound();
  } else if (jumpHeld && game.jumpBoostFrames > 0 && game.vy < 0) {
    game.vy -= 0.45;
    game.jumpBoostFrames -= 1;
  } else if (!jumpHeld) {
    game.jumpBoostFrames = 0;
  }

  game.vy += game.gravity;
  game.y = Math.min(game.groundY, game.y + game.vy);
  if (game.y >= game.groundY) {
    game.vy = 0;
    game.jumpBoostFrames = 0;
  }

  game.spawnCooldown -= speedMultiplier;
  if (game.spawnCooldown <= 0) {
    const useAirObstacle = game.score > 8 && Math.random() < 0.36;

    if (useAirObstacle) {
      game.obstacles.push({
        kind: 'air',
        x: 780,
        width: 88 + Math.random() * 16,
        top: 422 + Math.random() * 24,
        height: 54 + Math.random() * 12,
        drift: Math.random() * Math.PI * 2,
      });
      game.spawnCooldown = 82 + Math.floor(Math.random() * 18);
    } else {
      game.obstacles.push({
        kind: 'ground',
        x: 780,
        width: 26 + Math.random() * 18,
        height: 34 + Math.random() * 24,
      });
      game.spawnCooldown = 68 + Math.floor(Math.random() * 14);
    }
  }

  const speed = (6.7 + Math.min(6.6, game.score / 22)) * speedMultiplier;
  game.score += 0.12 * speedMultiplier;

  for (let index = game.obstacles.length - 1; index >= 0; index -= 1) {
    const obstacle = game.obstacles[index];
    obstacle.x -= speed;

    if (obstacle.x + obstacle.width < -20) {
      game.obstacles.splice(index, 1);
      continue;
    }

    const playerLeft = game.x - 26;
    const playerRight = game.x + 22;
    const playerTop = game.y - 56;
    const playerBottom = game.y;
    const obstacleTop =
      obstacle.kind === 'air'
        ? obstacle.top + Math.sin((game.frame + obstacle.drift) * 0.05) * 12
        : game.groundY - obstacle.height;
    const obstacleBottom =
      obstacle.kind === 'air' ? obstacleTop + obstacle.height : game.groundY;
    const obstacleLeft = obstacle.x;
    const obstacleRight = obstacle.x + obstacle.width;

    if (
      playerRight > obstacleLeft &&
      playerLeft < obstacleRight &&
      playerBottom > obstacleTop &&
      playerTop < obstacleBottom
    ) {
      game.best = Math.max(game.best, Math.floor(game.score));
      game.started = false;
      game.score = 0;
      game.obstacles = [];
      game.spawnCooldown = 78;
      game.y = game.groundY;
      game.vy = 0;
      game.jumpBoostFrames = 0;
      playMiniGameHitSound();
      break;
    }
  }
}

function startLoadingMiniGameRound() {
  const game = state.loadingMiniGame;
  game.started = true;
  game.score = 0;
  game.obstacles = [];
  game.spawnCooldown = 68;
  game.y = game.groundY;
  game.vy = 0;
  game.jumpBoostFrames = 0;
}

function drawLoadingMiniGame() {
  const canvas = document.querySelector('#loading-mini-game');
  if (!canvas) {
    return;
  }

  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  const game = state.loadingMiniGame;
  const width = canvas.width;
  const height = canvas.height;

  context.clearRect(0, 0, width, height);
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#11263a');
  gradient.addColorStop(0.6, '#0c1826');
  gradient.addColorStop(1, '#09111a');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  for (let x = 0; x < width; x += 48) {
    context.strokeStyle = 'rgba(255,255,255,0.035)';
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }

  for (let y = 0; y < height; y += 48) {
    context.strokeStyle = 'rgba(255,255,255,0.025)';
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  for (const bar of game.bars) {
    const barHeight = bar.baseHeight + Math.sin(game.frame * 0.04 + bar.phase) * bar.swing;
    const capY = game.groundY - barHeight - 26;
    context.fillStyle = 'rgba(47, 86, 122, 0.72)';
    context.fillRect(bar.x, game.groundY - barHeight, bar.width, barHeight);
    context.fillStyle = 'rgba(112, 194, 226, 0.22)';
    context.fillRect(bar.x + 12, capY, bar.width - 24, 16);
  }

  context.strokeStyle = '#7ee1d0';
  context.lineWidth = 6;
  context.beginPath();
  context.moveTo(0, game.groundY + 6);
  context.lineTo(width, game.groundY + 6);
  context.stroke();

  for (const obstacle of game.obstacles) {
    if (obstacle.kind === 'air') {
      const top = obstacle.top + Math.sin((game.frame + obstacle.drift) * 0.05) * 12;
      const bottom = top + obstacle.height;

      context.fillStyle = '#ff8e6a';
      context.beginPath();
      context.moveTo(obstacle.x + 12, top);
      context.lineTo(obstacle.x + obstacle.width - 12, top);
      context.lineTo(obstacle.x + obstacle.width, top + obstacle.height * 0.48);
      context.lineTo(obstacle.x + obstacle.width - 16, bottom);
      context.lineTo(obstacle.x + 16, bottom);
      context.lineTo(obstacle.x, top + obstacle.height * 0.48);
      context.closePath();
      context.fill();

      context.fillStyle = '#09111f';
      context.fillRect(obstacle.x + obstacle.width * 0.36, top + 18, obstacle.width * 0.28, 12);
    } else {
      const top = game.groundY - obstacle.height;
      context.fillStyle = '#ffd070';
      context.fillRect(obstacle.x, top, obstacle.width, obstacle.height);
      context.fillStyle = '#1f2732';
      context.fillRect(obstacle.x + 6, top + 8, obstacle.width - 12, Math.max(10, obstacle.height - 16));
      context.fillStyle = '#fff3cc';
      context.fillRect(obstacle.x, top, obstacle.width, 6);
    }
  }

  context.save();
  context.translate(game.x, game.y - 14);
  context.fillStyle = '#f3f1e9';
  context.fillRect(-18, -36, 40, 34);
  context.fillRect(-28, -8, 58, 14);
  context.fillRect(-8, -46, 26, 12);
  context.fillStyle = '#0b1520';
  context.fillRect(10, -38, 6, 6);
  context.fillStyle = '#7ee1d0';
  context.fillRect(-24, 4, 12, 8);
  context.fillRect(6, 4, 12, 8);
  context.restore();

  context.fillStyle = '#f2f4e8';
  context.font = 'bold 28px Trebuchet MS';
  context.fillText(`Score ${Math.floor(game.score)}`, 28, 42);
  context.fillText(`Best ${game.best}`, 28, 78);

  if (state.input.button2) {
    context.font = 'bold 20px Trebuchet MS';
    context.fillStyle = '#ffd070';
    context.fillText('2X SPEED', 28, 116);
  }

  if (!game.started && Math.floor(game.blink / 30) % 2 === 0) {
    context.textAlign = 'center';
    context.fillStyle = '#ffd070';
    context.font = 'bold 26px Trebuchet MS';
    context.fillText('PRESS BUTTON 1 OR UP TO START', width / 2, 210);
    context.font = 'bold 20px Trebuchet MS';
    context.fillStyle = '#c8d8ea';
    context.fillText('Hold jump for height, Button 2 for turbo', width / 2, 244);
    context.textAlign = 'start';
  }
}
