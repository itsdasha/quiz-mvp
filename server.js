const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_FILE = path.join(ROOT_DIR, 'data', 'db.json');
const PORT = Number(process.env.PORT || 3000);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let db = loadDb();
const wsClients = new Set();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, error.statusCode || 500, {
        error: error.statusCode ? error.message : 'Внутренняя ошибка сервера',
      });
    }
  }
});

server.on('upgrade', handleWebSocketUpgrade);

server.listen(PORT, () => {
  console.log(`Quiz MVP started: http://localhost:${PORT}`);
  console.log('Demo organizer: organizer@example.com / demo1234');
  console.log('Demo participant: participant@example.com / demo1234');
});

function loadDb() {
  ensureDataFile();
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  parsed.users ||= [];
  parsed.quizzes ||= [];
  parsed.rooms ||= [];
  parsed.authTokens ||= [];

  if (parsed.users.length === 0 && parsed.quizzes.length === 0) {
    seedDemoData(parsed);
    fs.writeFileSync(DATA_FILE, JSON.stringify(parsed, null, 2));
  }

  return parsed;
}

function ensureDataFile() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ users: [], quizzes: [], rooms: [], authTokens: [] }, null, 2),
    );
  }
}

function saveDb() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function seedDemoData(targetDb) {
  const organizerId = makeId('user');
  const participantId = makeId('user');
  const organizerPassword = hashPassword('demo1234');
  const participantPassword = hashPassword('demo1234');
  const createdAt = new Date().toISOString();

  targetDb.users.push(
    {
      id: organizerId,
      name: 'Демо Организатор',
      email: 'organizer@example.com',
      role: 'organizer',
      passwordSalt: organizerPassword.salt,
      passwordHash: organizerPassword.hash,
      createdAt,
    },
    {
      id: participantId,
      name: 'Демо Участник',
      email: 'participant@example.com',
      role: 'participant',
      passwordSalt: participantPassword.salt,
      passwordHash: participantPassword.hash,
      createdAt,
    },
  );

  targetDb.quizzes.push({
    id: makeId('quiz'),
    ownerId: organizerId,
    title: 'IT и цифровая культура',
    description: 'Короткий демонстрационный квиз для проверки MVP.',
    category: 'Информационные технологии',
    questionTimeLimit: 30,
    rules: 'За каждый правильный ответ начисляется 1 балл. Побеждает участник с наибольшим количеством баллов.',
    createdAt,
    updatedAt: createdAt,
    questions: [
      {
        id: makeId('question'),
        type: 'text',
        prompt: 'Какой протокол чаще всего используют для обмена сообщениями в реальном времени в веб-приложениях?',
        imageUrl: '',
        answerMode: 'single',
        points: 1,
        options: [
          { id: makeId('option'), text: 'WebSocket', correct: true },
          { id: makeId('option'), text: 'FTP', correct: false },
          { id: makeId('option'), text: 'SMTP', correct: false },
          { id: makeId('option'), text: 'POP3', correct: false },
        ],
      },
      {
        id: makeId('question'),
        type: 'image',
        prompt: 'Что изображено на схеме?',
        imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/6/6a/JavaScript-logo.png',
        answerMode: 'single',
        points: 1,
        options: [
          { id: makeId('option'), text: 'Логотип JavaScript', correct: true },
          { id: makeId('option'), text: 'Логотип Python', correct: false },
          { id: makeId('option'), text: 'Логотип Java', correct: false },
          { id: makeId('option'), text: 'Логотип SQL', correct: false },
        ],
      },
      {
        id: makeId('question'),
        type: 'text',
        prompt: 'Какие элементы обычно входят в клиентскую часть веб-приложения?',
        imageUrl: '',
        answerMode: 'multiple',
        points: 2,
        options: [
          { id: makeId('option'), text: 'HTML', correct: true },
          { id: makeId('option'), text: 'CSS', correct: true },
          { id: makeId('option'), text: 'JavaScript', correct: true },
          { id: makeId('option'), text: 'BIOS', correct: false },
        ],
      },
    ],
  });
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/register') {
    const body = await readJsonBody(req);
    const name = normalizeString(body.name);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const role = body.role === 'organizer' ? 'organizer' : 'participant';

    if (!name || !email || password.length < 6) {
      sendJson(res, 400, { error: 'Укажите имя, email и пароль не короче 6 символов' });
      return;
    }

    if (db.users.some((user) => user.email === email)) {
      sendJson(res, 409, { error: 'Пользователь с таким email уже существует' });
      return;
    }

    const passwordData = hashPassword(password);
    const user = {
      id: makeId('user'),
      name,
      email,
      role,
      passwordSalt: passwordData.salt,
      passwordHash: passwordData.hash,
      createdAt: new Date().toISOString(),
    };

    db.users.push(user);
    const token = createAuthToken(user.id);
    saveDb();
    sendJson(res, 201, { user: publicUser(user), token });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readJsonBody(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const user = db.users.find((candidate) => candidate.email === email);

    if (!user || !verifyPassword(password, user)) {
      sendJson(res, 401, { error: 'Неверный email или пароль' });
      return;
    }

    const token = createAuthToken(user.id);
    saveDb();
    sendJson(res, 200, { user: publicUser(user), token });
    return;
  }

  const auth = getAuth(req);

  if (req.method === 'GET' && pathname === '/api/me') {
    if (!auth) {
      sendJson(res, 401, { error: 'Нужно авторизоваться' });
      return;
    }

    sendJson(res, 200, { user: publicUser(auth.user) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    if (auth) {
      db.authTokens = db.authTokens.filter((item) => item.token !== auth.token);
      saveDb();
    }

    sendJson(res, 200, { ok: true });
    return;
  }

  if (!auth) {
    sendJson(res, 401, { error: 'Нужно авторизоваться' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/quizzes') {
    const quizzes =
      auth.user.role === 'organizer'
        ? db.quizzes.filter((quiz) => quiz.ownerId === auth.user.id)
        : db.quizzes;

    sendJson(res, 200, {
      quizzes: quizzes.map((quiz) => quizSummary(quiz)),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/quizzes') {
    if (auth.user.role !== 'organizer') {
      sendJson(res, 403, { error: 'Создавать квизы может только организатор' });
      return;
    }

    const payload = await readJsonBody(req);
    const normalized = normalizeQuizPayload(payload);
    const quiz = {
      id: makeId('quiz'),
      ownerId: auth.user.id,
      ...normalized,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    db.quizzes.push(quiz);
    saveDb();
    sendJson(res, 201, { quiz: quizForOwner(quiz) });
    return;
  }

  const quizMatch = pathname.match(/^\/api\/quizzes\/([^/]+)$/);
  if (quizMatch && req.method === 'GET') {
    const quiz = db.quizzes.find((candidate) => candidate.id === quizMatch[1]);

    if (!quiz) {
      sendJson(res, 404, { error: 'Квиз не найден' });
      return;
    }

    if (auth.user.role === 'organizer' && quiz.ownerId === auth.user.id) {
      sendJson(res, 200, { quiz: quizForOwner(quiz) });
      return;
    }

    sendJson(res, 200, { quiz: quizSummary(quiz) });
    return;
  }

  if (quizMatch && req.method === 'PUT') {
    const quiz = db.quizzes.find((candidate) => candidate.id === quizMatch[1]);

    if (!quiz) {
      sendJson(res, 404, { error: 'Квиз не найден' });
      return;
    }

    if (quiz.ownerId !== auth.user.id) {
      sendJson(res, 403, { error: 'Редактировать можно только свои квизы' });
      return;
    }

    const payload = await readJsonBody(req);
    Object.assign(quiz, normalizeQuizPayload(payload), {
      updatedAt: new Date().toISOString(),
    });
    saveDb();
    sendJson(res, 200, { quiz: quizForOwner(quiz) });
    return;
  }

  const startMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/start$/);
  if (startMatch && req.method === 'POST') {
    const quiz = db.quizzes.find((candidate) => candidate.id === startMatch[1]);

    if (!quiz) {
      sendJson(res, 404, { error: 'Квиз не найден' });
      return;
    }

    if (quiz.ownerId !== auth.user.id) {
      sendJson(res, 403, { error: 'Запускать можно только свои квизы' });
      return;
    }

    const room = {
      id: makeId('room'),
      quizId: quiz.id,
      ownerId: auth.user.id,
      code: generateRoomCode(),
      status: 'lobby',
      currentQuestionIndex: -1,
      questionStartedAt: null,
      participants: [],
      answers: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };

    db.rooms.push(room);
    saveDb();
    sendJson(res, 201, { room: roomForUser(room, auth.user) });
    return;
  }

  const roomMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/);
  if (roomMatch && req.method === 'GET') {
    const room = findRoom(roomMatch[1]);

    if (!room) {
      sendJson(res, 404, { error: 'Комната не найдена' });
      return;
    }

    if (!canViewRoom(room, auth.user)) {
      sendJson(res, 403, { error: 'Сначала подключитесь к комнате' });
      return;
    }

    sendJson(res, 200, { room: roomForUser(room, auth.user) });
    return;
  }

  const joinMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/join$/);
  if (joinMatch && req.method === 'POST') {
    const room = findRoom(joinMatch[1]);

    if (!room) {
      sendJson(res, 404, { error: 'Комната не найдена' });
      return;
    }

    if (room.status === 'finished') {
      sendJson(res, 409, { error: 'Квиз уже завершён' });
      return;
    }

    if (!room.participants.some((participant) => participant.userId === auth.user.id)) {
      room.participants.push({
        userId: auth.user.id,
        name: auth.user.name,
        joinedAt: new Date().toISOString(),
      });
      saveDb();
      broadcastRoom(room.code);
    }

    sendJson(res, 200, { room: roomForUser(room, auth.user) });
    return;
  }

  const nextMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/next$/);
  if (nextMatch && req.method === 'POST') {
    const room = findRoom(nextMatch[1]);

    if (!room) {
      sendJson(res, 404, { error: 'Комната не найдена' });
      return;
    }

    if (room.ownerId !== auth.user.id) {
      sendJson(res, 403, { error: 'Управлять комнатой может только организатор' });
      return;
    }

    const quiz = findQuiz(room.quizId);
    if (room.currentQuestionIndex + 1 >= quiz.questions.length) {
      finishRoom(room);
    } else {
      room.status = 'question';
      room.currentQuestionIndex += 1;
      room.questionStartedAt = new Date().toISOString();
      saveDb();
    }

    broadcastRoom(room.code);
    sendJson(res, 200, { room: roomForUser(room, auth.user) });
    return;
  }

  const answerMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/answer$/);
  if (answerMatch && req.method === 'POST') {
    const room = findRoom(answerMatch[1]);

    if (!room) {
      sendJson(res, 404, { error: 'Комната не найдена' });
      return;
    }

    const quiz = findQuiz(room.quizId);
    const question = quiz.questions[room.currentQuestionIndex];

    if (!question || room.status !== 'question') {
      sendJson(res, 409, { error: 'Сейчас нет активного вопроса' });
      return;
    }

    if (!room.participants.some((participant) => participant.userId === auth.user.id)) {
      sendJson(res, 403, { error: 'Нужно подключиться к комнате как участник' });
      return;
    }

    if (isQuestionExpired(room, quiz)) {
      sendJson(res, 409, { error: 'Время ответа истекло' });
      return;
    }

    if (room.answers.some((answer) => answer.userId === auth.user.id && answer.questionId === question.id)) {
      sendJson(res, 409, { error: 'Ответ на этот вопрос уже отправлен' });
      return;
    }

    const body = await readJsonBody(req);
    const selectedOptionIds = Array.isArray(body.selectedOptionIds)
      ? body.selectedOptionIds.map(String)
      : [];
    const validOptionIds = new Set(question.options.map((option) => option.id));
    const uniqueSelected = [...new Set(selectedOptionIds)].filter((optionId) => validOptionIds.has(optionId));

    if (question.answerMode === 'single' && uniqueSelected.length !== 1) {
      sendJson(res, 400, { error: 'Выберите один вариант ответа' });
      return;
    }

    if (question.answerMode === 'multiple' && uniqueSelected.length === 0) {
      sendJson(res, 400, { error: 'Выберите хотя бы один вариант ответа' });
      return;
    }

    const correctOptionIds = question.options
      .filter((option) => option.correct)
      .map((option) => option.id)
      .sort();
    const normalizedSelected = uniqueSelected.sort();
    const isCorrect = arraysEqual(correctOptionIds, normalizedSelected);

    room.answers.push({
      id: makeId('answer'),
      userId: auth.user.id,
      userName: auth.user.name,
      questionId: question.id,
      selectedOptionIds: normalizedSelected,
      submittedAt: new Date().toISOString(),
      isCorrect,
      points: isCorrect ? Number(question.points || 1) : 0,
    });

    saveDb();
    broadcastRoom(room.code);
    sendJson(res, 201, {
      result: {
        isCorrect,
        points: isCorrect ? Number(question.points || 1) : 0,
      },
      room: roomForUser(room, auth.user),
    });
    return;
  }

  const finishMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/finish$/);
  if (finishMatch && req.method === 'POST') {
    const room = findRoom(finishMatch[1]);

    if (!room) {
      sendJson(res, 404, { error: 'Комната не найдена' });
      return;
    }

    if (room.ownerId !== auth.user.id) {
      sendJson(res, 403, { error: 'Завершить квиз может только организатор' });
      return;
    }

    finishRoom(room);
    broadcastRoom(room.code);
    sendJson(res, 200, { room: roomForUser(room, auth.user) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/history') {
    const rooms =
      auth.user.role === 'organizer'
        ? db.rooms.filter((room) => room.ownerId === auth.user.id)
        : db.rooms.filter((room) =>
            room.participants.some((participant) => participant.userId === auth.user.id),
          );

    sendJson(res, 200, {
      history: rooms
        .slice()
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .map((room) => historyItem(room, auth.user)),
    });
    return;
  }

  sendJson(res, 404, { error: 'Маршрут API не найден' });
}

function normalizeQuizPayload(payload) {
  const title = normalizeString(payload.title);
  const description = normalizeString(payload.description);
  const category = normalizeString(payload.category) || 'Общее';
  const rules =
    normalizeString(payload.rules) ||
    'Ответ доступен только во время показа вопроса. Побеждает участник с максимальным количеством баллов.';
  const questionTimeLimit = clamp(Number(payload.questionTimeLimit || 30), 10, 180);
  const questions = Array.isArray(payload.questions) ? payload.questions : [];

  if (!title) {
    throwHttpError(400, 'Укажите название квиза');
  }

  if (questions.length === 0) {
    throwHttpError(400, 'Добавьте хотя бы один вопрос');
  }

  return {
    title,
    description,
    category,
    questionTimeLimit,
    rules,
    questions: questions.map((question) => normalizeQuestion(question)),
  };
}

function normalizeQuestion(question) {
  const type = question.type === 'image' ? 'image' : 'text';
  const prompt = normalizeString(question.prompt);
  const imageUrl = type === 'image' ? normalizeString(question.imageUrl) : '';
  const answerMode = question.answerMode === 'multiple' ? 'multiple' : 'single';
  const points = clamp(Number(question.points || 1), 1, 100);
  const options = Array.isArray(question.options) ? question.options : [];

  if (!prompt) {
    throwHttpError(400, 'Каждый вопрос должен содержать текст задания');
  }

  if (type === 'image' && !imageUrl) {
    throwHttpError(400, 'Для вопроса с изображением укажите ссылку на изображение');
  }

  if (options.length < 2) {
    throwHttpError(400, 'У каждого вопроса должно быть минимум два варианта ответа');
  }

  const normalizedOptions = options.map((option) => ({
    id: option.id || makeId('option'),
    text: normalizeString(option.text),
    correct: Boolean(option.correct),
  }));

  if (normalizedOptions.some((option) => !option.text)) {
    throwHttpError(400, 'Варианты ответа не должны быть пустыми');
  }

  const correctCount = normalizedOptions.filter((option) => option.correct).length;

  if (answerMode === 'single' && correctCount !== 1) {
    throwHttpError(400, 'Для одиночного выбора должен быть ровно один правильный ответ');
  }

  if (answerMode === 'multiple' && correctCount < 1) {
    throwHttpError(400, 'Для множественного выбора нужен хотя бы один правильный ответ');
  }

  return {
    id: question.id || makeId('question'),
    type,
    prompt,
    imageUrl,
    answerMode,
    points,
    options: normalizedOptions,
  };
}

function roomForUser(room, user) {
  const quiz = findQuiz(room.quizId);
  const isOrganizer = room.ownerId === user.id;
  const currentQuestion = quiz.questions[room.currentQuestionIndex] || null;
  const myAnswer = currentQuestion
    ? room.answers.find((answer) => answer.userId === user.id && answer.questionId === currentQuestion.id)
    : null;

  return {
    id: room.id,
    code: room.code,
    status: room.status,
    currentQuestionIndex: room.currentQuestionIndex,
    totalQuestions: quiz.questions.length,
    startedAt: room.startedAt,
    finishedAt: room.finishedAt,
    questionStartedAt: room.questionStartedAt,
    questionEndsAt:
      room.status === 'question' && room.questionStartedAt
        ? new Date(new Date(room.questionStartedAt).getTime() + quiz.questionTimeLimit * 1000).toISOString()
        : null,
    quiz: {
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      category: quiz.category,
      questionTimeLimit: quiz.questionTimeLimit,
      rules: quiz.rules,
    },
    currentQuestion: currentQuestion ? publicQuestion(currentQuestion, isOrganizer) : null,
    participants: room.participants,
    leaderboard: leaderboardForRoom(room),
    answerStats: isOrganizer && currentQuestion ? answerStats(room, currentQuestion) : null,
    myAnswer: myAnswer
      ? {
          selectedOptionIds: myAnswer.selectedOptionIds,
          isCorrect: myAnswer.isCorrect,
          points: myAnswer.points,
          submittedAt: myAnswer.submittedAt,
        }
      : null,
    isOrganizer,
  };
}

function answerStats(room, question) {
  const answers = room.answers.filter((answer) => answer.questionId === question.id);
  const counts = Object.fromEntries(question.options.map((option) => [option.id, 0]));

  for (const answer of answers) {
    for (const optionId of answer.selectedOptionIds) {
      counts[optionId] = (counts[optionId] || 0) + 1;
    }
  }

  return {
    submittedCount: answers.length,
    optionCounts: counts,
  };
}

function leaderboardForRoom(room) {
  const scores = new Map();

  for (const participant of room.participants) {
    scores.set(participant.userId, {
      userId: participant.userId,
      name: participant.name,
      score: 0,
      correctAnswers: 0,
    });
  }

  for (const answer of room.answers) {
    if (!scores.has(answer.userId)) {
      scores.set(answer.userId, {
        userId: answer.userId,
        name: answer.userName || 'Участник',
        score: 0,
        correctAnswers: 0,
      });
    }

    const row = scores.get(answer.userId);
    row.score += Number(answer.points || 0);
    row.correctAnswers += answer.isCorrect ? 1 : 0;
  }

  return [...scores.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function historyItem(room, user) {
  const quiz = findQuiz(room.quizId);
  const leaderboard = leaderboardForRoom(room);
  const myResult = leaderboard.find((row) => row.userId === user.id) || null;

  return {
    code: room.code,
    status: room.status,
    quizTitle: quiz?.title || 'Квиз удалён',
    category: quiz?.category || '',
    startedAt: room.startedAt,
    finishedAt: room.finishedAt,
    participantsCount: room.participants.length,
    winner: leaderboard[0] || null,
    myResult,
  };
}

function quizSummary(quiz) {
  return {
    id: quiz.id,
    title: quiz.title,
    description: quiz.description,
    category: quiz.category,
    questionTimeLimit: quiz.questionTimeLimit,
    questionCount: quiz.questions.length,
    createdAt: quiz.createdAt,
    updatedAt: quiz.updatedAt,
  };
}

function quizForOwner(quiz) {
  return {
    ...quizSummary(quiz),
    rules: quiz.rules,
    questions: quiz.questions.map((question) => publicQuestion(question, true)),
  };
}

function publicQuestion(question, includeCorrect = false) {
  return {
    id: question.id,
    type: question.type,
    prompt: question.prompt,
    imageUrl: question.imageUrl,
    answerMode: question.answerMode,
    points: question.points,
    options: question.options.map((option) => ({
      id: option.id,
      text: option.text,
      ...(includeCorrect ? { correct: option.correct } : {}),
    })),
  };
}

function canViewRoom(room, user) {
  return (
    room.ownerId === user.id ||
    room.participants.some((participant) => participant.userId === user.id)
  );
}

function finishRoom(room) {
  room.status = 'finished';
  room.finishedAt ||= new Date().toISOString();
  room.questionStartedAt = null;
  saveDb();
}

function isQuestionExpired(room, quiz) {
  if (!room.questionStartedAt) {
    return true;
  }

  const started = new Date(room.questionStartedAt).getTime();
  return Date.now() > started + quiz.questionTimeLimit * 1000;
}

function findQuiz(id) {
  return db.quizzes.find((quiz) => quiz.id === id);
}

function findRoom(code) {
  const normalized = String(code || '').toUpperCase();
  return db.rooms.find((room) => room.code === normalized);
}

function getAuth(req) {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const authToken = db.authTokens.find((candidate) => candidate.token === token);

  if (!authToken) {
    return null;
  }

  const user = db.users.find((candidate) => candidate.id === authToken.userId);
  return user ? { token, user } : null;
}

function createAuthToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.authTokens.push({
    token,
    userId,
    createdAt: new Date().toISOString(),
  });
  return token;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha512').toString('hex'),
  };
}

function verifyPassword(password, user) {
  const passwordData = hashPassword(password, user.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(passwordData.hash), Buffer.from(user.passwordHash));
}

function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (db.rooms.some((room) => room.code === code));

  return code;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;

    req.on('data', (chunk) => {
      totalLength += chunk.length;

      if (totalLength > 1024 * 1024) {
        reject(Object.assign(new Error('Тело запроса слишком большое'), { statusCode: 413 }));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');

      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(Object.assign(new Error('Некорректный JSON'), { statusCode: 400 }));
      }
    });

    req.on('error', reject);
  }).catch((error) => {
    throwHttpError(error.statusCode || 400, error.message);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Cache-Control': 'no-store',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  fs.createReadStream(filePath).pipe(res);
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };

  return types[ext] || 'application/octet-stream';
}

function handleWebSocketUpgrade(req, socket) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token') || '';
  const roomCode = String(url.searchParams.get('room') || '').toUpperCase();
  const authToken = db.authTokens.find((candidate) => candidate.token === token);
  const user = authToken ? db.users.find((candidate) => candidate.id === authToken.userId) : null;
  const room = findRoom(roomCode);

  if (!user || !room || !canViewRoom(room, user)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'),
  );

  const client = { socket, user, roomCode: room.code };
  wsClients.add(client);

  socket.on('data', (buffer) => handleWebSocketFrame(client, buffer));
  socket.on('close', () => wsClients.delete(client));
  socket.on('error', () => wsClients.delete(client));

  sendWs(client, {
    type: 'room:update',
    payload: roomForUser(room, user),
  });
}

function handleWebSocketFrame(client, buffer) {
  if (buffer.length < 2) {
    return;
  }

  const opcode = buffer[0] & 0x0f;

  if (opcode === 0x8) {
    wsClients.delete(client);
    client.socket.end();
    return;
  }

  if (opcode === 0x9) {
    sendWsFrame(client.socket, Buffer.alloc(0), 0x0a);
  }
}

function broadcastRoom(roomCode) {
  const room = findRoom(roomCode);

  if (!room) {
    return;
  }

  for (const client of [...wsClients]) {
    if (client.roomCode !== room.code) {
      continue;
    }

    if (client.socket.destroyed) {
      wsClients.delete(client);
      continue;
    }

    sendWs(client, {
      type: 'room:update',
      payload: roomForUser(room, client.user),
    });
  }
}

function sendWs(client, message) {
  sendWsFrame(client.socket, Buffer.from(JSON.stringify(message), 'utf8'), 0x01);
}

function sendWsFrame(socket, payload, opcode) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function arraysEqual(first, second) {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function throwHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

process.on('uncaughtException', (error) => {
  console.error(error);
});
