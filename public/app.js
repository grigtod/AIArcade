const app = document.querySelector('#app');

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
  thumbnailCaptureTimer: null,
  thumbnailRequestedFor: '',
  thumbnailSavedFor: '',
  uiAudio: {
    context: null,
  },
  lastSafeGameInput: makeEmptyInput(),
};

let dirty = true;

window.addEventListener('gamepadconnected', () => markDirty());
window.addEventListener('gamepaddisconnected', () => markDirty());
window.addEventListener('message', handleWindowMessage);
requestAnimationFrame(frame);

function makeEmptyInput() {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    button1: false,
    button2: false,
    upPressed: false,
    downPressed: false,
    leftPressed: false,
    rightPressed: false,
    button1Pressed: false,
    button2Pressed: false,
  };
}

function markDirty() {
  dirty = true;
}

function frame(now) {
  updateControllerState();
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

function updateControllerState() {
  const previous = state.input;
  const gamepads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
  const gamepad = gamepads[0];

  if (!gamepad) {
    if (state.hasController) {
      state.hasController = false;
      state.controllerName = '';
      markDirty();
    }

    state.input = makeEmptyInput();
    return;
  }

  const next = makeEmptyInput();
  const axisX = gamepad.axes?.[0] || 0;
  const axisY = gamepad.axes?.[1] || 0;

  next.up = axisY < -0.45 || readButton(gamepad, 12);
  next.down = axisY > 0.45 || readButton(gamepad, 13);
  next.left = axisX < -0.45 || readButton(gamepad, 14);
  next.right = axisX > 0.45 || readButton(gamepad, 15);
  next.button1 = readButton(gamepad, 0);
  next.button2 = readButton(gamepad, 1);

  next.upPressed = next.up && !previous.up;
  next.downPressed = next.down && !previous.down;
  next.leftPressed = next.left && !previous.left;
  next.rightPressed = next.right && !previous.right;
  next.button1Pressed = next.button1 && !previous.button1;
  next.button2Pressed = next.button2 && !previous.button2;

  const controllerChanged = !state.hasController || state.controllerName !== gamepad.id;
  state.input = next;
  state.hasController = true;
  state.controllerName = gamepad.id || 'Arcade Controller';

  if (controllerChanged) {
    markDirty();
  }
}

function readButton(gamepad, index) {
  return Boolean(gamepad.buttons?.[index]?.pressed);
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

  playUiConfirmSound();
  if (state.homeSelection === 0) {
    startSession();
    return;
  }

  openLibrary();
}

function setHomeSelection(nextIndex) {
  const clampedIndex = Math.max(0, Math.min(1, nextIndex));
  if (clampedIndex !== state.homeSelection) {
    state.homeSelection = clampedIndex;
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
    const questionnaire = await fetchJson('/api/questions', {
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

    const result = await fetchJson(`/api/games/${encodeURIComponent(jobId)}`);
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
  state.homeSelection = 0;
  state.librarySelection = 0;
  markDirty();

  if (oldJobId) {
    fetch(`/api/games/${encodeURIComponent(oldJobId)}/cancel`, { method: 'POST' }).catch(() => {});
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
    const result = await fetchJson('/api/library');
    if (token !== state.requestToken) {
      return;
    }

    state.libraryGames = Array.isArray(result.games) ? result.games : [];
    state.librarySelection = 0;
    state.phase = 'library';
    stopLoadingRotation();
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
    const savedGame = await fetchJson(`/api/library/${encodeURIComponent(gameId)}`);
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
      html: savedGame.html,
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
  state.homeSelection = 0;
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
  const libraryId = state.gameResult?.libraryId;
  if (!libraryId || state.thumbnailSavedFor === libraryId) {
    return;
  }

  try {
    await fetchJson(`/api/library/${encodeURIComponent(libraryId)}/thumbnail`, {
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

function renderFooter() {
  if (state.phase === 'library') {
    const hasGames = state.libraryGames.length > 0;
    return `
      <footer class="bottom-bar">
        <div class="status-row">
          <div class="status-pill">${hasGames ? 'Stick browses list' : 'No saved games yet'}</div>
          <div class="status-pill">${hasGames ? 'Button 1 plays' : 'Button 1 returns'}</div>
          <div class="status-pill">Button 2 returns home</div>
        </div>
        <div class="status-pill">${state.libraryGames.length} saved ${state.libraryGames.length === 1 ? 'game' : 'games'}</div>
      </footer>
    `;
  }

  if (state.phase === 'error') {
    return `
      <footer class="bottom-bar">
        <div class="status-row">
          <div class="status-pill">Button 1 returns home</div>
        </div>
        <div class="status-pill warn">Connection or generation issue</div>
      </footer>
    `;
  }

  if (state.phase === 'questionnaire') {
    return `
      <footer class="bottom-bar">
        <div class="status-row">
          <div class="status-pill">Stick picks answer</div>
          <div class="status-pill">Button 1 confirms</div>
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
        <div class="status-pill">Stick moves</div>
        <div class="status-pill">Button 1 selects</div>
        <div class="status-pill">Button 2 stays free</div>
      </div>
      ${renderResetMeter()}
    </footer>
  `;
}

function renderHome() {
  const options = [
    {
      title: 'Generate New Game',
      detail: 'Answer 4 quick arcade questions and let the cabinet build something brand new.',
    },
    {
      title: 'Play Old Games',
      detail: 'Browse the saved library on this cabinet and jump straight back into a previous build.',
    },
  ];

  return `
    <div class="content home-layout">
      <section class="panel home-hero">
        <div class="home-video-frame">
          <video
            class="home-video"
            src="/media/home-preview.mp4"
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
              <article class="home-option ${index === state.homeSelection ? 'active' : ''}">
                <div>
                  <h3>${escapeHtml(option.title)}</h3>
                  <p>${escapeHtml(option.detail)}</p>
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
          <p class="screen-copy">Press Button 1 or Button 2 to return home.</p>
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
                  <div class="answer-choice-hint">${active ? 'Press Button 1 to confirm' : `Move stick ${slot.toLowerCase()} to select`}</div>
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
          <p>${escapeHtml(state.phase === 'loading-library' ? 'When the list is ready, you can pick any saved game with the stick and Button 1.' : 'Once the questions arrive, the stick and Button 1 handle the full 4-question run.')}</p>
        </section>
        <section class="info-card">
          <span class="info-kicker">Cabinet Controls</span>
          <p>Hold UP + Button 1 + Button 2 for 4 seconds if you want to jump back to the home menu.</p>
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
        <p class="screen-copy">Press Button 1 to return to the home menu.</p>
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
        <span>Hold UP + B1 + B2 to restart</span>
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
    const result = await fetchJson('/api/games', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (token !== state.requestToken) {
      fetch(`/api/games/${encodeURIComponent(result.jobId)}/cancel`, { method: 'POST' }).catch(() => {});
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
